"""Apply-driver adapter tests. The generic session/screenshot machinery is
covered by tests/test_browser_session.py; here we only test the mapping from
ApplyProfile/ATSFamily onto the shared helper (no real browser)."""

from __future__ import annotations

from pathlib import Path

import pytest

from src.apply.base import ATSFamily
from src.apply.driver import browser_session
from src.apply.profile import load_profile


def test_module_imports_without_playwright():
    # Importing the module must not require playwright (lazy import inside fn).
    import src.apply.driver as d
    assert callable(d.browser_session)
    # Compatibility re-exports for existing callers.
    assert callable(d.save_artifact_screenshot)
    assert callable(d.connect_url)


def test_browserbase_missing_api_key_raises(monkeypatch):
    pytest.importorskip("playwright.sync_api")
    monkeypatch.delenv("BROWSERBASE_API_KEY", raising=False)
    monkeypatch.setenv("BROWSERBASE_PROJECT_ID", "P")
    profile = load_profile(path=Path(__file__).resolve().parents[1] / "users" / "apply.example.yaml")
    profile.cloud.provider = "browserbase"
    with pytest.raises(RuntimeError, match="BROWSERBASE_API_KEY"):
        with browser_session(profile, ATSFamily.unknown):
            pass


def test_unknown_provider_raises(monkeypatch):
    pytest.importorskip("playwright.sync_api")
    profile = load_profile(path=Path(__file__).resolve().parents[1] / "users" / "apply.example.yaml")
    profile.cloud.provider = "bogus"
    with pytest.raises(RuntimeError, match="unknown browser provider"):
        with browser_session(profile, ATSFamily.unknown):
            pass