"""Bounded, polite HTTP for the multi-request ATS listing adapters.

Greenhouse/Lever/Ashby answer a whole board in one GET. SmartRecruiters,
Oracle Recruiting Cloud, Eightfold, IBM and Jibe page their search results, so
one board costs several requests. These helpers keep that cheap and polite:

- every request after the first waits REQUEST_DELAY seconds (sequential, never
  concurrent; one board's pages run back to back on the same host);
- a 429 or 5xx gets ONE retry after RETRY_DELAY, then the error propagates so
  the per-board try/except in ats_boards.fetch skips just that board;
- callers cap their own page count (MAX_PAGES unless a board row overrides
  it), so a misbehaving feed can never loop.

`sleep` is module-level so tests can patch it out.
"""

from __future__ import annotations

import json
import time
from typing import Any

import httpx

REQUEST_DELAY = 1.0   # seconds between requests to one board
RETRY_DELAY = 5.0     # backoff before the single 429/5xx retry
TIMEOUT = 30.0
MAX_PAGES = 5         # default per-query page cap

sleep = time.sleep


class Pacer:
    """Sleeps REQUEST_DELAY before every request except the first."""

    def __init__(self) -> None:
        self._first = True

    def wait(self) -> None:
        if not self._first:
            sleep(REQUEST_DELAY)
        self._first = False


def request_text(client: httpx.Client, pacer: Pacer, url: str, *,
                 body: Any = None) -> str:
    """GET (or POST `body` as JSON) and return the response text."""
    for attempt in (1, 2):
        pacer.wait()
        if body is None:
            resp = client.get(url, timeout=TIMEOUT, follow_redirects=True)
        else:
            resp = client.post(url, content=json.dumps(body), timeout=TIMEOUT,
                               headers={"Content-Type": "application/json"})
        if attempt == 1 and (resp.status_code == 429
                             or resp.status_code >= 500):
            sleep(RETRY_DELAY)
            continue
        resp.raise_for_status()
        return resp.text
    raise AssertionError("unreachable")  # pragma: no cover


def page_cap(board: dict) -> int:
    """Per-board override (`max_pages:` in ats_boards.yaml), else MAX_PAGES."""
    try:
        return max(1, int(board.get("max_pages") or MAX_PAGES))
    except (TypeError, ValueError):
        return MAX_PAGES
