"""SmartRecruiters posting helpers for the ats_boards adapter.

SmartRecruiters exposes an official, public, no-auth JSON API:

  list:   https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=100&offset=0
  detail: https://api.smartrecruiters.com/v1/companies/{slug}/postings/{postingId}

The list envelope is paged ({offset, limit, totalFound, content: [...]}); each
content row carries the title, company, location, releasedDate and a public
posting URL, but NOT the JD body. The body lives on the per-posting detail
endpoint under jobAd.sections.* as HTML, so postings get a jd_url that
main.enrich_jds fetches lazily for new jobs only -- the same pattern Greenhouse
uses. This module only holds the SmartRecruiters-specific parsing; the dispatch
and Job construction stay in ats_boards.py.
"""

from __future__ import annotations

from ..normalize import strip_html

LIST_URL = ("https://api.smartrecruiters.com/v1/companies/{slug}/postings"
            "?limit=100&offset=0")
DETAIL_URL = ("https://api.smartrecruiters.com/v1/companies/{slug}"
              "/postings/{posting_id}")


def posting_url(posting: dict, slug: str) -> str | None:
    """Public posting page: the canonical postingUrl (no apply-flow params),
    falling back to applyUrl, then a jobs.smartrecruiters.com page built from
    the slug + id."""
    for key in ("postingUrl", "applyUrl"):
        val = posting.get(key)
        if val:
            return val
    pid = posting.get("id")
    return f"https://jobs.smartrecruiters.com/{slug}/{pid}" if pid else None


def location_str(posting: dict) -> str:
    """Prefer the pre-joined fullLocation; otherwise stitch city/region/country
    so the non-US/Canada elimination still has something to scan."""
    loc = posting.get("location") or {}
    full = loc.get("fullLocation")
    if full:
        return full
    parts = [loc.get("city"), loc.get("region"), loc.get("country")]
    return ", ".join(p for p in parts if p)


def jd_text(detail: dict) -> str | None:
    """Plain-text JD from a detail-endpoint payload: concatenate every
    jobAd.sections.* text (description, qualifications, ...) so the
    clearance/grad-only/unpaid JD eliminations see the requirement bullets."""
    sections = ((detail.get("jobAd") or {}).get("sections")) or {}
    parts = []
    for section in sections.values():
        if isinstance(section, dict) and section.get("text"):
            parts.append(strip_html(section["text"]))
    text = " ".join(p for p in parts if p).strip()
    return text or None
