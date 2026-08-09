"""GreenhouseFiller tests against a local fixture form (needs Playwright)."""

from __future__ import annotations

from pathlib import Path

import pytest

from src.apply.base import ApplyContext, ApplyMode, ApplyStatus, ATSFamily, Filler
from src.apply.fillers import get_filler
from src.apply.fillers.greenhouse import GreenhouseFiller
from src.apply.profile import load_profile

FIXTURE = (Path(__file__).parent / "fixtures" / "apply" / "greenhouse_form.html")
FIXTURE_URL = FIXTURE.resolve().as_uri()


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


def _resume(tmp_path) -> Path:
    r = tmp_path / "example_resume.docx"
    r.write_bytes(b"PK\x03\x04 dummy docx")
    return r


def _ctx(mode, tmp_path) -> ApplyContext:
    return ApplyContext(job={"key": "gh", "company": "Acme"},
                        profile=load_profile(
                            path=Path(__file__).resolve().parents[1]
                            / "users" / "apply.example.yaml"),
                        resume_path=_resume(tmp_path), mode=mode,
                        final_url=FIXTURE_URL, family=ATSFamily.greenhouse,
                        artifacts_dir=tmp_path)


def test_registry_and_protocol():
    f = get_filler(ATSFamily.greenhouse)
    assert isinstance(f, GreenhouseFiller) and isinstance(f, Filler)


def test_autofill_fills_and_pauses(page, tmp_path):
    page.goto(FIXTURE_URL)
    before = page.url
    prof = load_profile(path=Path(__file__).resolve().parents[1] / "users" / "apply.example.yaml")
    res = GreenhouseFiller().apply(page, _ctx(ApplyMode.autofill, tmp_path))

    assert res.status is ApplyStatus.filled_paused and res.ok
    assert res.family is ATSFamily.greenhouse
    assert page.url == before                       # did NOT submit
    assert page.locator("#application-form").count() == 1
    assert page.locator("#confirmation").count() == 0
    assert page.input_value("#first_name") == prof.first_name
    assert page.input_value("#last_name") == prof.last_name
    assert page.input_value("#email") == prof.email
    assert page.input_value("#phone") == prof.phone
    assert page.input_value("#linkedin") == prof.links.linkedin
    file_val = page.input_value("#resume")
    assert file_val and file_val.endswith("example_resume.docx")
    assert page.input_value("#gender") == prof.eeo.gender
    # Greenhouse runs the agent engine: it attaches the resume and fills several
    # fields (refs, not logical names).
    assert "resume" in res.filled_fields
    assert len(res.filled_fields) >= 4


def test_submit_reaches_confirmation(page, tmp_path):
    page.goto(FIXTURE_URL)
    res = GreenhouseFiller().apply(page, _ctx(ApplyMode.submit, tmp_path))
    assert res.status is ApplyStatus.submitted
    assert page.locator("#confirmation").count() == 1
