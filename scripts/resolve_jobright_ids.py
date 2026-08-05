"""Retroactive jobright -> employer apply-url resolution helper.

Mirrors the cron's match-time resolution (src/main.py:_resolve_employer_urls
via src/adapters/jobright_auth.py:JobrightSession.resolve_apply_url) but runs
backwards over already-saved matches: given a list of 24-hex jobright ids, it
resolves each to its real employer apply url and writes a JSON map of
{id: resolved_url_or_null} to the output path.

Usage:
    python scripts/resolve_jobright_ids.py <ids.json|comma,list> <out.json> [cap]

Intended to be fanned out across parallel worker agents on disjoint slices of
ids; the caller merges the per-slice maps afterward. Fails open exactly like
the cron: an unresolvable / non-employer url resolves to null.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def load_env(path: Path) -> dict:
    """Parse .env safely in python (shell sourcing can mangle `!`/`&`)."""
    env: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip()
    return env


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    ids_arg, out_path = argv[0], argv[1]
    cap = int(argv[2]) if len(argv) > 2 else None

    if os.path.exists(ids_arg):
        ids = list(dict.fromkeys(json.loads(Path(ids_arg).read_text())))
    else:
        ids = list(dict.fromkeys(x.strip() for x in ids_arg.split(",") if x.strip()))

    if not ids:
        Path(out_path).write_text("{}\n", newline="\n")
        print("no ids, empty result")
        return 0

    env = load_env(ROOT / ".env")
    email = env.get("JOBRIGHT_EMAIL")
    password = env.get("JOBRIGHT_PASSWORD")
    if not email or not password:
        print("missing JOBRIGHT_EMAIL/JOBRIGHT_PASSWORD in .env", file=sys.stderr)
        return 1

    from src.adapters.jobright_auth import JobrightSession

    session = JobrightSession(email, password, cap=cap or max(25, len(ids) * 2))
    result: dict[str, str | None] = {}
    try:
        for jid in ids:
            result[jid] = session.resolve_apply_url(jid)
    finally:
        session.close()

    Path(out_path).write_text(
        json.dumps(result, indent=2) + "\n", newline="\n"
    )

    resolved = sum(1 for v in result.values() if v)
    print(f"resolved {resolved}/{len(ids)} ids -> {out_path}")
    if session.auth_failed_msg:
        print(session.auth_failed_msg, file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
