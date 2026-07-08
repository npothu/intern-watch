"""ATS login + account management.

Login-walled ATSes (Workday above all) require an account before the
application form renders. The user supplies credentials in
`users/<user>_logins.yaml` (GITIGNORED — it holds passwords). For a given apply
URL we pick the matching account (by domain, else a default) and:

  1. if a persisted browser session already carried us past the wall -> done;
  2. else try to SIGN IN with the credentials;
  3. if sign-in fails because no account exists yet -> CREATE one.

Honest limit: Workday account creation usually triggers an email-verification
link (and some tenants gate sign-in behind MFA). Email verification + emailed
OTPs can be auto-resolved via an inbox (see inbox.py); app-authenticator / SMS
MFA can't be completed unattended — those return `needs_verification` /
`blocked_mfa` so the user does it ONCE interactively; the driver then persists
the session for reuse.

Each ATS has its own auth DOM, so flows are per-family. Workday is implemented
here; `ensure_account(page, family, account, inbox)` dispatches and is the
single entry point fillers call. "Continue with Google" SSO is supported
family-agnostically when an account is configured with method "google".
"""

from __future__ import annotations

import logging
import re
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING

import yaml
from pydantic import BaseModel, Field

from .base import ATSFamily

if TYPE_CHECKING:
    from playwright.sync_api import Locator, Page

ROOT = Path(__file__).resolve().parents[2]
log = logging.getLogger(__name__)

PROBE_MS = 1500
NAV_MS = 8000


class LoginAccount(BaseModel):
    """One ATS account. `domain` (optional) restricts it to matching apply URLs;
    accounts without a domain are eligible as the default. `method` "google"
    uses "Continue with Google" SSO instead of an email/password account
    (`email` is then the Google address; `password` may be left blank)."""

    email: str
    password: str = ""
    method: str = "password"            # "password" | "google"
    first_name: str = ""
    last_name: str = ""
    domain: str = ""                    # e.g. "myworkdayjobs.com" or a tenant host
    security_question: str = ""
    security_answer: str = ""


class Logins(BaseModel):
    default: LoginAccount | None = None
    accounts: list[LoginAccount] = Field(default_factory=list)


class AuthStatus(str, Enum):
    authed = "authed"                   # already / now signed in
    created = "created"                 # registered and signed in
    needs_verification = "needs_verification"  # account made; verify email first
    blocked_mfa = "blocked_mfa"         # MFA challenge — do it once interactively
    blocked_captcha = "blocked_captcha"
    no_credentials = "no_credentials"   # no account configured for this URL
    failed = "failed"                   # sign-in and create both failed

    @property
    def past_wall(self) -> bool:
        return self in (AuthStatus.authed, AuthStatus.created)


def load_logins(user: str = "") -> Logins:
    from .profile import detect_user

    user = user or detect_user()
    path = ROOT / "users" / f"{user}_logins.yaml"
    if not path.exists():
        return Logins()
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return Logins.model_validate(data)


def account_for(logins: Logins, url: str) -> LoginAccount | None:
    """Pick the credentials to use for `url`: the most specific domain match,
    else the default, else any domain-less account."""
    host = (url or "").lower()
    domain_matches = [a for a in logins.accounts
                      if a.domain and a.domain.lower() in host]
    if domain_matches:                  # longest domain = most specific
        return max(domain_matches, key=lambda a: len(a.domain))
    if logins.default:
        return logins.default
    generic = [a for a in logins.accounts if not a.domain]
    return generic[0] if generic else None


# ----------------------------------------------------------------- dispatch

def ensure_account(page: "Page", family: ATSFamily,
                   account: LoginAccount | None, inbox=None) -> AuthStatus:
    """Single entry point: get past `family`'s auth wall, creating an account if
    needed. `inbox` (an inbox.Inbox or None) lets us resolve emailed
    verification links / OTP codes. Returns an AuthStatus; never raises."""
    try:
        # "Sign in with Google" is offered by many ATSes and is family-agnostic:
        # try it first whenever the account is configured for Google.
        if account is not None and account.method == "google":
            status = _try_google_sso(page, account)
            if status is not AuthStatus.failed:
                return status
            # fall through to a password flow if Google SSO wasn't available.

        if family is ATSFamily.workday:
            return _ensure_workday(page, account, inbox)
        # Other families rarely wall the application; if one does and we have
        # no implemented flow, surface it as a manual login.
        return AuthStatus.no_credentials if account is None else AuthStatus.failed
    except Exception:
        log.exception("ensure_account(%s) crashed", family)
        return AuthStatus.failed


# ------------------------------------------------------------------ Workday

