"""Cross-key content suppression.

The jr:/url: dedup key (see dedupe.py) is the primary identity, but jobright
re-emits ONE real posting under MANY distinct keys: different jobright ids
(sequential ObjectIds minted seconds apart), US/Canada splits of the same req,
and the same job ingested from multiple upstream feeds. Those all pass the
"is this dedup_key new?" check, so without a second gate the same job gets
delivered several times.

This module computes a content *signature* -- normalized company, title, term
and state bucket -- so two records of the SAME posting collapse while genuinely
distinct postings (different state, different term) keep distinct signatures.
The signature is consulted at delivery time (src/main.run_for_user): an
accepted job whose signature was already delivered to a user within
SUPPRESS_WINDOW_DAYS is recorded in state but not re-notified. Suppression is
deliberately conservative on the one case it can't disambiguate without the
real requisition id (two different reqs, same title, same state) -- those
collapse, so every suppression is logged for audit.
"""

from __future__ import annotations

import datetime as dt
import logging

from . import state as st
from .filters import location_bucket
from .models import Job
from .normalize import norm_company, norm_title

log = logging.getLogger(__name__)

# Re-deliver an identical posting only if its prior delivery has aged past this
# many days. Duplicates churn within hours/days, so a short window kills them;
# a genuinely new identical-title repost months later still gets through.
SUPPRESS_WINDOW_DAYS = 45


def _signature(company: str, title: str, term: str, buckets: list[str]) -> str:
    locs = "+".join(sorted(set(buckets))) if buckets else "?"
    return "|".join([norm_company(company), norm_title(title),
                     (term or "?"), locs])


def content_signature(job: Job, term: str) -> str:
    """Stable signature for duplicate suppression:
    `company | title | term | sorted-state-buckets`. A job's full location list
    is bucketed so a multi-state posting is distinct from a single-state one."""
    return _signature(job.company, job.title, term,
                      [location_bucket(loc) for loc in job.locations])


def signature_from_item(item: dict) -> str:
    """Signature reconstructed from a stored match/outbox snapshot (which keeps
    only a single display location string). Used to seed history; lines up with
    content_signature for the common single-location posting."""
    loc = item.get("location") or ""
    buckets = [location_bucket(loc)] if loc else []
    return _signature(item.get("company", ""), item.get("title", ""),
                      item.get("term") or "?", buckets)


def seed_from_matches(state: dict) -> int:
    """One-time migration: seed the content map from each user's already-
    delivered matches, so a job emailed *before* this feature shipped isn't
    re-delivered when a duplicate dedup_key shows up afterward. Idempotent via
    a `_meta` flag; uses each match's own `added` date so the suppression
    window is measured from the original delivery, not from migration day.

    Match snapshots keep only a single display location, so a historical
    *multi*-location posting may still emit one final duplicate -- acceptable,
    since matches age out within the prune window anyway."""
    if state.get("_meta", {}).get("content_seeded"):
        return 0
    seeded = 0
    for user, items in state.get("matches", {}).items():
        for item in items:
            day = item.get("added")
            if not day:
                continue
            try:
                day_date = dt.date.fromisoformat(day)
            except ValueError:
                continue
            st.content_mark(state, user, signature_from_item(item),
                            item.get("key", ""), day_date)
            seeded += 1
    state.setdefault("_meta", {})["content_seeded"] = True
    if seeded:
        log.info("content-dedup: seeded %d historical match(es)", seeded)
    return seeded
