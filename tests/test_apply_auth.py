"""Auth / login-account tests: pure credential selection + Workday browser flow."""

from __future__ import annotations

import pytest

from src.apply.auth import (AuthStatus, LoginAccount, Logins, account_for,
                            ensure_account, load_logins)
from src.apply.base import ATSFamily


def test_load_logins_missing_returns_empty(tmp_path, monkeypatch):
    import src.apply.auth as auth
    monkeypatch.setattr(auth, "ROOT", tmp_path)
    logins = load_logins("nobody")
    assert logins.default is None and logins.accounts == []


def test_account_for_prefers_domain_then_default():
    logins = Logins(
        default=LoginAccount(email="def@x.com", password="p"),
        accounts=[
            LoginAccount(email="nv@x.com", password="p", domain="nvidia.wd5.myworkdayjobs.com"),
            LoginAccount(email="generic@x.com", password="p"),
        ],
    )
    assert account_for(logins, "https://nvidia.wd5.myworkdayjobs.com/job/1").email == "nv@x.com"
    assert account_for(logins, "https://acme.myworkdayjobs.com/job/2").email == "def@x.com"


def test_account_for_falls_back_to_generic_when_no_default():
    logins = Logins(accounts=[LoginAccount(email="g@x.com", password="p")])
    assert account_for(logins, "https://acme.myworkdayjobs.com/x").email == "g@x.com"


def test_account_for_none_when_empty():
    assert account_for(Logins(), "https://acme.myworkdayjobs.com/x") is None


def test_ensure_account_non_workday_no_creds():
    assert ensure_account(None, ATSFamily.lever, None) is AuthStatus.no_credentials


ACCT = LoginAccount(email="example@x.com", password="pw12345",
                    first_name="Alex", last_name="Example")

SIGNIN_OK = """
<input data-automation-id="email">
<input data-automation-id="password" type="password">
<button data-automation-id="signInSubmitButton"
  onclick="document.body.innerHTML='<input data-automation-id=&quot;legalNameSection_firstName&quot;>'">
  Sign In</button>
"""

CREATE_VERIFY = """
<input data-automation-id="email">
<input data-automation-id="password" type="password">
<input data-automation-id="verifyPassword" type="password">
<button data-automation-id="createAccountSubmitButton"
  onclick="document.body.innerHTML='<div>Please verify your email to continue</div>'">
  Create Account</button>
"""

CAPTCHA_WALL = """
<input data-automation-id="password" type="password">
<div class="g-recaptcha"></div>
"""

ALREADY_IN = '<input data-automation-id="legalNameSection_firstName">'


@pytest.fixture
def page():
    pw = pytest.importorskip("playwright.sync_api")
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            pg = browser.new_page()
            yield pg
            browser.close()
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


def test_workday_sign_in_succeeds(page):
    page.set_content(SIGNIN_OK)
    assert ensure_account(page, ATSFamily.workday, ACCT) is AuthStatus.authed


def test_workday_create_account_needs_verification(page):
    page.set_content(CREATE_VERIFY)
    assert ensure_account(page, ATSFamily.workday, ACCT) is AuthStatus.needs_verification


def test_workday_captcha_blocks(page):
    page.set_content(CAPTCHA_WALL)
    assert ensure_account(page, ATSFamily.workday, ACCT) is AuthStatus.blocked_captcha


def test_workday_no_credentials_at_wall(page):
    page.set_content(SIGNIN_OK)
    assert ensure_account(page, ATSFamily.workday, None) is AuthStatus.no_credentials


def test_workday_already_authed(page):
    page.set_content(ALREADY_IN)
    assert ensure_account(page, ATSFamily.workday, ACCT) is AuthStatus.authed


class FakeInbox:
    def __init__(self, link=None, code=None):
        self._link, self._code = link, code
    def find_verification_link(self, **kw):
        return self._link
    def find_otp_code(self, **kw):
        return self._code


def test_workday_create_then_email_verification_completes(page):
    page.set_content(CREATE_VERIFY)
    verified = "data:text/html,<input data-automation-id='legalNameSection_firstName'>"
    inbox = FakeInbox(link=verified)
    status = ensure_account(page, ATSFamily.workday, ACCT, inbox=inbox)
    assert status is AuthStatus.created
    assert "legalNameSection_firstName" in page.content()


GOOGLE_ACCT = LoginAccount(email="example@gmail.com", method="google")

GOOGLE_OK = """
<input data-automation-id="password" type="password">
<button data-provider="google"
  onclick="document.body.innerHTML='<input data-automation-id=&quot;legalNameSection_firstName&quot;>'">
  Continue with Google</button>
"""


def test_google_sso_uses_persisted_session(page):
    page.set_content(GOOGLE_OK)
    assert ensure_account(page, ATSFamily.workday, GOOGLE_ACCT) is AuthStatus.authed


def test_google_method_already_authed_no_button(page):
    page.set_content(ALREADY_IN)
    assert ensure_account(page, ATSFamily.workday, GOOGLE_ACCT) is AuthStatus.authed