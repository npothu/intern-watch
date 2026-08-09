"""WorkdayFiller tests: post-login fill (fixture) + auth-wall detection (inline)."""

from __future__ import annotations

from pathlib import Path

import pytest

from src.apply.base import ApplyContext, ApplyMode, ApplyStatus, ATSFamily
from src.apply.fillers.workday import WorkdayFiller

FIXTURE_URL = (Path(__file__).parent / "fixtures" / "apply"
               / "workday_form.html").resolve().as_uri()


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


def _ctx(mode, tmp_path, account=None) -> ApplyContext:
    from src.apply.profile import load_profile
    r = tmp_path / "example_resume.docx"
    r.write_bytes(b"PK\x03\x04 dummy")
    return ApplyContext(job={"key": "wd", "company": "Acme"},
                        profile=load_profile(
                            path=Path(__file__).resolve().parents[1]
                            / "users" / "apply.example.yaml"),
                        resume_path=r, mode=mode,
                        final_url="https://x", family=ATSFamily.workday,
                        artifacts_dir=tmp_path, account=account)


def test_family_attribute():
    assert WorkdayFiller().family is ATSFamily.workday


def test_autofill_fills_form_and_attaches_resume(page, tmp_path):
    from src.apply.profile import load_profile
    page.goto(FIXTURE_URL)
    prof = load_profile(path=Path(__file__).resolve().parents[1] / "users" / "apply.example.yaml")
    res = WorkdayFiller().apply(page, _ctx(ApplyMode.autofill, tmp_path))
    assert res.status is ApplyStatus.filled_paused
    assert page.input_value("[data-automation-id='legalNameSection_firstName']") == prof.first_name
    assert page.input_value("[data-automation-id='email']") == prof.email
    assert "resume" in res.filled_fields


def test_login_wall_returns_blocked_login(page, tmp_path):
    page.set_content(
        "<input data-automation-id='password' type='password'>"
        "<button data-automation-id='signInSubmitButton'>Sign In</button>")
    res = WorkdayFiller().apply(page, _ctx(ApplyMode.autofill, tmp_path, account=None))
    assert res.status is ApplyStatus.blocked_login


def test_no_form_returns_unsupported(page, tmp_path):
    page.set_content("<div>Just a job description, no form, no apply button.</div>")
    res = WorkdayFiller().apply(page, _ctx(ApplyMode.autofill, tmp_path))
    assert res.status is ApplyStatus.unsupported


# --- G1: submit gate at the final submit boundary -------------------------

# A single-step post-login form whose known fields are all present (so the
# filler fills them and reaches the final Submit), PLUS an extra required field
# it does not know how to fill. With the gate on, that blank required field must
# refuse the final submit; with the gate off, it clicks through.
_GATED_FORM = (
    "<label>First Name</label>"
    "<input data-automation-id='legalNameSection_firstName' type='text'>"
    "<label>Last Name</label>"
    "<input data-automation-id='legalNameSection_lastName' type='text'>"
    "<label>Email</label><input data-automation-id='email' type='email'>"
    "<label>Phone</label><input data-automation-id='phone-number' type='tel'>"
    "<label>Resume</label><input data-automation-id='fileUploadField' type='file'>"
    # An unmapped REQUIRED field the filler never fills.
    "<label>Cover Letter</label>"
    "<input aria-required='true' aria-label='Cover Letter' type='text'>"
    "<button data-automation-id='submitButton' type='button'>Submit</button>"
)


def test_submit_gate_blocks_when_required_field_unfilled(page, tmp_path):
    page.set_content(_GATED_FORM)
    ctx = _ctx(ApplyMode.submit, tmp_path)
    assert ctx.submit_gate is True
    res = WorkdayFiller().apply(page, ctx)
    assert res.status is ApplyStatus.blocked_incomplete
    assert "Cover Letter" in res.message
    # Fail-closed: it must NOT have clicked, so no attempt was recorded.
    assert res.submit_attempt is None


def test_submit_gate_off_does_not_block_on_required(page, tmp_path):
    page.set_content(_GATED_FORM)
    ctx = _ctx(ApplyMode.submit, tmp_path)
    ctx.submit_gate = False
    res = WorkdayFiller().apply(page, ctx)
    # Gate off: it clicks Submit (no confirmation in the fixture -> error), but
    # crucially it did NOT refuse for the unfilled required field.
    assert res.status is not ApplyStatus.blocked_incomplete
    # And having clicked, it recorded a submit attempt (see G2 below).
    assert res.submit_attempt is not None


# --- G2: submit_attempt recorded the moment the final submit is clicked -----

def test_submit_attempt_recorded_without_confirmation(page, tmp_path):
    # A fully-fillable form with a final Submit but NO confirmation page: the
    # click lands but confirmation detection returns false. The result must
    # still carry submit_attempt so the queue writes a permanent ledger entry.
    page.set_content(
        "<label>First Name</label>"
        "<input data-automation-id='legalNameSection_firstName' type='text'>"
        "<label>Last Name</label>"
        "<input data-automation-id='legalNameSection_lastName' type='text'>"
        "<label>Email</label><input data-automation-id='email' type='email'>"
        "<label>Phone</label><input data-automation-id='phone-number' type='tel'>"
        "<label>Resume</label><input data-automation-id='fileUploadField' type='file'>"
        "<button data-automation-id='submitButton' type='button'>Submit</button>")
    res = WorkdayFiller().apply(page, _ctx(ApplyMode.submit, tmp_path))
    assert res.status is ApplyStatus.error       # no confirmation observed
    assert res.submit_attempt is not None
    assert res.submit_attempt["family"] == "workday"
    assert res.submit_attempt["confirmed"] is False


def test_submit_attempt_recorded_on_confirmation(page, tmp_path):
    # Final Submit that reveals a confirmation node when clicked.
    page.set_content(
        "<label>First Name</label>"
        "<input data-automation-id='legalNameSection_firstName' type='text'>"
        "<label>Last Name</label>"
        "<input data-automation-id='legalNameSection_lastName' type='text'>"
        "<label>Email</label><input data-automation-id='email' type='email'>"
        "<label>Phone</label><input data-automation-id='phone-number' type='tel'>"
        "<label>Resume</label><input data-automation-id='fileUploadField' type='file'>"
        "<div id='host'></div>"
        "<button data-automation-id='submitButton' type='button' "
        "onclick=\"document.getElementById('host').innerHTML="
        "'<div data-automation-id=&quot;confirmationPage&quot;>Submitted</div>'\">"
        "Submit</button>")
    res = WorkdayFiller().apply(page, _ctx(ApplyMode.submit, tmp_path))
    assert res.status is ApplyStatus.submitted
    assert res.submit_attempt is not None
    # The attempt is built BEFORE the click (starts confirmed=False); the
    # submitted branch must upgrade it so the ledger records the true verdict.
    assert res.submit_attempt["confirmed"] is True
