"""seen.json: which dedup_keys exist, who was notified, cached LLM verdicts.

Shape:
{
  "_meta": {"version": 1, "source_rows": {"jobright-swe": 312, ...}},
  "jobs": {
    "<dedup_key>": {
      "first_seen": "2026-06-11",
      "last_seen": "2026-06-11",
      "sources": ["jobright-swe"],
      "notified_for": ["example"],
      "llm": {"term": "Fall 2026", "in_atlanta_metro": false}    # objective, shared
    }
  },
  "companies": {
    "<norm_company>": {"top": {"example": true}, "judged": "2026-06-12"}
  }
}

"top company" is judged once per (normalized employer, user), not per job:
per-job judgments let the same employer flip verdicts between postings
(Universal Creative true / Universal Orlando Resort false on the same day).
Job entries from before this change may still carry a legacy "llm_top" key;
it is no longer read or written.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path

from .normalize import norm_company

log = logging.getLogger(__name__)

PRUNE_AFTER_DAYS = 120
HEALTH_ALERT_AFTER = 9  # consecutive failed runs (~18h at 2h cadence) before users hear about it


def empty_state() -> dict:
    return {"_meta": {"version": 1, "source_rows": {}, "source_health": {}},
            "jobs": {}, "companies": {}, "outbox": {}, "last_email": {},
            "matches": {}, "content": {}}


def load_state(path: Path) -> dict:
    if not path.exists():
        return empty_state()
    state = json.loads(path.read_text(encoding="utf-8"))
    meta = state.setdefault("_meta", {})
    meta.setdefault("source_rows", {})
    meta.setdefault("source_health", {})
    state.setdefault("jobs", {})
    state.setdefault("companies", {})
    state.setdefault("outbox", {})
    state.setdefault("last_email", {})
    state.setdefault("matches", {})
    state.setdefault("content", {})
    return state


def save_state(state: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=1, sort_keys=True) + "\n",
                    encoding="utf-8")


def touch(state: dict, key: str, sources: list[str], today: dt.date) -> bool:
    """Record that `key` was seen today. Returns True if it is brand new."""
    jobs = state["jobs"]
    iso = today.isoformat()
    if key in jobs:
        entry = jobs[key]
        entry["last_seen"] = iso
        entry["sources"] = sorted(set(entry.get("sources", [])) | set(sources))
        return False
    jobs[key] = {"first_seen": iso, "last_seen": iso,
                 "sources": sorted(sources), "notified_for": []}
    return True


def _entry(state: dict, key: str) -> dict:
    return state["jobs"].setdefault(key, {})


def mark_notified(state: dict, key: str, user: str) -> None:
    e = _entry(state, key)
    if user not in e.setdefault("notified_for", []):
        e["notified_for"].append(user)


def was_notified(state: dict, key: str, user: str) -> bool:
    return user in state["jobs"].get(key, {}).get("notified_for", [])


# "pending" = this user still owes a decision/notification for the job
# (LLM cost-guard deferral, API failure, or webhook non-2xx). Pending jobs are
# re-fed into that user's pipeline on the next run even though they are no
# longer globally "new".

def set_pending(state: dict, key: str, user: str) -> None:
    e = _entry(state, key)
    if user not in e.setdefault("pending", []):
        e["pending"].append(user)


def clear_pending(state: dict, key: str, user: str) -> None:
    e = state["jobs"].get(key, {})
    if user in e.get("pending", []):
        e["pending"].remove(user)
        if not e["pending"]:
            del e["pending"]


def pending_keys(state: dict, user: str) -> set[str]:
    return {k for k, v in state["jobs"].items() if user in v.get("pending", [])}


# Cached LLM verdicts: term + atlanta are objective and belong to the job
# (shared across users); "top company" is subjective and belongs to the
# EMPLOYER (per-user, see company_top_*). Cache hits never re-bill.

def llm_cache_get(state: dict, key: str) -> dict:
    shared = state["jobs"].get(key, {}).get("llm", {})
    facts: dict = {}
    if "term" in shared:
        facts["term"] = shared["term"]
    if "in_atlanta_metro" in shared:
        facts["in_atlanta_metro"] = shared["in_atlanta_metro"]
    return facts


def llm_cache_put(state: dict, key: str, facts: dict) -> None:
    e = _entry(state, key)
    shared = e.setdefault("llm", {})
    if "term" in facts:
        shared["term"] = facts["term"]
    if "in_atlanta_metro" in facts:
        shared["in_atlanta_metro"] = facts["in_atlanta_metro"]


def company_top_get(state: dict, company: str, user: str) -> bool | None:
    """Cached per-employer "top company" verdict, or None if never judged."""
    e = state.get("companies", {}).get(norm_company(company), {})
    top = e.get("top", {})
    return top.get(user) if user in top else None


def company_top_put(state: dict, company: str, user: str, verdict: bool,
                    today: dt.date) -> None:
    norm = norm_company(company)
    if not norm:
        return
    e = state.setdefault("companies", {}).setdefault(norm, {"top": {}})
    e.setdefault("top", {})[user] = bool(verdict)
    e["judged"] = today.isoformat()


# Source health: consecutive-failure counters so a silently-broken source
# (format change, dead board, repo gone) surfaces in the digest instead of
# only in Actions logs. An entry exists only while a source is failing.

def record_source_failure(state: dict, name: str, error: str,
                          today: dt.date) -> int:
    """Bump the consecutive-failure count for `name`; returns the new count."""
    health = state["_meta"].setdefault("source_health", {})
    e = health.setdefault(name, {"consecutive_failures": 0,
                                 "first_failure": today.isoformat(),
                                 "alerted_for": []})
    e["consecutive_failures"] += 1
    e["last_error"] = str(error)[:300]
    return e["consecutive_failures"]


def record_source_success(state: dict, name: str) -> None:
    state["_meta"].setdefault("source_health", {}).pop(name, None)


def unhealthy_sources(state: dict,
                      threshold: int = HEALTH_ALERT_AFTER) -> dict[str, dict]:
    """{source_name: health entry} for sources at/over the alert threshold."""
    health = state["_meta"].get("source_health", {})
    return {n: e for n, e in health.items()
            if e.get("consecutive_failures", 0) >= threshold}


def health_warning_lines(state: dict,
                         threshold: int = HEALTH_ALERT_AFTER) -> list[str]:
    return [f"source '{n}' has failed {e['consecutive_failures']} consecutive "
            f"runs (since {e.get('first_failure', '?')}): "
            f"{e.get('last_error', 'unknown error')}"
            for n, e in sorted(unhealthy_sources(state, threshold).items())]


def health_alert_needed(state: dict, user: str,
                        threshold: int = HEALTH_ALERT_AFTER) -> bool:
    """True if some unhealthy source hasn't been alerted to `user` yet."""
    return any(user not in e.get("alerted_for", [])
               for e in unhealthy_sources(state, threshold).values())


