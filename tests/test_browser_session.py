"""Shared browser-session tests: connect-url, env/provider errors, screenshot,
storage persistence. No real browser is launched."""

from __future__ import annotations

from pathlib import Path

import pytest

from src.browser import BrowserConfig, browser_session, connect_url, save_artifact_screenshot


def test_connect_url_format():
    assert connect_url("K", "P") == ("wss://connect.browserbase.com?apiKey=K"
                                     "&projectId=P")


def test_connect_url_appends_session_id_when_given():
    assert connect_url("K", "P", "sess-123") == (
        "wss://connect.browserbase.com?apiKey=K&projectId=P&sessionId=sess-123")
    # An empty/None session id must not append the param.
    assert connect_url("K", "P", None) == (
        "wss://connect.browserbase.com?apiKey=K&projectId=P")
    assert "sessionId" not in connect_url("K", "P", "")


def test_module_imports_without_playwright():
    # Importing the module must not require playwright (lazy import inside fn).
    import src.browser.session as s
    assert callable(s.browser_session)


def test_browserbase_missing_api_key_raises(monkeypatch):
    pytest.importorskip("playwright.sync_api")
    monkeypatch.delenv("BROWSERBASE_API_KEY", raising=False)
    monkeypatch.setenv("BROWSERBASE_PROJECT_ID", "P")
    with (pytest.raises(RuntimeError, match="BROWSERBASE_API_KEY"),
          browser_session(BrowserConfig(provider="browserbase"))):
        pass


def test_browserbase_missing_project_id_raises(monkeypatch):
    pytest.importorskip("playwright.sync_api")
    monkeypatch.setenv("BROWSERBASE_API_KEY", "K")
    monkeypatch.delenv("BROWSERBASE_PROJECT_ID", raising=False)
    with (pytest.raises(RuntimeError, match="BROWSERBASE_PROJECT_ID"),
          browser_session(BrowserConfig(provider="browserbase"))):
        pass


def test_custom_env_var_names_are_honored(monkeypatch):
    pytest.importorskip("playwright.sync_api")
    monkeypatch.delenv("BB_KEY", raising=False)
    cfg = BrowserConfig(provider="browserbase", api_key_env="BB_KEY",
                        project_id_env="BB_PROJ")
    with pytest.raises(RuntimeError, match="BB_KEY"), browser_session(cfg):
        pass


def test_unknown_provider_raises():
    pytest.importorskip("playwright.sync_api")
    with (pytest.raises(RuntimeError, match="unknown browser provider"),
          browser_session(BrowserConfig(provider="bogus"))):
        pass


class _FakePage:
    def __init__(self):
        self.calls = []

    def screenshot(self, path, full_page=False):
        Path(path).write_bytes(b"png")
        self.calls.append(path)


def test_save_artifact_screenshot_with_dir(tmp_path):
    p = save_artifact_screenshot(_FakePage(), tmp_path, "loaded")
    assert p is not None and p.exists() and p.suffix == ".png"


def test_save_artifact_screenshot_sanitizes_and_appends_png(tmp_path):
    p = save_artifact_screenshot(_FakePage(), tmp_path, "step one/two")
    assert p.suffix == ".png" and "/" not in p.name


def test_save_artifact_screenshot_reads_artifacts_dir_attr(tmp_path):
    class Ctx:
        artifacts_dir = tmp_path
    p = save_artifact_screenshot(_FakePage(), Ctx(), "x")
    assert p is not None and p.parent == tmp_path


def test_save_artifact_screenshot_none_dir_returns_none():
    assert save_artifact_screenshot(_FakePage(), None, "x") is None


def test_save_artifact_screenshot_tolerates_failure(tmp_path):
    class Boom:
        def screenshot(self, **k):
            raise RuntimeError("nope")
    assert save_artifact_screenshot(Boom(), tmp_path, "x") is None


# ---- S2: teardown must guard each step and ALWAYS reach pw.stop() ------------

class _Closable:
    def __init__(self, name, log, boom=False):
        self.name, self.log, self.boom = name, log, boom

    def close(self):
        self.log.append(self.name)
        if self.boom:
            raise RuntimeError(f"{self.name} close failed "
                               "(connection closed while reading from driver)")


class _Pw:
    def __init__(self, log, boom=False):
        self.log, self.boom = log, boom

    def stop(self):
        self.log.append("pw.stop")
        if self.boom:
            raise RuntimeError("pw.stop failed")


def test_teardown_closes_in_dependency_order():
    from src.browser.session import _teardown
    log = []
    page, ctx, br = (_Closable("page", log), _Closable("context", log),
                     _Closable("browser", log))
    _teardown(page, ctx, br, _Pw(log))
    assert log == ["page", "context", "browser", "pw.stop"]


def test_teardown_still_stops_playwright_when_a_close_raises():
    # The poisoned-next-session bug: a failing storage_state/close must NOT skip
    # pw.stop(), which would leak the driver into the next session in-process.
    from src.browser.session import _teardown
    log = []
    page = _Closable("page", log, boom=True)       # storage_state-style failure
    ctx = _Closable("context", log, boom=True)
    br = _Closable("browser", log, boom=True)
    pw = _Pw(log)
    _teardown(page, ctx, br, pw)                    # must not raise
    # Every step attempted, and pw.stop() reached despite all three close booms.
    assert log == ["page", "context", "browser", "pw.stop"]


def test_teardown_tolerates_none_handles_and_failing_stop():
    from src.browser.session import _teardown
    log = []
    # Partial construction (browser connected, context/page never made) plus a
    # failing pw.stop() must all be swallowed.
    _teardown(None, None, _Closable("browser", log), _Pw(log, boom=True))
    assert log == ["browser", "pw.stop"]
    _teardown(None, None, None, None)               # nothing to do, no crash


# ---- S3: Browserbase session created with a clamped timeout ------------------

def test_create_bb_session_posts_timeout_and_returns_id(monkeypatch):
    import src.browser.session as s
    captured = {}

    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"id": "sess-abc"}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured.update(url=url, headers=headers, json=json)
        return _Resp()

    monkeypatch.setattr("httpx.post", fake_post)
    sid = s._create_bb_session("K", "P", 1200)
    assert sid == "sess-abc"
    assert captured["url"].endswith("/v1/sessions")
    assert captured["headers"]["X-BB-API-Key"] == "K"
    assert captured["json"] == {"projectId": "P", "timeout": 1200}


def test_create_bb_session_clamps_timeout_to_browserbase_bounds(monkeypatch):
    import src.browser.session as s
    seen = []

    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"id": "x"}

    def fake_post(url, headers=None, json=None, timeout=None):
        seen.append(json["timeout"])
        return _Resp()

    monkeypatch.setattr("httpx.post", fake_post)
    s._create_bb_session("K", "P", 5)          # below min -> clamped up
    s._create_bb_session("K", "P", 10**9)      # above max -> clamped down
    assert seen == [s._BB_MIN_TIMEOUT_S, s._BB_MAX_TIMEOUT_S]


def test_browserconfig_defaults_no_session_timeout():
    # The shared default stays modest (None) so non-apply callers don't force a
    # long-lived hosted session; the apply path opts in explicitly.
    assert BrowserConfig().session_timeout_s is None
