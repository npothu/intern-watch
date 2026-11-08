"""Cross-source dedup: stable keys + merging of duplicate Jobs."""

from __future__ import annotations

import hashlib

from .models import Job
from .normalize import canonical_url, norm_company, normalize_url, preferred_apply_url

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


def most_restrictive_degrees(a: list[str], b: list[str]) -> list[str]:
    """Combine two sources' degree lists without loosening either. An empty
    list means "unknown", so the other side wins; two known lists keep only
    the degrees both allow (a row listing just Master's/PhD must not regain
    eligibility because another source listed nothing or Bachelor's too).
    Disjoint lists keep the first, which callers pass as the richer record."""
    if not a or not b:
        return list(a or b)
    folded = {d.casefold() for d in b}
    both = [d for d in a if d.casefold() in folded]
    return both or list(a)


def _merge_pair(base: Job, other: Job) -> Job:
    """Fold `other` into `base` (base assumed the richer/preferred record)."""
    base.sources = sorted(set(base.sources) | set(other.sources))
    base.url = preferred_apply_url(base.url, other.url)
    if not base.terms and other.terms:
        base.terms, base.term_confidence = other.terms, other.term_confidence
        base.terms_from_jd = other.terms_from_jd
    base.jobright_id = base.jobright_id or other.jobright_id
    base.work_model = base.work_model or other.work_model
    base.salary = base.salary or other.salary
    base.description = base.description or other.description
    base.degrees = most_restrictive_degrees(base.degrees, other.degrees)
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
    _share_degrees_by_canon(merged)
    return merged


def _share_degrees_by_canon(jobs: list[Job]) -> None:
    """Jobs with different dedup keys but one canonical posting (same ATS req
    reached via two URL spellings) are evaluated separately; give each the
    most restrictive degree evidence any of them carries, so the copy without
    degrees cannot slip past the grad-only elimination its twin hit."""
    by_canon: dict[str, list[Job]] = {}
    for job in jobs:
        canon = canonical_url(job.url)
        if canon:
            by_canon.setdefault(canon, []).append(job)
    for twins in by_canon.values():
        if len(twins) < 2:
            continue
        degrees: list[str] = []
        for job in twins:
            degrees = most_restrictive_degrees(degrees, job.degrees)
        for job in twins:
            job.degrees = most_restrictive_degrees(job.degrees, degrees)
