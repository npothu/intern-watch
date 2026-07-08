"""Shared browser-session helper over Playwright (sync API).

A single place any feature can open a browser — Browserbase (hosted, connected
over CDP) or a local Chromium — without re-implementing connect URLs, env-var
plumbing, or session persistence. Deliberately generic: it knows nothing about
job applications or any one feature's domain types. Callers pass a `BrowserConfig`
and (optionally) a `storage_path` to persist cookies/login state across runs.

Two backends, chosen by `BrowserConfig.provider`:
  * "browserbase" — hosted; connect over CDP using env-var credentials.
  * "local"       — launch a local Chromium (handy for hands-on debugging).

Playwright is imported lazily inside the context manager so this module imports
fine in plain unit tests without the package installed.
"""

from __future__ import annotations

import logging
import os
import re
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Iterator

if TYPE_CHECKING:
    from playwright.sync_api import Page

log = logging.getLogger(__name__)


@dataclass
class BrowserConfig:
    """How to open a browser. `provider` picks the backend; the `*_env` fields
    name the environment variables holding Browserbase credentials (so secrets
    never live in config or code). `headless` applies to the local provider
    only — the hosted browser is always remote.

    `session_timeout_s` is the Browserbase auto-end duration (seconds): a hosted
    session is killed by Browserbase after this many seconds regardless of what
    the client is doing. The default is modest for quick/shared uses; long apply
    runs (multi-minute form fills) must raise it — otherwise the session dies
    mid-run and the final screenshot / storage_state persist fails with
    TargetClosedError (see the apply path, which passes ~20 min). None leaves it
    to the project's configured default."""

    provider: str = "local"                 # "browserbase" | "local"
    headless: bool = True
    api_key_env: str = "BROWSERBASE_API_KEY"
    project_id_env: str = "BROWSERBASE_PROJECT_ID"
    session_timeout_s: "int | None" = None  # browserbase auto-end; None = default


# Browserbase's timeout is clamped to [60, 21600] s (1 min – 6 h). Keep our
# request inside that window so a caller can't get an API-level rejection.
_BB_MIN_TIMEOUT_S = 60
_BB_MAX_TIMEOUT_S = 21600


def connect_url(api_key: str, project_id: str,
                session_id: "str | None" = None) -> str:
    """Browserbase CDP endpoint. Kept separate so it's testable without network.

    When `session_id` is given (a session pre-created via the REST API so we can
    set its timeout), connect to that specific session; otherwise Browserbase
    provisions an ephemeral one from the project defaults."""
    url = (f"wss://connect.browserbase.com?apiKey={api_key}"
           f"&projectId={project_id}")
    if session_id:
        url += f"&sessionId={session_id}"
    return url


def _create_bb_session(api_key: str, project_id: str, timeout_s: int) -> str:
    """Create a Browserbase session with an explicit auto-end `timeout` (seconds)
    via the REST API and return its id, so long apply runs aren't killed at the
    project's short default. Network call, so kept isolated for testing."""
    import httpx

    clamped = max(_BB_MIN_TIMEOUT_S, min(_BB_MAX_TIMEOUT_S, int(timeout_s)))
    resp = httpx.post(
        "https://api.browserbase.com/v1/sessions",
        headers={"X-BB-API-Key": api_key, "Content-Type": "application/json"},
        json={"projectId": project_id, "timeout": clamped},
        timeout=30.0,
    )
    resp.raise_for_status()
    return resp.json()["id"]


def _teardown(page, context, browser, pw) -> None:
    """Close every browser handle and stop Playwright, guarding each step
    INDIVIDUALLY so one failure can't skip the rest.

    This is the crux of the "poisoned next session" bug: on Browserbase after a
    long run (and back-to-back local sessions in one process), the session can be
    dead by teardown, so `storage_state`/`close()` raise "Connection closed while
    reading from the driver" / TargetClosedError. If that aborted teardown, the
    Playwright driver subprocess (`pw.stop()`) was never stopped and leaked into
    the next `browser_session` in the same process (queue.py drains many jobs per
    process). Each step below is wrapped on its own, in dependency order
    (page -> context -> browser -> playwright), and `pw.stop()` is ALWAYS reached
    — so the next session starts from a clean slate no matter what failed."""
    for closer in (page, context, browser):
        if closer is None:
            continue
        try:
            closer.close()
        except Exception:
            log.debug("browser handle close failed during teardown",
                      exc_info=True)
    if pw is not None:
        try:
            pw.stop()
        except Exception:
            log.debug("playwright stop failed during teardown", exc_info=True)


@contextmanager
def browser_session(config: BrowserConfig, *,
                    storage_path: "Path | None" = None) -> "Iterator[Page]":
    """Yield a Playwright `Page` for `config`'s backend.

    If `storage_path` is given, the local provider loads Playwright
    `storage_state` from it on entry (when present) and both providers write it
    back on a clean exit — so a one-time interactive login can be reused. The
    page/context/browser are always closed in a `finally`.
    """
    from playwright.sync_api import sync_playwright   # lazy import

    storage = (str(storage_path)
               if storage_path is not None and Path(storage_path).exists()
               else None)

    pw = sync_playwright().start()
    browser = context = page = None
    try:
        if config.provider == "browserbase":
            api_key = os.environ.get(config.api_key_env)
            project_id = os.environ.get(config.project_id_env)
            if not api_key:
                raise RuntimeError(f"missing env var {config.api_key_env} "
                                   "for browserbase")
            if not project_id:
                raise RuntimeError(f"missing env var {config.project_id_env} "
                                   "for browserbase")
            # Pre-create the session when a timeout is requested so long apply
            # runs aren't auto-ended at the project's short default; otherwise
            # connect ephemerally (project defaults).
            session_id = None
            if config.session_timeout_s:
                session_id = _create_bb_session(
                    api_key, project_id, config.session_timeout_s)
            browser = pw.chromium.connect_over_cdp(
                connect_url(api_key, project_id, session_id))
            context = (browser.contexts[0] if browser.contexts
                       else browser.new_context())
        elif config.provider == "local":
            browser = pw.chromium.launch(headless=config.headless)
            context = (browser.new_context(storage_state=storage) if storage
                       else browser.new_context())
        else:
            raise RuntimeError(f"unknown browser provider '{config.provider}'")

        page = context.pages[0] if context.pages else context.new_page()
        yield page

        if storage_path is not None:
            try:
                Path(storage_path).parent.mkdir(parents=True, exist_ok=True)
                context.storage_state(path=str(storage_path))
            except Exception:
                log.warning("could not persist session to %s", storage_path,
                            exc_info=True)
    finally:
        _teardown(page, context, browser, pw)


def save_artifact_screenshot(page, dir_or_obj, name: str) -> "Path | None":
    """Full-page screenshot into a directory (or any object exposing an
    `artifacts_dir` attribute). Returns the path written, or None — tolerant of
    any failure / no directory."""
    out_dir = getattr(dir_or_obj, "artifacts_dir", dir_or_obj)
    if out_dir is None:
        return None
    try:
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", name) or "shot"
        if not safe.lower().endswith(".png"):
            safe += ".png"
        path = out_dir / safe
        page.screenshot(path=str(path), full_page=True)
        return path
    except Exception:
        log.warning("screenshot failed", exc_info=True)
        return None