def mark_health_alerted(state: dict, user: str,
                        threshold: int = HEALTH_ALERT_AFTER) -> None:
    for e in unhealthy_sources(state, threshold).values():
        if user not in e.setdefault("alerted_for", []):
            e["alerted_for"].append(user)


# Email outbox: accepted matches accumulate here (display-ready snapshots,
# so a job can be emailed even after it rotates out of the sources) and are
# flushed at the user's configured send slots.

def outbox_add(state: dict, user: str, item: dict) -> bool:
    """Append a match snapshot. Idempotent by dedup key. Returns True if added."""
    box = state["outbox"].setdefault(user, [])
    if any(existing.get("key") == item.get("key") for existing in box):
        return False
    box.append(item)
    return True


def outbox_items(state: dict, user: str) -> list[dict]:
    return list(state["outbox"].get(user, []))


def outbox_clear(state: dict, user: str) -> None:
    state["outbox"].pop(user, None)


# Match history: every accepted job, as a display-ready snapshot, feeding the
# per-user dashboard issue. Unlike the outbox these survive delivery; they age
# out with the normal prune window. "applied" is synced back from the
# dashboard issue's checkboxes.

def matches_add(state: dict, user: str, item: dict) -> bool:
    """Append a match snapshot. Idempotent by dedup key. Returns True if added."""
    box = state["matches"].setdefault(user, [])
    if any(existing.get("key") == item.get("key") for existing in box):
        return False
    box.append(item)
    return True


def matches_items(state: dict, user: str) -> list[dict]:
    return list(state["matches"].get(user, []))


def matches_set_applied(state: dict, user: str, checked: set[str],
                        rendered: set[str]) -> None:
    """Sync checkbox state read from the dashboard issue. Only matches that
    were actually rendered on the issue (`rendered`) are updated, so a
    truncated dashboard can't silently un-apply older matches."""
    for item in state["matches"].get(user, []):
        key = item.get("key")
        if key in rendered:
            item["applied"] = key in checked


def matches_set_saved(state: dict, user: str, saved: set[str],
                      rendered: set[str]) -> None:
    """Sync save-box (bookmark) state read from the dashboard issue. Same
    rendered-only rule as matches_set_applied; unlike `dismissed`, plain
    boolean with no side effect on the row's position."""
    for item in state["matches"].get(user, []):
        key = item.get("key")
        if key in rendered:
            item["saved"] = key in saved