# Workday auth DOM is data-automation-id driven and fairly stable across tenants.
_WD = {
    "email": "[data-automation-id='email']",
    "password": "[data-automation-id='password']",
    "verify_password": "[data-automation-id='verifyPassword']",
    "sign_in_submit": "[data-automation-id='signInSubmitButton']",
    "create_submit": "[data-automation-id='createAccountSubmitButton']",
    "create_link": "[data-automation-id='createAccountLink']",
    "sign_in_link": "[data-automation-id='signInLink']",
    "agree_checkbox": "[data-automation-id='createAccountCheckbox']",
    "error": "[data-automation-id='errorMessage']",
    "mfa": "[data-automation-id='multiFactor']",
}


def _ensure_workday(page: "Page", account: LoginAccount | None,
                    inbox=None) -> AuthStatus:
    if _wd_captcha(page):
        return AuthStatus.blocked_captcha
    if not _wd_at_wall(page):
        return AuthStatus.authed            # session already carried us through
    if account is None:
        return AuthStatus.no_credentials

    # Try sign-in first (the common case once an account exists).
    status = AuthStatus.failed
    if _present(page, _WD["password"]) and not _present(page, _WD["verify_password"]):
        status = _wd_sign_in(page, account)
    if status is AuthStatus.failed:
        status = _wd_create_account(page, account)

    # A sign-in OTP or a post-create verification email can finish unattended
    # when an inbox is configured.
    if status is AuthStatus.blocked_mfa and inbox is not None:
        status = _resolve_email_otp(page, inbox) or status
    if status is AuthStatus.needs_verification and inbox is not None:
        resolved = _resolve_email_verification(page, inbox)
        if resolved is not None:
            status = resolved
    return status


def _wd_sign_in(page: "Page", account: LoginAccount) -> AuthStatus:
    try:
        page.locator(_WD["email"]).first.fill(account.email, timeout=PROBE_MS)
        page.locator(_WD["password"]).first.fill(account.password, timeout=PROBE_MS)
        _click(page, _WD["sign_in_submit"]) or _click_button(page, "Sign In")
        _settle(page)
    except Exception:
        return AuthStatus.failed
    return _wd_post_auth(page)


def _wd_create_account(page: "Page", account: LoginAccount) -> AuthStatus:
    try:
        # Navigate from sign-in to the create-account form if needed.
        if not _present(page, _WD["verify_password"]):
            _click(page, _WD["create_link"]) or _click_button(page, "Create Account")
            _settle(page)
        if not _present(page, _WD["verify_password"]):
            return AuthStatus.failed         # never reached the create form

        page.locator(_WD["email"]).first.fill(account.email, timeout=PROBE_MS)
        page.locator(_WD["password"]).first.fill(account.password, timeout=PROBE_MS)
        page.locator(_WD["verify_password"]).first.fill(account.password,
                                                        timeout=PROBE_MS)
        # Tick the terms checkbox if the tenant shows one.
        try:
            cb = page.locator(_WD["agree_checkbox"])
            if cb.count() > 0:
                cb.first.check(timeout=PROBE_MS)
        except Exception:
            pass
        _click(page, _WD["create_submit"]) or _click_button(page, "Create Account")
        _settle(page)
    except Exception:
        return AuthStatus.failed

    status = _wd_post_auth(page)
    if status is AuthStatus.authed:
        return AuthStatus.created
    return status


# ----------------------------------------------------------- Google SSO

# "Continue with Google" appears on Workday, Lever, Ashby and others. We never
# automate Google's password screen (Google blocks that and it's ToS-hostile) —
# we rely on a Google session already persisted in the browser profile, so the
# button is one-click. If Google instead demands a password/2FA, we stop and
# ask the user to do the one-time Google login interactively.
_GOOGLE_BTN = (
    "[data-automation-id='googleSignIn']",
    "[data-provider='google']",
    "button[aria-label*='Google' i]",
    "a[href*='accounts.google.com']",
)
_GOOGLE_BTN_TEXT = ("Continue with Google", "Sign in with Google",
                    "Sign up with Google", "Apply with Google", "Google")


def _try_google_sso(page: "Page", account: LoginAccount) -> AuthStatus:
    """Click a Google SSO button and rely on a persisted Google session.
    Returns failed if no Google button is present (so caller can fall back)."""
    if not _wd_at_wall(page) and not _any_google_button(page):
        # Already past the wall and no SSO offered — nothing to do here.
        return AuthStatus.authed if not _wd_at_wall(page) else AuthStatus.failed

    popup = _click_google_button(page)
    target = popup or page
    _settle(target)

    # If Google shows an account chooser, pick the configured address.
    try:
        chooser = target.get_by_text(account.email, exact=False)
        if chooser.count() > 0:
            chooser.first.click(timeout=PROBE_MS)
            _settle(target)
    except Exception:
        pass

    # Google demanding a password / 2FA means no usable session — bail to manual.
    if _google_password_screen(target):
        return AuthStatus.blocked_login
    if _has_text(target, "verification code", "2-step", "two-factor"):
        return AuthStatus.blocked_mfa

    if popup is not None:
        _settle(page)                       # popup closed; main page continues
    return AuthStatus.authed if not _wd_at_wall(page) else AuthStatus.failed


