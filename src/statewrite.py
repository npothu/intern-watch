"""CLI: set one dashboard field on one match, directly in state.

    python -m src.statewrite --user example --short <12-hex> \
        --field applied|dismissed --value true|false
    python -m src.statewrite --user example --short <12-hex> \
        --field status --value oa [--note "HackerRank, due 7/14"]

The dashboard issue can only render the newest rows (byte-budgeted), so
older matches have no checkbox to write through -- this CLI is the other
half of that protocol: the `dashboard-write` workflow runs it inside
Actions (the only committer of state on main) when the webui dispatches a
write.

Semantics mirror the issue read-back exactly:
- applied: plain boolean on the match (the ledger record follows via the
  normal sync in the workflow's repaint step).
- saved: plain boolean bookmark on the match, no side effects.
- dismissed true: hide (clears any `restored` marker).
- dismissed false: restore AND set the `restored` marker, so the stale-row
  auto-hide never re-hides a deliberate restore.
- status: tracker status on the applications-ledger record (+ optional
  note). A status on a never-applied match implies applied: the match is
  ticked and a ledger record is created first.
"""

from __future__ import annotations

import argparse
import datetime as dt
import sys
from pathlib import Path

from . import dashboard, ledger
from . import state as st
from .paths import DATA_ROOT as DATA_ROOT


def _find_match(state: dict, user: str, short: str) -> dict | None:
    for item in state.get("matches", {}).get(user, []):
        key = item.get("key", "")
        if key and dashboard.short_key(key) == short:
            return item
    return None


def apply_write(state: dict, user: str, short: str, field: str,
                value: bool) -> dict | None:
    """Set a boolean `field` on the match whose key hashes to `short`.
    Returns the updated item, or None when no such match exists."""
    item = _find_match(state, user, short)
    if item is None:
        return None

    if field == "applied":
        item["applied"] = value
    elif field == "saved":
        item["saved"] = value
    elif value:  # dismissed = true
        item["dismissed"] = True
        item.pop("restored", None)
    else:        # dismissed = false -> deliberate restore, sweep-exempt
        item.pop("dismissed", None)
        item["restored"] = True
    return item


def apply_status(state: dict, led: dict, user: str, short: str,
                 status: str, note: str, today: dt.date) -> dict | None:
    """Set a tracker status on the ledger record, creating it (and ticking
    the match applied -- a status implies an application) when the record
    does not exist yet. Returns the record, or None when neither a record
    nor a match exists."""
    rec = ledger.set_status(led, user, short, status, today, note)
    if rec is not None:
        return rec
    item = _find_match(state, user, short)
    if item is None:
        return None
    item["applied"] = True
    ledger.record_applied(led, user, item, today)
    return ledger.set_status(led, user, short, status, today, note)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m src.statewrite",
                                 description=__doc__)
    ap.add_argument("--user", required=True)
    ap.add_argument("--short", required=True,
                    help="12-hex dashboard short key of the match")
    ap.add_argument("--field", required=True,
                    choices=("applied", "saved", "dismissed", "status"))
    ap.add_argument("--value", required=True,
                    help="true/false, or a status name for --field status")
    ap.add_argument("--note", default="",
                    help="history note (only with --field status)")
    ap.add_argument("--state", default=str(DATA_ROOT / "state" / "seen.json"),
                    help="state file path (tests)")
    ap.add_argument("--ledger", default=str(ledger.ledger_path(DATA_ROOT)),
                    help="applications ledger path (tests)")
    args = ap.parse_args(argv)

    path = Path(args.state)
    state = st.load_state(path)
    today = dt.date.today()

    if args.field == "status":
        if args.value not in ledger.STATUSES:
            print(f"unknown status {args.value!r} (have: "
                  f"{', '.join(ledger.STATUSES)})", file=sys.stderr)
            return 1
        lpath = Path(args.ledger)
        led = ledger.load_ledger(lpath)
        rec = apply_status(state, led, args.user, args.short, args.value,
                           args.note, today)
        if rec is None:
            print(f"no application or match with short key {args.short!r} "
                  f"for user {args.user!r}", file=sys.stderr)
            return 1
        ledger.save_ledger(led, lpath)
        st.save_state(state, path)  # may have gained the implied applied tick
        print(f"{args.user}/{args.short}: status = {args.value} "
              f"({rec.get('company', '?')} — {rec.get('title', '?')})")
        return 0

    if args.value not in ("true", "false"):
        print("--value must be true or false for boolean fields",
              file=sys.stderr)
        return 1
    item = apply_write(state, args.user, args.short, args.field,
                       args.value == "true")
    if item is None:
        print(f"no match with short key {args.short!r} for user "
              f"{args.user!r}", file=sys.stderr)
        return 1
    st.save_state(state, path)
    print(f"{args.user}/{args.short}: {args.field} = {args.value} "
          f"({item.get('company', '?')} — {item.get('title', '?')})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
