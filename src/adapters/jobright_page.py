"""Lazy JD fetch for jobright postings.

The jobright README adapter parses only the markdown table (no JD), so the
grad-only/unpaid/clearance filters that read job.description never fire on a
jobright row. This fetches the jobright info page's data on demand -- only
for jobs about to be ACCEPTED -- and composes a description from the embedded
jobResult JSON so those same filters get something to bite on.

JSON-first strategy: the same jobResult object served by the full HTML page
(~290-334 KB) is also served by the public per-job JSON route
(`_next/data/<buildId>/jobs/info/<id>.json`, ~10-14 KB, 20-30x smaller). The
JSON route needs a Next.js buildId, which only changes on jobright deploys,
so it is cached at module level for the life of the process. Cold start (no
cached buildId yet) or a stale one (JSON route 404s) falls back to fetching
the HTML page once -- that response both refreshes the cached buildId for
later calls and directly serves the description, so nothing is wasted.

Stdlib-only (re/json) over the caller's httpx client. Fail open: any
fetch/parse miss returns None or raises, and the caller keeps the job as-is.
"""

from __future__ import annotations

import json
import logging
import re

import httpx

from .ats_boards import JD_MAX_CHARS

log = logging.getLogger(__name__)

# A browser-ish UA is required: jobright serves the bare shell to the bot UA.
_PAGE_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
_PAGE_URL = "https://jobright.ai/jobs/info/{id}"
_JSON_URL = "https://jobright.ai/_next/data/{build_id}/jobs/info/{id}.json"

# The page embeds its props as one JSON blob in a Next.js data script.
_NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)

# Rotates on jobright deploys; discovered from the HTML page and reused by
# the cheap JSON route for the rest of the process.
_build_id: str | None = None


def _parse_next_data(html: str) -> dict | None:
    m = _NEXT_DATA_RE.search(html)
    if not m:
        return None
    return json.loads(m.group(1))


def _job_result(data: dict) -> dict | None:
    """Pull jobResult out of either the HTML __NEXT_DATA__ shape
    (props.pageProps...) or the JSON route shape (pageProps..., no props
    wrapper)."""
    page_props = ((data.get("props") or {}).get("pageProps")
                  or data.get("pageProps") or {})
    return (page_props.get("dataSource") or {}).get("jobResult")


def compose_description(job_result: dict) -> str | None:
    """jobSummary + qualification bullets + responsibilities, joined into one
    blob the existing JD filters can scan. mustHave carries the literal
    requirement strings (e.g. 'Must be currently enrolled in a PhD program')."""
    parts: list[str] = []
    summary = job_result.get("jobSummary")
    if summary:
        parts.append(summary)
    quals = job_result.get("qualifications") or {}
    for key in ("mustHave", "preferredHave", "niceToHave"):
        parts.extend(s for s in (quals.get(key) or []) if s)
    parts.extend(s for s in (job_result.get("coreResponsibilities") or []) if s)
    text = " ".join(parts).strip()
    return text[:JD_MAX_CHARS] or None


def _fetch_via_json(client: httpx.Client, jobright_id: str,
                    build_id: str) -> dict | None:
    """jobResult via the small JSON route, or None on any failure (stale
    buildId 404, non-JSON body, missing jobResult)."""
    try:
        resp = client.get(_JSON_URL.format(build_id=build_id, id=jobright_id),
                          headers={"User-Agent": _PAGE_UA})
        resp.raise_for_status()
        data = resp.json()
    except (httpx.HTTPError, ValueError):
        return None
    return _job_result(data)


def _fetch_via_html(client: httpx.Client, jobright_id: str) -> dict | None:
    """jobResult via the full page: refreshes the cached buildId and serves
    the data from the same response."""
    global _build_id
    resp = client.get(_PAGE_URL.format(id=jobright_id),
                      headers={"User-Agent": _PAGE_UA})
    resp.raise_for_status()
    data = _parse_next_data(resp.text)
    if not data:
        raise RuntimeError("__NEXT_DATA__ not found")
    build_id = data.get("buildId")
    if build_id:
        _build_id = build_id
    job_result = _job_result(data)
    if not job_result:
        raise RuntimeError("__NEXT_DATA__ jobResult not found")
    return job_result


def fetch_job_result(client: httpx.Client, jobright_id: str) -> dict | None:
    """Return the raw jobResult dict, or None on any fetch/parse failure."""
    if _build_id:
        job_result = _fetch_via_json(client, jobright_id, _build_id)
        if job_result is not None:
            return job_result
    return _fetch_via_html(client, jobright_id)


def fetch_description(client: httpx.Client, jobright_id: str) -> str | None:
    """Return a composed JD blob for a 24-hex jobright id, or None on any
    fetch/parse failure (caller keeps the job and logs)."""
    job_result = fetch_job_result(client, jobright_id)
    if job_result is None:
        return None
    return compose_description(job_result)
