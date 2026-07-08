"""Acquire JD text for any Job, automatically.

The manual CLI takes a `--jd` file; the watcher has only a `Job`. This bridges
the gap with a 4-tier fallback (first hit wins) so a matched job can be tailored
with no human paste. Every tier fails open: an exception or a too-short result
just falls through to the next source, and an all-miss returns None.
"""

from __future__ import annotations

import json
import logging
import re

import httpx

from ..adapters.ats_boards import JD_MAX_CHARS
from ..adapters.jobright_page import _PAGE_UA, fetch_description
from ..normalize import strip_html

log = logging.getLogger(__name__)

# A result shorter than this is almost certainly an empty SPA shell / nav
# chrome, not a real JD — treat it as a miss and try the next source.
MIN_JD_CHARS = 200

# JSON-LD / __NEXT_DATA__ description heuristics for the generic scrape tier.
_NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)
_JSON_LD_RE = re.compile(
    r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.S | re.I)
_WS_RE = re.compile(r"\s+")

# Anti-bot / challenge / empty-SPA-shell tells. A 403 already raises, but many
# blockers serve a 200 with one of these instead of the JD — building a resume
# from "Access Denied" would be worse than reporting no JD (the user can then
# paste it). Checked against the raw HTML head, where these markers sit.
_BLOCKED_RE = re.compile(
    r"access denied|don.?t have permission|request (?:was )?blocked|"
    r"are you (?:a )?(?:human|robot)|verify you are human|captcha|"
    r"unusual traffic|enable javascript to|please enable js|forbidden",
    re.I)


def _ok(text: str | None) -> str | None:
    """Capped, whitespace-collapsed text if it clears MIN_JD_CHARS, else None."""
    if not text:
        return None
    text = _WS_RE.sub(" ", text).strip()[:JD_MAX_CHARS]
    return text if len(text) >= MIN_JD_CHARS else None


def _from_greenhouse(client: httpx.Client, jd_url: str) -> str | None:
    """Same call main.enrich_jds makes: Greenhouse content API -> stripped HTML."""
    resp = client.get(jd_url)
    resp.raise_for_status()
    content = resp.json().get("content") or ""
    return strip_html(content)[:JD_MAX_CHARS] or None


def _walk_json_descriptions(obj) -> list[str]:
    """Collect every string under a "description" key, at any depth."""
    found: list[str] = []
    if isinstance(obj, dict):
        for key, val in obj.items():
            if key == "description" and isinstance(val, str):
                found.append(val)
            else:
                found.extend(_walk_json_descriptions(val))
    elif isinstance(obj, list):
        for item in obj:
            found.extend(_walk_json_descriptions(item))
    return found


def _embedded_description(html: str) -> str | None:
    """Prefer a structured `description` from __NEXT_DATA__ or JSON-LD; these
    carry the JD prose without the page's nav/footer chrome."""
    for pat in (_NEXT_DATA_RE, _JSON_LD_RE):
        for m in pat.finditer(html):
            try:
                data = json.loads(m.group(1))
            except Exception:  # noqa: BLE001 — malformed blob, try the next
                continue
            for desc in _walk_json_descriptions(data):
                # description values are often HTML themselves.
                got = _ok(strip_html(desc))
                if got:
                    return got
    return None


def _generic_scrape(client: httpx.Client, url: str) -> str | None:
    """Browser-UA GET of an arbitrary apply page. Prefer an embedded
    structured description; else fall back to the full stripped body."""
    resp = client.get(url, headers={"User-Agent": _PAGE_UA},
                      follow_redirects=True)
    resp.raise_for_status()
    html = resp.text
    if _BLOCKED_RE.search(html[:2000]):  # a challenge/denial page, not a JD
        log.debug("jd_source scrape blocked (anti-bot/JS shell): %s", url)
        return None
    embedded = _embedded_description(html)
    if embedded:
        return embedded
    return _ok(strip_html(html))


def acquire_jd(job, *, client: httpx.Client | None = None,
               allow_scrape: bool = True) -> str | None:
    """JD text for a Job, trying (first hit wins): in-memory description,
    Greenhouse content API, jobright info page, then a generic scrape of the
    apply URL. Returns None if every source misses. Uses `client` if given,
    else makes (and closes) its own."""
    # Tier 1: already in memory — free, no network.
    got = _ok(job.description)
    if got:
        return got

    own = client is None
    if own:
        client = httpx.Client(timeout=20.0)
    try:
        # Tier 2: Greenhouse per-job content API.
        if getattr(job, "jd_url", None):
            try:
                got = _ok(_from_greenhouse(client, job.jd_url))
                if got:
                    return got
            except Exception as exc:  # noqa: BLE001 — fall through to next tier
                log.debug("jd_source greenhouse miss for %s: %s",
                          job.dedup_key, exc)

        # Tier 3: jobright info page (composed __NEXT_DATA__ blob).
        if getattr(job, "jobright_id", None):
            try:
                got = _ok(fetch_description(client, job.jobright_id))
                if got:
                    return got
            except Exception as exc:  # noqa: BLE001 — fall through to next tier
                log.debug("jd_source jobright miss for %s: %s",
                          job.dedup_key, exc)

        # Tier 4: generic scrape of the apply URL.
        if allow_scrape and getattr(job, "url", None):
            try:
                got = _generic_scrape(client, job.url)
                if got:
                    return got
            except Exception as exc:  # noqa: BLE001 — all sources missed
                log.debug("jd_source scrape miss for %s: %s",
                          job.dedup_key, exc)
    finally:
        if own:
            client.close()

    return None
