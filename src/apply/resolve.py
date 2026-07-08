"""Resolve an apply URL to its final destination and classify the ATS family.

Aggregator links (jobright/Simplify trackers) redirect into the real ATS — so
we follow redirects to the final URL, then classify by hostname. Pure HTTP, no
browser; never raises (network errors fall back to classifying the original URL).
"""

from __future__ import annotations

import logging
from urllib.parse import urlparse

import httpx

from .base import ATSFamily

log = logging.getLogger(__name__)

DEFAULT_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/124.0.0.0 Safari/537.36"),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def classify_ats(url: str) -> ATSFamily:
    """Classify a (final) URL by hostname. Suffix-aware, so subdomains match."""
    host = (urlparse(url or "").hostname or "").lower()
    if not host:
        return ATSFamily.unknown
    if host == "greenhouse.io" or host.endswith(".greenhouse.io"):
        return ATSFamily.greenhouse
    if ("workday" in host or host.endswith(".myworkdayjobs.com")
            or host.endswith(".myworkdaysite.com")):
        return ATSFamily.workday
    if host == "lever.co" or host.endswith(".lever.co"):
        return ATSFamily.lever
    if host == "ashbyhq.com" or host.endswith(".ashbyhq.com"):
        return ATSFamily.ashby
    return ATSFamily.unknown


def resolve(url: str, *, timeout: float = 15.0,
            client: httpx.Client | None = None) -> tuple[str, ATSFamily]:
    """Follow redirects to the final URL and classify it. On any network error,
    return (url, classify_ats(url)). An injected client is never closed here."""
    owned = client is None
    if client is None:
        client = httpx.Client(follow_redirects=True, headers=DEFAULT_HEADERS,
                              timeout=timeout)
    try:
        resp = client.get(url)
        final = str(resp.url)
        return final, classify_ats(final)
    except httpx.HTTPError as exc:
        log.info("resolve(%s) network error: %s; using original", url, exc)
        return url, classify_ats(url)
    finally:
        if owned:
            client.close()