def matches_set_dismissed(state: dict, user: str, hidden: set[str],
                          rendered: set[str]) -> None:
    """Sync hide-box state read from the dashboard issue (same rendered-only
    rule as matches_set_applied). Flags are stored sparsely: absent means
    active, so pre-existing match items need no migration. Restoring a
    dismissed row leaves a `restored` marker so the stale-row auto-hide
    (dashboard.auto_dismiss_stale) never re-hides a deliberate restore."""
    for item in state["matches"].get(user, []):
        key = item.get("key")
        if key not in rendered:
            continue
        if key in hidden:
            item["dismissed"] = True
            item.pop("restored", None)
        elif item.pop("dismissed", None):
            item["restored"] = True


# Content-duplicate suppression: a per-user map of content signature ->
# {first, last delivery date, keys delivered/suppressed under it}. Distinct
# from "jobs" (keyed by dedup_key) -- this collapses the many dedup_keys that
# jobright mints for one real posting. See src/content_dedup.py.

def content_seen(state: dict, user: str, sig: str, today: dt.date,
                 window_days: int) -> bool:
    """True if `sig` was delivered to `user` within `window_days` of today."""
    rec = state.get("content", {}).get(user, {}).get(sig)
    if not rec:
        return False
    last = rec.get("last") or rec.get("first")
    if not last:
        return False
    return (today - dt.date.fromisoformat(last)).days <= window_days


def content_mark(state: dict, user: str, sig: str, key: str,
                 today: dt.date) -> None:
    """Record that `key` carried content `sig` for `user` today (refreshing the
    window). `keys[0]` is the first key ever delivered under the signature."""
    bucket = state.setdefault("content", {}).setdefault(user, {})
    iso = today.isoformat()
    rec = bucket.get(sig)
    if rec is None:
        bucket[sig] = {"first": iso, "last": iso, "keys": [key]}
    else:
        rec["last"] = iso
        keys = rec.setdefault("keys", [])
        if key not in keys:
            keys.append(key)


def content_keys(state: dict, user: str, sig: str) -> list[str]:
    return list(state.get("content", {}).get(user, {}).get(sig, {})
                .get("keys", []))


def get_last_email(state: dict, user: str) -> str | None:
    return state["last_email"].get(user)


def set_last_email(state: dict, user: str, now: dt.datetime) -> None:
    state["last_email"][user] = now.isoformat()


def email_due(last_email_iso: str | None, send_hours: list[int],
              now: dt.datetime, tz: dt.tzinfo | None = None) -> bool:
    """True if a send slot has passed since the last email. Slots are the given
    hours interpreted in `tz` (default UTC); slot-based rather than hour-equality
    so a delayed Actions run still sends (an 8:00 slot is honored by a run at
    8:25 if nothing was sent in between). With a local `tz` the slots are built
    from local wall-clock hours, so each slot's UTC offset is recomputed per
    season and the send stays at a fixed local time across the DST change."""
    if not send_hours:
        return False
    tz = tz or dt.timezone.utc
    local_today = now.astimezone(tz).date()
    slots = [dt.datetime.combine(local_today - dt.timedelta(days=d),
                                 dt.time(h), tzinfo=tz)
             for d in (0, 1) for h in sorted(set(send_hours))]
    past = [s for s in slots if s <= now]
    if not past:
        return False
    latest_slot = max(past)
    if last_email_iso is None:
        return True
    return dt.datetime.fromisoformat(last_email_iso) < latest_slot


def prune(state: dict, today: dt.date, keep_days: int = PRUNE_AFTER_DAYS) -> int:
    """Drop entries not seen in any source for `keep_days`. Pruning on
    last_seen (not first_seen) so a long-lived active posting never gets
    pruned and re-notified."""
    cutoff = (today - dt.timedelta(days=keep_days)).isoformat()
    jobs = state["jobs"]
    stale = [k for k, v in jobs.items()
             if v.get("last_seen", v.get("first_seen", "")) < cutoff]
    for k in stale:
        del jobs[k]
    companies = state.get("companies", {})
    for k in [k for k, v in companies.items() if v.get("judged", "") < cutoff]:
        del companies[k]  # re-judged on next ambiguous job from that employer
    for user, items in state.get("matches", {}).items():
        state["matches"][user] = [i for i in items
                                  if i.get("added", "") >= cutoff]
    for user, sigs in state.get("content", {}).items():
        state["content"][user] = {
            s: r for s, r in sigs.items()
            if (r.get("last") or r.get("first", "")) >= cutoff}
    if stale:
        log.info("pruned %d stale state entries", len(stale))
    return len(stale)
