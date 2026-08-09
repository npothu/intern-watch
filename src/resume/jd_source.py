"""Acquire JD text for any Job, automatically.

The manual CLI takes a `--jd` file; the watcher has only a `Job`. This bridges
the gap with a fallback chain (first hit wins) so a matched job can be
tailored with no human paste: in-memory description, Greenhouse content API,
then the jobright info page and a generic scrape of the apply URL, in
whichever order is more likely to succeed -- if `url` is itself a jobright
link the jobright page goes first (as it always has); if `url` is a real
employer link, the scrape goes first and the jobright page (when a
`jobright_id` is available) is only a fallback for employer sites that block
bots. Every tier fails open: an exception or a too-short result just falls
through to the next source, and an all-miss returns None.
"""

from __future__ import annotations

import json
import logging
import re

import httpx

from ..adapters.ats_boards import JD_MAX_CHARS
from ..adapters.jobright_page import _PAGE_UA, fetch_description
from ..normalize import extract_jobright_id, strip_html

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

# The full-body scrape fallback (used only when no structured description was
# found) has no guarantee the visible text is actually a JD -- a script-heavy
# page whose hydration payload leaked past strip_html's script/style/noscript
# strip (or any other JS/serialized-data debris left in the body) can still
# clear MIN_JD_CHARS. _looks_like_jd rejects text that reads like JS rather
# than prose, so an honest miss (fall through to the next tier) beats a JD
# built from tracker script or framework internals.
_JS_TOKEN_RE = re.compile(
    r"function\s*\(|=>|\bwindow\.|\bdocument\.|\bvar\s+\w|__next|null,\s*\{|"
    r'\\+"\$',
    re.I)
_JD_MARKER_RE = re.compile(
    r"responsibilit|qualification|requirement|you will|we are looking|"
    r"experience\s+(?:in|with)|degree",
    re.I)
# Tokens-per-1000-chars above this, with no JD marker present, reads as JS.
_JS_TOKEN_DENSITY_THRESHOLD = 2.0


def _looks_like_jd(text: str) -> bool:
    """True unless `text` reads like JavaScript/serialized-data debris rather
    than job-description prose: a JD marker anywhere is enough to keep it;
    otherwise a high density of JS/serialization tokens rejects it."""
    if _JD_MARKER_RE.search(text):
        return True
    if not text:
        return True
    density = len(_JS_TOKEN_RE.findall(text)) / (len(text) / 1000)
    return density < _JS_TOKEN_DENSITY_THRESHOLD


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
    fallback = _ok(strip_html(html))
    if fallback and not _looks_like_jd(fallback):
        log.debug("jd_source scrape rejected (looks like JS, not a JD): %s",
                  url)
        return None
    return fallback


def _try_scrape(client: httpx.Client, url: str, job) -> str | None:
    try:
        return _generic_scrape(client, url)
    except Exception as exc:  # noqa: BLE001 — fall through to next tier
        log.debug("jd_source scrape miss for %s: %s", job.dedup_key, exc)
        return None


def _try_jobright(client: httpx.Client, jobright_id: str, job) -> str | None:
    try:
        return _ok(fetch_description(client, jobright_id))
    except Exception as exc:  # noqa: BLE001 — fall through to next tier
        log.debug("jd_source jobright miss for %s: %s", job.dedup_key, exc)
        return None


def acquire_jd(job, *, client: httpx.Client | None = None,
               allow_scrape: bool = True) -> str | None:
    """JD text for a Job, trying (first hit wins): in-memory description,
    Greenhouse content API, then jobright info page and generic scrape of the
    apply URL -- scrape first when `url` is a real employer link, jobright
    page first when `url` is itself a jobright link. Returns None if every
    source misses. Uses `client` if given, else makes (and closes) its own."""
    # Tier 1: already in memory — free, no network.
    got = _ok(job.description)
    if got:
        return got

    # A non-optional local: every tier below needs a real client, and `own`
    # alone doesn't tell the type checker that `client` stopped being None.
    own = client is None
    http = client if client is not None else httpx.Client(timeout=20.0)
    try:
        # Tier 2: Greenhouse per-job content API.
        if getattr(job, "jd_url", None):
            try:
                got = _ok(_from_greenhouse(http, job.jd_url))
                if got:
                    return got
            except Exception as exc:  # noqa: BLE001 — fall through to next tier
                log.debug("jd_source greenhouse miss for %s: %s",
                          job.dedup_key, exc)

        url = getattr(job, "url", None)
        jobright_id = getattr(job, "jobright_id", None)
        # An employer url (not itself a jobright link) is the stronger
        # source: try scraping it before the jobright page, which is then
        # only a fallback for employer sites that block bots.
        scrape_first = bool(allow_scrape and url
                             and extract_jobright_id(url) is None)

        if scrape_first and url:
            got = _try_scrape(http, url, job)
            if got:
                return got

        # jobright info page (composed __NEXT_DATA__ blob).
        if jobright_id:
            got = _try_jobright(http, jobright_id, job)
            if got:
                return got

        # generic scrape of the apply URL, if not already tried above.
        if not scrape_first and allow_scrape and url:
            got = _try_scrape(http, url, job)
            if got:
                return got
    finally:
        if own:
            http.close()

    return None
