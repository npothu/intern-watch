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
SUPPRESS_WINDOW_DAYS = 120  # matches state.PRUNE_AFTER_DAYS


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


def _parse_sig(sig: str) -> tuple[str, str, str, frozenset[str]] | None:
    """company, title, term, bucket-set from a stored flat signature. Split
    from the RIGHT (locs, term, title fixed at the end) so a '|' inside a
    company name can't shift the fields. None if fewer than 4 parts."""
    parts = sig.split("|")
    if len(parts) < 4:
        return None
    locs, term, title = parts[-1], parts[-2], parts[-3]
    company = "|".join(parts[:-3])
    buckets = frozenset(locs.split("+")) if locs != "?" else frozenset()
    return company, title, term, buckets


# Term values that carry no discriminating signal. `?` is the empty-term
# marker from _signature; "Unknown term" is notify.primary_term's sentinel for
# a job whose term never resolved -- exactly the jobright rows that diverge
# from an ATS twin carrying an explicit season, so both must wildcard.
_UNKNOWN_TERMS = {"?", "Unknown term"}


def _buckets_unknown(buckets: frozenset[str]) -> bool:
    """A location side that carries no discriminating signal: no locations at
    all, or every bucket is the catch-all `unknown`."""
    return not buckets or buckets <= {"unknown"}


def compatible(sig_a: str, sig_b: str) -> bool:
    """True if two signatures plausibly name the SAME posting: identical
    company and title, with term and location treated as wildcards when either
    side is unknown. Terms match when equal or either is '?'; buckets match
    when the sets intersect or either side is entirely unknown. This closes the
    observed cross-source leaks (jobright emits Unknown-term / city-only rows
    the ATS feed spells out) at the cost of possibly collapsing two genuinely
    distinct same-title reqs where one side lacks a term or location."""
    a, b = _parse_sig(sig_a), _parse_sig(sig_b)
    if a is None or b is None:
        return sig_a == sig_b
    (ca, ta, tma, ba), (cb, tb, tmb, bb) = a, b
    if ca != cb or ta != tb:
        return False
    if (tma != tmb and tma not in _UNKNOWN_TERMS
            and tmb not in _UNKNOWN_TERMS):
        return False
    if _buckets_unknown(ba) or _buckets_unknown(bb):
        return True
    return bool(ba & bb)


def find_compatible(state: dict, user: str, sig: str, today: dt.date,
                    window_days: int) -> str | None:
    """The stored signature for `user`, still inside the window, that is
    `compatible` with `sig`; None if none. Prefilters on the company|title
    prefix so the scan touches only same-role records."""
    parsed = _parse_sig(sig)
    prefix = "|".join(sig.split("|")[:-2]) if parsed else None
    for stored in state.get("content", {}).get(user, {}):
        if prefix is not None and "|".join(stored.split("|")[:-2]) != prefix:
            continue
        if compatible(sig, stored) and st.content_seen(
                state, user, stored, today, window_days):
            return stored
    return None


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
