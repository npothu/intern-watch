"""Lazy JD fetch for jobright postings.

The jobright README adapter parses only the markdown table (no JD), so the
grad-only/unpaid/clearance filters that read job.description never fire on a
jobright row. This fetches the server-rendered info page on demand -- only
for jobs about to be ACCEPTED -- and composes a description from the embedded
__NEXT_DATA__ JSON so those same filters get something to bite on.

Stdlib-only (re/json) over the caller's httpx client. Fail open: any
fetch/parse miss returns None and the job is kept as-is.
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

# The page embeds its props as one JSON blob in a Next.js data script.
_NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)


def _job_result(html: str) -> dict | None:
    m = _NEXT_DATA_RE.search(html)
    if not m:
        return None
    data = json.loads(m.group(1))
    return (data.get("props", {}).get("pageProps", {})
            .get("dataSource", {}).get("jobResult"))


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


def fetch_description(client: httpx.Client, jobright_id: str) -> str | None:
    """Return a composed JD blob for a 24-hex jobright id, or None on any
    fetch/parse failure (caller keeps the job and logs)."""
    resp = client.get(_PAGE_URL.format(id=jobright_id),
                      headers={"User-Agent": _PAGE_UA})
    resp.raise_for_status()
    job_result = _job_result(resp.text)
    if not job_result:
        raise RuntimeError("__NEXT_DATA__ jobResult not found")
    return compose_description(job_result)
