"""Workday application filler.

Workday is the hard case: forms are multi-step *and* almost always sit behind a
sign-in / create-account wall. A Workday apply URL is usually the job POSTING,
so we first click Apply (-> "Apply Manually") to reach the wall, then sign in or
register via auth.ensure_account (which can resolve emailed verification). When
past the wall, Workday exposes fields via `data-automation-id` attributes far
more reliably than name/id/label, so the filler keys off those first. Per the
Filler contract this returns a `blocked_*`/`error` status rather than raising
whenever the form cannot complete unattended.
"""

from __future__ import annotations

import datetime as dt
import logging
from pathlib import Path
from typing import TYPE_CHECKING

from ..base import ApplyContext, ApplyMode, ApplyResult, ApplyStatus, ATSFamily
from ..dom import advance_to_application_form, has_visible_captcha

if TYPE_CHECKING:
    from playwright.sync_api import Locator, Page

log = logging.getLogger(__name__)

# Short timeout (ms) for "is this element present?" probes — we never want to
# block the whole run waiting on something that isn't there.
PROBE_MS = 1500
# Slightly longer for the post-submit confirmation, which can lag a redirect.
CONFIRM_MS = 8000


class WorkdayFiller:
    """Drive a Workday application form (post-login) or report the auth wall."""

    family: ATSFamily = ATSFamily.workday

    # ----------------------------------------------------------------- public
    def apply(self, page: Page, ctx: ApplyContext) -> ApplyResult:
        try:
            if ctx.mode is ApplyMode.submit and self._is_captcha(page):
                return self._blocked(
                    ApplyStatus.blocked_captcha, page,
                    "CAPTCHA detected on Workday page — cannot proceed unattended.")

            # A Workday URL is usually the job POSTING, not the form. Gate the
            # advance on the *actual* auth form / application form — NOT on
            # _is_login_wall, which also fires on the posting page's header
            # "Sign In" link and would wrongly skip the Apply click.
            if (not self._is_application_form(page)
                    and not self._has_auth_form(page)
                    and advance_to_application_form(page)):
                log.info("workday: advanced past posting via Apply for %s",
                         ctx.dedup_key)
                try:
                    page.wait_for_selector(
                        "[data-automation-id='password'], "
                        "[data-automation-id='email'], "
                        "[data-automation-id='legalNameSection_firstName'], "
                        "input[type='password']", timeout=12000)
                except Exception:
                    pass

            # A real sign-in / create-account FORM (not just a header link) ->
            # authenticate or register.
            if self._has_auth_form(page) or self._is_login_wall(page):
                auth = self._handle_wall(page, ctx)
                if auth is not None:        # auth produced a terminal result
                    return auth

            if not self._is_application_form(page):
                return self._blocked(
                    ApplyStatus.unsupported, page,
                    "No recognizable Workday application form on the page.")

            filled, unfilled = self._fill_fields(page, ctx)

            if ctx.mode is ApplyMode.autofill:
                shot = self._screenshot(page, ctx)
                return ApplyResult(
                    status=ApplyStatus.filled_paused,
                    family=self.family,
                    message="Filled Workday form; paused before submit.",
                    final_url=page.url,
                    filled_fields=filled,
                    unfilled_fields=unfilled,
                    screenshot_path=shot,
                )

            # submit mode: advance through Next/Submit steps to a confirmation.
            return self._advance_to_submit(page, ctx, filled, unfilled)

        except Exception as exc:  # never raise out of a filler
            log.exception("WorkdayFiller failed for %s", ctx.dedup_key)
            return ApplyResult(
                status=ApplyStatus.error,
                family=self.family,
                message=f"Workday filler error: {exc!r}",
                final_url=_safe_url(page),
            )

    # ------------------------------------------------------------------- auth
    def _handle_wall(self, page: Page, ctx: ApplyContext) -> ApplyResult | None:
        """Try to sign in (or register) using ctx.account. Returns a terminal
        ApplyResult when we cannot proceed, or None once we are past the wall
        (so apply() continues into form-filling)."""
        from ..auth import AuthStatus, ensure_account

        status = ensure_account(page, self.family, ctx.account, inbox=ctx.inbox)
        log.info("workday auth for %s -> %s", ctx.dedup_key, status.value)

        if status.past_wall:
            return None                     # signed in / created — carry on
        msgs = {
            AuthStatus.no_credentials:
                "Workday wall detected and no login configured. Add credentials "
                f"to users/{ctx.user}_logins.yaml, or log in once interactively "
                "(the session is then reused).",
            AuthStatus.needs_verification:
                "Created a Workday account — verify the confirmation email once, "
                "then re-run (the session will be reused).",
            AuthStatus.blocked_mfa:
                "Workday requires MFA. Complete it once interactively; the "
                "session will be reused on later runs.",
            AuthStatus.blocked_captcha:
                "CAPTCHA on the Workday sign-in — cannot proceed unattended.",
            AuthStatus.blocked_login:
                "Google sign-in asked for a password. Complete it once "
                "interactively; the session will be reused on later runs.",
            AuthStatus.failed:
                "Could not sign in or create a Workday account automatically. "
                "Log in once interactively; the session will be reused.",
        }
        st = (ApplyStatus.blocked_captcha if status is AuthStatus.blocked_captcha
              else ApplyStatus.blocked_login)
        return self._blocked(st, page, msgs.get(status, "Workday auth failed."))

    def _has_auth_form(self, page: Page) -> bool:
        """A real sign-in / create-account FORM is on the page — distinct from a
        header 'Sign In' link on a job posting (which _is_login_wall also flags)."""
        for sel in ("input[type='password']",
                    "[data-automation-id='password']",
                    "[data-automation-id='verifyPassword']",
                    "[data-automation-id='signInSubmitButton']",
                    "[data-automation-id='createAccountSubmitButton']"):
            if self._present(page, sel):
                return True
        return False

    # --------------------------------------------------------------- wall detect
    def _is_login_wall(self, page: Page) -> bool:
        """A sign-in / create-account wall blocks the application form."""
        try:
            url = (page.url or "").lower()
        except Exception:
            url = ""
        if "/login" in url or "/signin" in url:
            return True

        # data-automation-id hooks Workday uses for the auth gate.
        for aid in ("signInLink", "createAccountLink", "signInSubmitButton",
                    "createAccountSubmitButton", "verifyPassword"):
            if self._present(page, f"[data-automation-id='{aid}']"):
                return True

        # A password field present means we have not authenticated yet.
        if self._present(page, "input[type='password']"):
            return True

        # Text buttons as a last resort (only if no application form is shown).
        if not self._is_application_form(page):
            for name in ("Sign In", "Create Account"):
                if self._present_button(page, name):
                    return True
        return False

    def _is_captcha(self, page: Page) -> bool:
        # Only a *visible* widget blocks — an invisible/passive captcha that
        # auto-passes must not stop a fillable form (see src/apply/dom.py).
        return has_visible_captcha(page)

    def _is_application_form(self, page: Page) -> bool:
        """Heuristic: at least one known application field is present."""
        for aid in ("legalNameSection_firstName", "email", "phone-number",
                    "fileUploadField"):
            if self._present(page, f"[data-automation-id='{aid}']"):
                return True
        return False

    # ------------------------------------------------------------------- fill
    def _fill_fields(
        self, page: Page, ctx: ApplyContext
    ) -> tuple[list[str], list[str]]:
        profile = ctx.profile
        filled: list[str] = []
        unfilled: list[str] = []

        # (logical name, list of data-automation-id candidates, label regex, value)
        text_fields = [
            ("first_name",
             ["legalNameSection_firstName", "firstName", "first-name"],
             r"first name", profile.first_name),
            ("last_name",
             ["legalNameSection_lastName", "lastName", "last-name"],
             r"last name", profile.last_name),
            ("email",
             ["email", "emailAddress", "email-address"],
             r"email", profile.email),
            ("phone",
             ["phone-number", "phoneNumber", "phone"],
             r"phone", profile.phone),
        ]

        for name, aids, label_rx, value in text_fields:
            if not value:
                unfilled.append(name)
                continue
            loc = self._find_input(page, aids, label_rx)
            if loc is None:
                unfilled.append(name)
                continue
            try:
                loc.fill(value, timeout=PROBE_MS)
                filled.append(name)
            except Exception:
                unfilled.append(name)

        # Resume upload.
        if self._attach_resume(page, ctx.resume_path):
            filled.append("resume")
        else:
            unfilled.append("resume")

        return filled, unfilled

    def _attach_resume(self, page: Page, resume_path: Path) -> bool:
        if not resume_path or not Path(resume_path).exists():
            return False
        loc = self._find_input(
            page,
            ["fileUploadField", "file-upload-input-ref", "resume"],
            r"resume|cv",
            input_type="file",
        )
        if loc is None:
            return False
        try:
            loc.set_input_files(str(resume_path), timeout=PROBE_MS)
            return True
        except Exception:
            return False

    # ----------------------------------------------------------------- submit
    def _advance_to_submit(
        self,
        page: Page,
        ctx: ApplyContext,
        filled: list[str],
        unfilled: list[str],
    ) -> ApplyResult:
        """Click Next/Submit until a confirmation appears (submit mode only).

        Two safety guarantees mirror the agent path:
        - Fail-closed submit gate: before clicking the FINAL submit control, and
          only when ctx.submit_gate is on, scrape the current step for unfilled
          REQUIRED fields; if any, refuse with blocked_incomplete instead of
          submitting. Next/Continue steps are not gated (intermediate).
        - submit_attempt: the moment the final submit is clicked, build the
          attempt record so the queue writes a permanent ledger entry — whatever
          the confirmation check then decides — and this job is never
          re-submitted on a later drain even on a false-negative confirmation.
        """
        max_steps = 8
        for _ in range(max_steps):
            # A later step can re-present an auth/captcha wall.
            if self._is_captcha(page):
                return self._blocked(
                    ApplyStatus.blocked_captcha, page,
                    "CAPTCHA appeared mid-flow on Workday.",
                    filled, unfilled)
            if self._has_auth_form(page):
                return self._blocked(
                    ApplyStatus.blocked_login, page,
                    "Auth wall re-appeared mid-flow on Workday.",
                    filled, unfilled)

            if self._confirmation_present(page):
                return ApplyResult(
                    status=ApplyStatus.submitted,
                    family=self.family,
                    message="Workday application submitted (confirmation seen).",
                    final_url=page.url,
                    filled_fields=filled,
                    unfilled_fields=unfilled,
                )

            btn, is_final = self._submit_button(page)
            if btn is None:
                break

            if is_final:
                # Fail-closed gate at the final submit boundary only.
                blocking = self._gate_block_labels(page, ctx.submit_gate)
                if blocking:
                    return self._blocked(
                        ApplyStatus.blocked_incomplete, page,
                        "required fields unfilled; not submitting: "
                        + ", ".join(blocking),
                        filled, sorted(set(blocking)))
                # The click is about to happen: record the attempt NOW so the
                # ledger guard fires even if confirmation detection then fails.
                attempt = self._submit_attempt(page)
                try:
                    btn.click(timeout=PROBE_MS)
                    page.wait_for_load_state("networkidle", timeout=CONFIRM_MS)
                except Exception:
                    pass
                if self._confirmation_present(page):
                    attempt["confirmed"] = True
                    attempt["final_url"] = _safe_url(page)
                    return ApplyResult(
                        status=ApplyStatus.submitted,
                        family=self.family,
                        message="Workday application submitted (confirmation seen).",
                        final_url=page.url,
                        filled_fields=filled,
                        unfilled_fields=unfilled,
                        submit_attempt=attempt,
                    )
                if self._is_captcha(page):
                    return self._blocked_attempt(
                        ApplyStatus.blocked_captcha, page,
                        "CAPTCHA appeared after Workday submit — outcome uncertain.",
                        filled, unfilled, attempt)
                return self._blocked_attempt(
                    ApplyStatus.error, page,
                    "Clicked Workday submit but saw no confirmation.",
                    filled, unfilled, attempt)

            # Intermediate Next/Continue step — not gated, no attempt recorded.
            try:
                btn.click(timeout=PROBE_MS)
                page.wait_for_load_state("networkidle", timeout=CONFIRM_MS)
            except Exception:
                break

        if self._confirmation_present(page):
            return ApplyResult(
                status=ApplyStatus.submitted,
                family=self.family,
                message="Workday application submitted (confirmation seen).",
                final_url=page.url,
                filled_fields=filled,
                unfilled_fields=unfilled,
            )

        return self._blocked(
            ApplyStatus.error, page,
            "Could not reach a Workday submission confirmation.",
            filled, unfilled)

    # Data-automation-ids and role names that denote the FINAL submit control
    # (Workday's last wizard step) rather than an intermediate Next/Continue.
    _FINAL_AIDS = ("submitButton", "wd-CompositeHeader-submit")
    _FINAL_NAMES = ("Submit", "Review and Submit")
    _NEXT_AIDS = ("bottom-navigation-next-button", "next")
    _NEXT_NAMES = ("Next", "Continue")

    def _submit_button(self, page: Page) -> tuple[Locator | None, bool]:
        """The next control to click and whether it is the FINAL submit.

        Prefer a Next/Continue control (advance the wizard) over a Submit one so
        we only reach — and gate — the terminal submit once no further steps
        remain. Returns (locator, is_final)."""
        for aid in self._NEXT_AIDS:
            loc = page.locator(f"[data-automation-id='{aid}']")
            if self._visible(loc):
                return loc.first, False
        for name in self._NEXT_NAMES:
            loc = page.get_by_role("button", name=name)
            if self._visible(loc):
                return loc.first, False
        for aid in self._FINAL_AIDS:
            loc = page.locator(f"[data-automation-id='{aid}']")
            if self._visible(loc):
                return loc.first, True
        for name in self._FINAL_NAMES:
            loc = page.get_by_role("button", name=name)
            if self._visible(loc):
                return loc.first, True
        return None, False

    # ------------------------------------------------------------ submit gate
    def _gate_block_labels(self, page: Page, enabled: bool) -> list[str]:
        """Labels of unfilled REQUIRED fields on the current step that must block
        a final submit. Empty when the gate is off or nothing required is blank
        (submit may proceed). Detected-required is a lower bound (an undetected
        required field is not caught here), so this is fail-closed only for what
        Workday marks required — asterisks / aria-required / a required flag on
        the automation-id widget."""
        if not enabled:
            return []
        labels: list[str] = []
        seen: set[str] = set()
        for req in self._required_widgets(page):
            if self._widget_filled(req):
                continue
            label = self._widget_label(page, req)
            if label and label not in seen:
                seen.add(label)
                labels.append(label)
        return labels

    def _required_widgets(self, page: Page) -> list[Locator]:
        """Every visible required INPUT/SELECT/TEXTAREA on the current step.
        Workday marks required with aria-required, a required attribute, or a
        sibling asterisk (data-automation-id='required' / a * abbr)."""
        out: list[Locator] = []
        selectors = (
            "input[aria-required='true']",
            "select[aria-required='true']",
            "textarea[aria-required='true']",
            "input[required]",
            "select[required]",
            "textarea[required]",
            # Workday wraps a required field group and flags it with a nested
            # asterisk marker; the control lives under the same automation group.
            "[data-automation-id='required'] input, [data-automation-id='required'] select",
            "[data-required-error] input, [data-required-error] select",
        )
        for sel in selectors:
            try:
                loc = page.locator(sel)
                for i in range(min(loc.count(), 30)):
                    el = loc.nth(i)
                    try:
                        if el.is_visible():
                            out.append(el)
                    except Exception:
                        continue
            except Exception:
                continue
        return out

    def _widget_filled(self, loc: Locator) -> bool:
        try:
            val = loc.input_value(timeout=PROBE_MS)
        except Exception:
            # Not a plain input (e.g. a Workday button-group / listbox). Treat as
            # filled only if it carries a value/aria marker; otherwise fail
            # closed by reporting it as unfilled.
            try:
                aria = loc.get_attribute("aria-label") or ""
                checked = loc.get_attribute("aria-checked")
                return checked == "true" or bool(aria and "select" not in aria.lower())
            except Exception:
                return False
        return bool(val and val.strip())

    def _widget_label(self, page: Page, loc: Locator) -> str:
        """A human-readable label for a required widget, best-effort."""
        for attr in ("aria-label", "data-automation-id", "name", "id"):
            try:
                v = loc.get_attribute(attr)
            except Exception:
                v = None
            if v and v.strip():
                return v.strip()
        return "required field"

    def _submit_attempt(self, page: Page) -> dict:
        """The attempt record persisted the moment a final submit is clicked, so
        the queue writes a permanent ledger entry and never re-submits this job.
        Same shape the agent path uses (queue keys off `.submit_attempt`)."""
        return {
            "on": dt.datetime.now(dt.UTC).date().isoformat(),
            "family": self.family.value,
            "final_url": _safe_url(page),
            # Built BEFORE the click, so this starts False; the submitted
            # branch upgrades it to True once a confirmation is observed.
            "confirmed": False,
            "signal": "workday",
            "screenshot": None,
        }

    def _confirmation_present(self, page: Page) -> bool:
        for sel in (
            "[data-automation-id='confirmationPage']",
            "[data-automation-id='applicationSubmitted']",
        ):
            if self._present(page, sel):
                return True
        for text in ("application has been submitted",
                     "Thank you for applying",
                     "successfully submitted",
                     "We have received your application"):
            try:
                if page.get_by_text(text, exact=False).count() > 0:
                    return True
            except Exception:
                pass
        return False

    # --------------------------------------------------------------- locating
    def _find_input(
        self,
        page: Page,
        aids: list[str],
        label_rx: str,
        input_type: str | None = None,
    ) -> Locator | None:
        for aid in aids:
            loc = page.locator(f"[data-automation-id='{aid}']")
            if self._visible(loc) or (input_type == "file" and loc.count() > 0):
                return loc.first
        # Label fallback.
        try:
            import re

            loc = page.get_by_label(re.compile(label_rx, re.I))
            if loc.count() > 0:
                return loc.first
        except Exception:
            pass
        return None

    # ----------------------------------------------------------------- probes
    def _present(self, page: Page, selector: str) -> bool:
        try:
            return page.locator(selector).count() > 0
        except Exception:
            return False

    def _present_button(self, page: Page, name: str) -> bool:
        try:
            return page.get_by_role("button", name=name).count() > 0
        except Exception:
            return False

    def _visible(self, loc: Locator) -> bool:
        try:
            return loc.count() > 0 and loc.first.is_visible()
        except Exception:
            return False

    # ----------------------------------------------------------------- helpers
    def _screenshot(self, page: Page, ctx: ApplyContext) -> Path | None:
        out_dir = ctx.artifacts_dir
        if out_dir is None:
            return None
        try:
            out_dir = Path(out_dir)
            out_dir.mkdir(parents=True, exist_ok=True)
            safe = (ctx.dedup_key or "workday").replace(":", "_").replace("/", "_")
            shot = out_dir / f"{safe}_workday.png"
            page.screenshot(path=str(shot), full_page=True)
            return shot
        except Exception:
            log.warning("workday screenshot failed", exc_info=True)
            return None

    def _blocked(
        self,
        status: ApplyStatus,
        page: Page,
        message: str,
        filled: list[str] | None = None,
        unfilled: list[str] | None = None,
    ) -> ApplyResult:
        return ApplyResult(
            status=status,
            family=self.family,
            message=message,
            final_url=_safe_url(page),
            filled_fields=filled or [],
            unfilled_fields=unfilled or [],
        )

    def _blocked_attempt(
        self,
        status: ApplyStatus,
        page: Page,
        message: str,
        filled: list[str] | None,
        unfilled: list[str] | None,
        attempt: dict,
    ) -> ApplyResult:
        """A blocked/error result that still carries a submit_attempt — used
        after the final submit was clicked but confirmation was not observed, so
        the ledger guard still fires and blocks any re-submit."""
        res = self._blocked(status, page, message, filled, unfilled)
        res.submit_attempt = attempt
        return res


def _safe_url(page: Page) -> str:
    try:
        return page.url or ""
    except Exception:
        return ""
