"""On-demand resume build for the dashboard mode.

    python -m src.resume.ondemand --user <watcher-user> --short <12-hex>

The dashboard issue links each match by its 12-hex `short_key` (an HTML
comment dedup keys can't safely contain). A `/resume <short>` comment triggers
the `resume-ondemand` workflow, which runs this CLI: it loads state, finds the
match item whose `short_key(key)` equals `--short`, reconstructs a minimal
`Job` from the stored snapshot, and reacquires the JD (the source row may have
rotated out long ago, so we keep `jobright_id`/`jd_url` for exactly this).

A `--jd` file (the comment body below the `/resume` line) is used verbatim when
present, the escape hatch for employers that block scraping (e.g. Tesla 403s
every non-browser request, so no scraper can reach the JD).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .. import dashboard, state as st
from ..models import Job
from .build import ROOT, build_for_job


def _find_item(state: dict, user: str, short: str) -> dict | None:
    """Match item whose dedup key hashes to `short`, or None. We rehash each
    stored key rather than persist the short key so the lookup always tracks
    `dashboard.short_key` if its hashing ever changes."""
    for item in st.matches_items(state, user):
        key = item.get("key")
        if key and dashboard.short_key(key) == short:
            return item
    return None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m src.resume.ondemand",
                                 description=__doc__)
    ap.add_argument("--user", required=True,
                    help="watcher user (from the dashboard issue title)")
    ap.add_argument("--short", required=True,
                    help="12-hex dashboard short key of the match")
    ap.add_argument("--jd", default="",
                    help="path to a pasted-JD file; used verbatim when "
                         "non-empty, bypassing acquisition (for blocked sites)")
    args = ap.parse_args(argv)

    pasted = ""
    if args.jd:
        jd_path = Path(args.jd)
        if jd_path.exists():
            pasted = jd_path.read_text(encoding="utf-8", errors="replace").strip()

    state = st.load_state(ROOT / "state" / "seen.json")
    item = _find_item(state, args.user, args.short)
    if item is None:
        print(f"no match found for short key {args.short!r} "
              f"(user {args.user})", file=sys.stderr)
        return 1

    # Reconstruct just enough of the Job for JD reacquisition + filename.
    # `dedup_key` must round-trip so the output subdir matches the short key.
    job = Job(company=item.get("company", ""), title=item.get("title", ""),
              url=item.get("url", ""), source="dashboard",
              dedup_key=item["key"], jobright_id=item.get("jobright_id"),
              jd_url=item.get("jd_url"))

    result = build_for_job(job, args.user, out_dir=Path("out"), root=ROOT,
                           allow_scrape=True, jd_text=pasted or None)
    if result is None:
        print(f"no JD found for {job.company} — {job.title}; nothing built. "
              "Re-comment with the JD pasted below the /resume line.",
              file=sys.stderr)
        return 1

    print(result.out_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
