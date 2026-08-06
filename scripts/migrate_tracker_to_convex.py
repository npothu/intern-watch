"""One-time backfill: copy the current tracker state (ticks, the applications
ledger, and the match snapshot) from the GitHub-based source of truth into a
Convex deployment, so STORE=convex can take over.

    python scripts/migrate_tracker_to_convex.py --dry-run
    python scripts/migrate_tracker_to_convex.py [--user example]

Reads:
- the tick flags (applied/saved/dismissed) off the match items in
  state/seen.json on origin/main - the folded authority, since the issue
  read-back is already applied there each run (falls back to the local
  checkout). The issue itself is read only for an informational count.
- the applications ledger via the GitHubStore (origin/main first, local
  fallback).

Writes (idempotent upserts, safe to re-run):
- set_ticks: one tick row per match carrying at least one ticked flag.
- record_status: replay each ledger record's history oldest-first so Convex's
  history mirrors the ledger, carrying the display snapshot each time.
- push_matches: the current match snapshot (already chunked by the driver).

Needs CONVEX_URL + CONVEX_SECRET (equal to the deployment's TRACKER_SECRET)
env vars unless --dry-run, which only prints what would be written.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src import dashboard, ledger, state as st, store  # noqa: E402
from src.store import TickWrite                       # noqa: E402


def _state_on_main(root: Path) -> dict:
    """origin/main state/seen.json, the local checkout as fallback."""
    try:
        return json.loads(
            store._git(root, "show", "origin/main:state/seen.json"))
    except (OSError, subprocess.CalledProcessError, ValueError):
        # any git failure (not a repo / offline) falls back to the checkout
        return st.load_state(root / "state" / "seen.json")


def _users(root: Path, want: str) -> tuple[list[str], dict]:
    """Users to migrate: anyone present in state's matches OR the ledger (a
    ledger-only user whose matches pruned still gets its records back), so a
    --user filter can target one of them."""
    state = _state_on_main(root)
    books = ledger.load_ledger(ledger.ledger_path(root))
    names = sorted(set(state.get("matches", {})) | set(books))
    if want:
        names = [n for n in names if n == want]
    return names, state


def _tick_writes(items: list[dict]) -> list[TickWrite]:
    """One write per truthy flag on a match item (applied/saved/dismissed).
    seen.json stores these sparsely, so an all-false item simply has nothing
    to persist."""
    writes: list[TickWrite] = []
    for item in items:
        key = item.get("key")
        if not key:
            continue
        short = dashboard.short_key(key)
        for field in ("applied", "saved", "dismissed"):
            if item.get(field):
                writes.append(TickWrite(short, field, True))
    return writes


def _snapshot(rec: dict) -> dict:
    """The display fields to carry as the Convex record's `snapshot`: the
    record minus its synthetic status/history/note keys (its `applied` date
    is kept so get_ledger restores the original apply date, not the migration
    timestamp)."""
    return {k: v for k, v in rec.items()
            if k not in ("status", "history", "note")}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="scripts/migrate_tracker_to_convex.py",
                                 description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="print what would be written; make no Convex calls")
    ap.add_argument("--user", default="",
                    help="migrate only this user (default: everyone found in "
                         "state/ledger)")
    ap.add_argument("--root", default=str(ROOT),
                    help="repo root for state files (tests)")
    args = ap.parse_args(argv)

    root = Path(args.root).expanduser().resolve()
    names, state = _users(root, args.user)
    if not names:
        print("no users with matches or ledger records to migrate")
        return 0

    # Build the plan (reads state + ledger; no writes yet).
    plan = []
    for name in names:
        gs = store.GitHubStore(root, {"name": name})
        ticks = gs.get_ticks(name)          # informational issue read-back
        book = gs.get_ledger(name)          # ledger records (origin first)
        items = st.matches_items(state, name)
        writes = _tick_writes(items)
        history = {short: (rec.get("history") or [])
                   for short, rec in book.items()}
        n_history = sum(len(h) for h in history.values())
        plan.append({"user": name, "ticks": ticks,
                     "writes": len(writes), "book": len(book),
                     "n_history": n_history, "matches": len(items),
                     "items": items, "tick_writes": writes,
                     "ledger_records": book})
        print(f"[{name}] ticks: {len(writes)} tick write(s) "
              f"(issue renders {len(ticks.present) if ticks else 0}) · "
              f"ledger: {len(book)} record(s) / {n_history} history "
              f"entr(y/ies) · matches: {len(items)}")

    tot_w, tot_r, tot_h, tot_m = (
        sum(p["writes"] for p in plan), sum(p["book"] for p in plan),
        sum(p["n_history"] for p in plan), sum(p["matches"] for p in plan))
    if args.dry_run:
        print(f"SUMMARY (dry run, nothing written): {len(plan)} user(s) · "
              f"{tot_w} tick writes · {tot_r} ledger records "
              f"({tot_h} history replays) · {tot_m} matches")
        return 0

    for p in plan:
        conv = store.ConvexStore(root, {"name": p["user"]})
        if p["tick_writes"]:
            conv.set_ticks(p["user"], p["tick_writes"])
        for short, rec in sorted(p["ledger_records"].items()):
            snapshot = _snapshot(rec)
            for entry in rec.get("history") or []:
                conv.record_status(p["user"], short, entry.get("status", ""),
                                   note=entry.get("note", ""), snapshot=snapshot)
        if p["items"]:
            conv.push_matches(p["user"], p["items"])
    print(f"SUMMARY: migrated {len(plan)} user(s) · {tot_w} tick writes · "
          f"{tot_r} ledger records ({tot_h} history replays) · "
          f"{tot_m} matches")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())