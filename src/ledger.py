"""state/applications.json: the permanent application ledger.

seen.json is a pipeline cache and prunes after 120 days -- applied flags
included. This file is the opposite: one record per application, created
the moment a job is marked applied (issue tick, webui toggle, or
dashboard-write), enriched with tracker statuses, and NEVER pruned. The
full display snapshot is copied in at apply time so the record outlives
the match itself. Committed to git like seen.json, so history, backup,
and sync come for free.

Records are keyed by the dashboard 12-hex short key (the stable UI
handle); the full dedup key is kept inside the record for traceability.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
from pathlib import Path

from . import dashboard
from . import state as st

log = logging.getLogger(__name__)

# Tracker pipeline, as picked in the plan review (2026-07-02). "Ghosted" is
# deliberately absent: it is auto-detected from inactivity, never set.
STATUSES = ("applied", "oa", "phone_screen", "interview", "offer",
            "rejected", "withdrawn")

_SNAPSHOT_FIELDS = ("key", "company", "title", "url", "location", "term",
                    "salary", "tag", "added", "jobright_id", "jd_url",
                    "resume")


def ledger_path(root: Path) -> Path:
    return root / "state" / "applications.json"


def load_ledger(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def save_ledger(ledger: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(ledger, indent=1, sort_keys=True) + "\n",
                    encoding="utf-8")


def record_applied(ledger: dict, user: str, item: dict,
                   today: dt.date) -> dict | None:
    """Create the application record for a match marked applied. Idempotent:
    an existing record is returned untouched (re-ticking a box must not
    reset a progressed status or duplicate history)."""
    short = dashboard.short_key(item["key"])
    book = ledger.setdefault(user, {})
    if short in book:
        return None
    record = {f: item[f] for f in _SNAPSHOT_FIELDS
              if item.get(f) is not None}
    record.update({"applied": today.isoformat(), "status": "applied",
                   "history": [{"on": today.isoformat(),
                                "status": "applied"}]})
    book[short] = record
    return record


def remove_if_unprogressed(ledger: dict, user: str, short: str) -> bool:
    """Drop a record after its applied tick was undone -- but only while it
    never progressed past the initial 'applied' entry. A record with real
    tracker history survives a stray untick."""
    book = ledger.get(user, {})
    rec = book.get(short)
    if rec and rec.get("status") == "applied" \
            and len(rec.get("history", [])) <= 1:
        del book[short]
        return True
    return False


def set_status(ledger: dict, user: str, short: str, status: str,
               today: dt.date, note: str = "") -> dict | None:
    """Advance a record's tracker status (+ optional note). Returns the
    record, or None when it does not exist. Repeating the current status
    without a note is a no-op rather than history spam."""
    if status not in STATUSES:
        raise ValueError(f"unknown status {status!r} (have: "
                         f"{', '.join(STATUSES)})")
    rec = ledger.get(user, {}).get(short)
    if rec is None:
        return None
    if status == rec.get("status") and not note:
        return rec
    entry: dict = {"on": today.isoformat(), "status": status}
    if note:
        entry["note"] = note
    rec.setdefault("history", []).append(entry)
    rec["status"] = status
    return rec


def sync_records(ledger: dict, user: str, matches: list[dict],
                 today: dt.date) -> bool:
    """Mirror the applied booleans from match items into the ledger: new
    applied matches get records (this also backfills the ledger on its very
    first run), unticked ones are dropped under the unprogressed-only rule.
    Returns True when the ledger changed."""
    changed = False
    for item in matches:
        key = item.get("key")
        if not key:
            continue
        if item.get("applied"):
            if record_applied(ledger, user, item, today):
                changed = True
        elif remove_if_unprogressed(ledger, user, dashboard.short_key(key)):
            changed = True
    return changed


def sync_file(state: dict, user: str, path: Path, today: dt.date) -> bool:
    """Load-sync-save wrapper used by the watcher and dashboard-write runs.
    Returns True when the file was rewritten."""
    ledger = load_ledger(path)
    if not sync_records(ledger, user, st.matches_items(state, user), today):
        return False
    save_ledger(ledger, path)
    n = len(ledger.get(user, {}))
    log.info("user %s: applications ledger updated (%d record(s))", user, n)
    return True
