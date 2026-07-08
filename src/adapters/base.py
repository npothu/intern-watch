"""Adapter ABC: fetch each configured file and parse it into Jobs."""

from __future__ import annotations

import datetime as dt
import logging
from abc import ABC, abstractmethod

import httpx

from ..models import Job, SourceConfig

log = logging.getLogger(__name__)

_RETRIES = 3
_TIMEOUT = 30.0


def fetch_text(client: httpx.Client, url: str) -> str:
    last_exc: Exception | None = None
    for attempt in range(1, _RETRIES + 1):
        try:
            resp = client.get(url, timeout=_TIMEOUT, follow_redirects=True)
            resp.raise_for_status()
            return resp.text
        except Exception as exc:  # noqa: BLE001 - retry anything transient
            last_exc = exc
            log.warning("fetch attempt %d/%d failed for %s: %s",
                        attempt, _RETRIES, url, exc)
    raise RuntimeError(f"failed to fetch {url}") from last_exc


class Adapter(ABC):
    def __init__(self, cfg: SourceConfig):
        self.cfg = cfg

    def fetch(self, client: httpx.Client, today: dt.date) -> list[Job]:
        """Fetch every file for this source and parse. Raises on fetch error;
        the orchestrator catches per-source and continues."""
        jobs: list[Job] = []
        for path in self.cfg.files:
            text = fetch_text(client, self.cfg.raw_url(path))
            parsed = self.parse(text, path, today)
            log.info("source %s file %s: %d jobs", self.cfg.name, path, len(parsed))
            jobs.extend(parsed)
        return jobs

    @abstractmethod
    def parse(self, raw: str, path: str, today: dt.date) -> list[Job]:
        """Parse one raw file into Jobs. Must not raise on malformed rows --
        skip them (optionally log) and keep going."""
