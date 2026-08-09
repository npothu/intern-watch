"""Shared DOM heuristics used across fillers.

Two lessons from auditing real ATS pages:

* Captcha detection must key off a *visible* widget, not a substring. Ashby (and
  many sites) embed an invisible reCAPTCHA that auto-passes and only challenges
  on submit — matching the word "captcha" in the page HTML falsely blocks a
  perfectly fillable form. `has_visible_captcha` only fires on a rendered widget.

* The apply URL is frequently a job-*posting* page, not the application form
  (Workday, Phenom/ABB, Tesla). `advance_to_application_form` clicks an
  Apply-style button to reach the actual form. It is deliberately conservative:
  it only matches labels starting with "Apply" (so it never clicks
  "Submit Application") and is meant to be called only when no form is present.
"""

from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from playwright.sync_api import Page

log = logging.getLogger(__name__)

PROBE_MS = 1500
SETTLE_MS = 6000

# Rendered captcha widgets. We require visibility, so an invisible/badge-only
# reCAPTCHA (the common passive case) does not count as a block.
_CAPTCHA_WIDGETS = (
    "iframe[src*='recaptcha']",
    "iframe[src*='hcaptcha']",
    "iframe[src*='challenges.cloudflare.com']",   # Cloudflare Turnstile
    "iframe[title*='challenge' i]",
    ".g-recaptcha",
    ".h-captcha",
    ".cf-turnstile",
)

# Buttons/links that move a posting toward its form, in PREFERENCE order. All
# anchored to the start so "Submit Application" / "Submit" never match. Workday
# is two-step: "Apply" opens a menu, then "Apply Manually" reaches the wall —
# so "apply manually" is preferred over a bare "apply" (which would re-open it).
_FORM_STEP_RES = (
    re.compile(r"^\s*apply manually\b", re.I),
    re.compile(r"^\s*apply\b", re.I),
    re.compile(r"^\s*start application\b", re.I),
    re.compile(r"^\s*i'?m interested\b", re.I),
)


def has_visible_captcha(page: Page) -> bool:
    for sel in _CAPTCHA_WIDGETS:
        try:
            for el in page.query_selector_all(sel):
                try:
                    if el.is_visible():
                        return True
                except Exception:
                    continue
        except Exception:
            continue
    return False


def _settle(page: Page) -> None:
    try:
        page.wait_for_load_state("networkidle", timeout=SETTLE_MS)
    except Exception:
        pass


def _click_first(page: Page, rx: re.Pattern) -> bool:
    for role in ("button", "link", "menuitem"):
        try:
            loc = page.get_by_role(role, name=rx)
            n = loc.count()
        except Exception:
            continue
        for i in range(min(n, 4)):
            try:
                el = loc.nth(i)
                if el.is_visible():
                    el.click(timeout=PROBE_MS)
                    _settle(page)
                    return True
            except Exception:
                continue
    return False


def advance_to_application_form(page: Page, max_steps: int = 3) -> bool:
    """Click Apply-style controls to move from a posting to its form, following
    multi-step menus (e.g. Workday Apply -> Apply Manually). Returns True if
    anything was clicked. Never clicks a submit button."""
    clicked = False
    for _ in range(max_steps):
        progressed = False
        for rx in _FORM_STEP_RES:           # preference order
            if _click_first(page, rx):
                clicked = progressed = True
                break
        if not progressed:
            break
    return clicked