def _any_google_button(page: "Page") -> bool:
    for sel in _GOOGLE_BTN:
        if _present(page, sel):
            return True
    for name in _GOOGLE_BTN_TEXT:
        try:
            if page.get_by_role("button", name=re.compile(name, re.I)).count() > 0:
                return True
        except Exception:
            pass
    return False


def _click_google_button(page: "Page"):
    """Click the Google button; return a popup Page if one opened, else None."""
    def do_click() -> bool:
        for sel in _GOOGLE_BTN:
            if _click(page, sel):
                return True
        for name in _GOOGLE_BTN_TEXT:
            if _click_button(page, name):
                return True
        return False

    try:
        with page.expect_popup(timeout=PROBE_MS) as pinfo:
            if not do_click():
                return None
        return pinfo.value                  # SSO opened in a popup window
    except Exception:
        return None                         # same-tab redirect (already clicked)


def _google_password_screen(page: "Page") -> bool:
    try:
        url = (page.url or "").lower()
    except Exception:
        url = ""
    if "accounts.google.com" in url and _present(page, "input[type='password']"):
        return True
    return _has_text(page, "Enter your password") and "google" in url


# ------------------------------------------------------- inbox resolution

def _resolve_email_verification(page: "Page", inbox) -> AuthStatus | None:
    """Poll the inbox for a verification link, open it, and re-check the wall."""
    from .inbox import poll
    link = poll(lambda: inbox.find_verification_link(
        from_contains="", subject_contains="", link_contains=""))
    if not link:
        return None                         # leave caller's needs_verification
    try:
        page.goto(link, timeout=NAV_MS * 2)
        _settle(page)
    except Exception:
        return None
    return AuthStatus.created if not _wd_at_wall(page) else AuthStatus.needs_verification


def _resolve_email_otp(page: "Page", inbox) -> AuthStatus | None:
    """Poll for an emailed OTP and submit it. Returns authed on success."""
    from .inbox import poll
    code = poll(lambda: inbox.find_otp_code())
    if not code:
        return None
    try:
        otp = page.locator("[data-automation-id='verificationCode'], "
                           "input[autocomplete='one-time-code'], "
                           "input[name*='code' i]")
        if otp.count() == 0:
            return None
        otp.first.fill(code, timeout=PROBE_MS)
        _click_button(page, "Submit") or _click_button(page, "Verify")
        _settle(page)
    except Exception:
        return None
    return AuthStatus.authed if not _wd_at_wall(page) else None


def _wd_post_auth(page: "Page") -> AuthStatus:
    """Classify the state right after a sign-in / create submission."""
    if _wd_captcha(page):
        return AuthStatus.blocked_captcha
    if _present(page, _WD["mfa"]) or _has_text(page, "verification code",
                                               "multi-factor", "one-time passcode"):
        return AuthStatus.blocked_mfa
    if _has_text(page, "verify your email", "check your email",
                 "verification email", "confirm your email"):
        return AuthStatus.needs_verification
    if _present(page, _WD["error"]) or _has_text(page, "incorrect", "already exists",
                                                 "invalid password"):
        return AuthStatus.failed
    if not _wd_at_wall(page):
        return AuthStatus.authed
    return AuthStatus.failed


def _wd_at_wall(page: "Page") -> bool:
    try:
        url = (page.url or "").lower()
    except Exception:
        url = ""
    if "/login" in url or "/signin" in url:
        return True
    for key in ("password", "verify_password", "sign_in_submit",
                "create_submit", "sign_in_link", "create_link"):
        if _present(page, _WD[key]):
            return True
    return False


def _wd_captcha(page: "Page") -> bool:
    for sel in ("iframe[src*='recaptcha']", "iframe[src*='hcaptcha']",
                "[data-automation-id='captcha']", ".g-recaptcha", "#h-captcha"):
        if _present(page, sel):
            return True
    return False


# ----------------------------------------------------------------- DOM helpers

def _present(page: "Page", selector: str) -> bool:
    try:
        return page.locator(selector).count() > 0
    except Exception:
        return False


def _click(page: "Page", selector: str) -> bool:
    try:
        loc = page.locator(selector)
        if loc.count() > 0:
            loc.first.click(timeout=PROBE_MS)
            return True
    except Exception:
        pass
    return False


def _click_button(page: "Page", name: str) -> bool:
    try:
        loc = page.get_by_role("button", name=re.compile(name, re.I))
        if loc.count() > 0:
            loc.first.click(timeout=PROBE_MS)
            return True
    except Exception:
        pass
    return False


def _has_text(page: "Page", *needles: str) -> bool:
    for n in needles:
        try:
            if page.get_by_text(re.compile(re.escape(n), re.I)).count() > 0:
                return True
        except Exception:
            pass
    return False


def _settle(page: "Page") -> None:
    try:
        page.wait_for_load_state("networkidle", timeout=NAV_MS)
    except Exception:
        pass
