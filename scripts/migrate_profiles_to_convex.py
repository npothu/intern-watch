"""One-time backfill: copy each user's resume profile (bank) JSON from the
repo (`users/<user>_resume.json`) into a Convex deployment's `profiles`
table, so the Convex-native resume builder can compose a tailored .docx
without reading the repo during a build.

    python scripts/migrate_profiles_to_convex.py --dry-run
    python scripts/migrate_profiles_to_convex.py [--user example]

Reads:
- one profile per user: `users/<user>_resume.json` (the same file the
  Python pipeline's build.py reads from `users/*_resume.json`).

Writes (idempotent upserts - safe to re-run):
- put_profile: upserts the profile's `data` keyed by user, updating
  `updatedAt`. Re-running just re-pushes the same file.

Needs CONVEX_URL + CONVEX_SECRET (equal to the deployment's TRACKER_SECRET)
env vars unless --dry-run, which only prints what would be written.
Loads .env like every other local entrypoint (src.envfile.load_dotenv), so
these can come from the repo's .env instead of the shell environment.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src import store  # noqa: E402
from src.envfile import load_dotenv  # noqa: E402


def _profiles(root: Path, want: str) -> list[tuple[str, Path]]:
    """(user, profile path) pairs for every users/*_resume.json, optionally
    filtered to one user."""
    banks = sorted((root / "users").glob("*_resume.json"),
                   key=lambda p: p.name.lower())
    pairs = [(p.name.removesuffix("_resume.json"), p) for p in banks]
    if want:
        pairs = [(u, p) for u, p in pairs if u == want]
    return pairs


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="scripts/migrate_profiles_to_convex.py",
                                 description=__doc__)
    ap.add_argument("--dry-run", action="store_true",
                    help="print what would be written; make no Convex calls")
    ap.add_argument("--user", default="",
                    help="migrate only this user (default: everyone with a "
                         "users/*_resume.json)")
    ap.add_argument("--root", default=str(ROOT),
                    help="repo root for profile files (tests)")
    args = ap.parse_args(argv)

    # Local-only: pick up CONVEX_URL/CONVEX_SECRET from the gitignored .env
    # like every other local entrypoint. No-op in Actions (no .env file).
    load_dotenv()

    root = Path(args.root).expanduser().resolve()
    profiles = _profiles(root, args.user)
    if not profiles:
        print("no users/*_resume.json profile(s) to migrate")
        return 0

    for user, path in profiles:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            print(f"[{user}] ERROR reading {path}: {exc}")
            return 1

    if args.dry_run:
        for user, path in profiles:
            print(f"[{user}] put_profile from {path.name} "
                  f"({path.stat().st_size} bytes) - dry run, not written")
        print(f"SUMMARY (dry run, nothing written): "
              f"{len(profiles)} profile(s)")
        return 0

    for user, path in profiles:
        data = json.loads(path.read_text(encoding="utf-8"))
        conv = store.ConvexStore(root, {"name": user})
        conv.put_profile(user, data)
        print(f"[{user}] put_profile <- {path.name}")
    print(f"SUMMARY: migrated {len(profiles)} profile(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
