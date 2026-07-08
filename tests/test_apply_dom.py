"""DOM-heuristic tests: visible-captcha detection, Apply-advance, incidental
field exclusion. Regression coverage for the live-audit bug fixes."""

from __future__ import annotations

import pytest

from src.apply.dom import advance_to_application_form, has_visible_captcha
from src.apply.fillers.agent import _extract_fields


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


def test_visible_captcha_detected(page):
    page.set_content("<div class='g-recaptcha' style='width:120px;height:120px'>x</div>")
    assert has_visible_captcha(page) is True


def test_invisible_captcha_ignored(page):
    page.set_content("<div class='g-recaptcha' style='display:none'></div>"
                     "<iframe src='https://www.google.com/recaptcha/api2/anchor' "
                     "style='display:none'></iframe>")
    assert has_visible_captcha(page) is False


def test_no_captcha(page):
    page.set_content("<input id='email'>")
    assert has_visible_captcha(page) is False


def test_advance_single_step_apply(page):
    page.set_content("<button onclick=\"document.body.innerHTML="
                     "'<input id=email>'\">Apply</button>")
    assert advance_to_application_form(page) is True
    assert page.locator("#email").count() == 1


def test_advance_multistep_apply_manually(page):
    page.set_content(
        "<button onclick=\"document.getElementById('m').style.display='block'\">"
        "Apply</button>"
        "<div id='m' style='display:none'>"
        "<button onclick=\"document.body.innerHTML='<input type=password>'\">"
        "Apply Manually</button></div>")
    assert advance_to_application_form(page) is True
    assert page.locator("input[type='password']").count() == 1


def test_advance_never_clicks_submit(page):
    page.set_content("<button onclick=\"document.body.innerHTML='gone'\">"
                     "Submit Application</button>")
    assert advance_to_application_form(page) is False
    assert page.get_by_role("button", name="Submit Application").count() == 1


def test_extract_excludes_incidental_inputs(page):
    page.set_content(
        "<input id='searchBox' placeholder='Search jobs'>"
        "<input id='saveJob-123'>"
        "<input id='PhenomChatbotFooterInput'>"
        "<input id='notifiedEmail'>"
        "<input type='password' id='pw'>"
        "<input id='firstName' name='firstName'>")
    refs = {f["ref"] for f in _extract_fields(page)}
    assert "#firstName" in refs
    assert "#searchBox" not in refs
    assert "#saveJob-123" not in refs
    assert "#PhenomChatbotFooterInput" not in refs
    assert "#notifiedEmail" not in refs
    assert "#pw" not in refs
