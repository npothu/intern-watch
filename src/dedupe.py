"""Cross-source dedup: stable keys + merging of duplicate Jobs."""

from __future__ import annotations

import hashlib

from .models import Job
from .normalize import norm_company, normalize_url

_CONF_RANK = {"explicit": 2, "inferred": 1, "unknown": 0}


def dedup_key(job: Job) -> str:
    """First match wins: jobright id > normalized url > company|title|term hash."""
    if job.jobright_id:
        return f"jr:{job.jobright_id}"
    nurl = normalize_url(job.url)
    if nurl:
        return f"url:{nurl}"
    basis = "|".join([norm_company(job.company), job.title.casefold().strip(),
                      job.terms[0] if job.terms else ""])
    return f"hash:{hashlib.sha1(basis.encode()).hexdigest()}"


def _merge_pair(base: Job, other: Job) -> Job:
    """Fold `other` into `base` (base assumed the richer/preferred record)."""
    base.sources = sorted(set(base.sources) | set(other.sources))
    if not base.terms and other.terms:
        base.terms, base.term_confidence = other.terms, other.term_confidence
    base.jobright_id = base.jobright_id or other.jobright_id
    base.work_model = base.work_model or other.work_model
    base.salary = base.salary or other.salary
    base.description = base.description or other.description
    base.jd_url = base.jd_url or other.jd_url
    if other.date_posted and (not base.date_posted or other.date_posted < base.date_posted):
        base.date_posted = other.date_posted
    seen = {loc.casefold() for loc in base.locations}
    for loc in other.locations:
        if loc.casefold() not in seen:
            base.locations.append(loc)
            seen.add(loc.casefold())
    return base


def dedupe(jobs: list[Job]) -> list[Job]:
    """Group by dedup_key, merge each group into one Job (preferring the
    record with the most confident term, then the most fields filled)."""
    groups: dict[str, list[Job]] = {}
    for job in jobs:
        key = dedup_key(job)
        job.dedup_key = key
        groups.setdefault(key, []).append(job)

    merged: list[Job] = []
    for group in groups.values():
        group.sort(key=lambda j: (
            _CONF_RANK[j.term_confidence],
            sum(x is not None and x != [] for x in
                (j.work_model, j.salary, j.date_posted, j.locations)),
        ), reverse=True)
        base = group[0]
        for other in group[1:]:
            base = _merge_pair(base, other)
        merged.append(base)
    return merged
