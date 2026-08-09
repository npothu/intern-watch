"""Batch resume build from the dashboard 'Build selected resumes' trigger.

Each match row on the dashboard issue carries a '📄 build resume' checkbox; the
top of the issue carries a single 'Build selected resumes' trigger box. When the
user ticks some rows and then ticks the trigger, the `resume-batch` workflow
runs this CLI with the edited issue body in $ISSUE_BODY (or --body <file>):

  python -m src.resume.batch --user <watcher-user> --summary /tmp/comment.md

It builds a tailored .docx for every ticked row that hasn't been built yet
(commit mode -> resumes/<user>/), records the repo-relative path on the match
item so the dashboard renders a link that survives the next rewrite, and saves
state. The workflow then commits resumes/ + seen.json and repaints the issue.

Like the `/resume` on-demand path, this honours an explicit click regardless of
`resume_build.enabled` (that flag only gates the watcher's automatic builds);
only `use_llm` / `allow_scrape` / `max_per_run` are read from the user's config.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .. import dashboard
from .. import state as st
from ..models import Job
from ..store import make_store
from .build import ROOT, build_for_job, resume_build_cfg


def _selected_unbuilt(state: dict, user: str,
                      body: str) -> list[tuple[dict, str]]:
    """(item, short) for rows whose build box is ticked and not yet built.
    Already-built rows (item has a `resume` path) are skipped -- that's how
    'build the ones not previously built' falls out for free."""
    selected = dashboard.parse_build_selections(body)
    todo = []
    for item in st.matches_items(state, user):
        key = item.get("key")
        if not key:
            continue
        short = dashboard.short_key(key)
        if short in selected and not item.get("resume"):
            todo.append((item, short))
    return todo


def _gh_output(**values: object) -> None:
    """Append key=value lines to $GITHUB_OUTPUT when running under Actions."""
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as fh:
        for key, value in values.items():
            fh.write(f"{key}={value}\n")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m src.resume.batch",
                                 description=__doc__)
    ap.add_argument("--user", required=True,
                    help="watcher user (from the dashboard issue title)")
    ap.add_argument("--body", default="",
                    help="path to the edited issue body; defaults to $ISSUE_BODY")
    ap.add_argument("--summary", default="",
                    help="path to write a markdown summary comment to")
    ap.add_argument("--root", default=str(ROOT),
                    help="repo root (override for tests)")
    args = ap.parse_args(argv)
    root = Path(args.root)

    body = ""
    if args.body and Path(args.body).exists():
        body = Path(args.body).read_text(encoding="utf-8", errors="replace")
    if not body:
        body = os.environ.get("ISSUE_BODY", "")

    if not dashboard.build_trigger_checked(body):
        print("trigger box not ticked; nothing to build", file=sys.stderr)
        _gh_output(built=0, failed=0)
        return 0

    from ..filters import load_users
    users = {u["name"]: u for u in load_users(root / "users")}
    cfg = resume_build_cfg(users.get(args.user))

    state_path = root / "state" / "seen.json"
    state = st.load_state(state_path)
    todo = _selected_unbuilt(state, args.user, body)
    if not todo:
        print("no unbuilt rows selected; nothing to build", file=sys.stderr)
        _gh_output(built=0, failed=0)
        return 0

    store = make_store(root, users.get(args.user) or {"name": args.user})
    # Build into a gitignored scratch dir; the STORE owns where the .docx
    # finally lands (GitHub: resumes/<user>/, committed by the workflow as
    # ever; Convex: file storage, so the commit step finds nothing new).
    out_dir = root / "out" / "batch" / args.user
    out_dir.mkdir(parents=True, exist_ok=True)
    built: list[str] = []
    failed: list[tuple[str, str]] = []
    cap = int(cfg["max_per_run"])
    for i, (item, short) in enumerate(todo):
        if i >= cap:
            print(f"build cap ({cap}) reached; deferring {len(todo) - cap} "
                  "row(s) to a later click", file=sys.stderr)
            break
        job = Job(company=item.get("company", ""), title=item.get("title", ""),
                  url=item.get("url", ""), source="dashboard",
                  dedup_key=item["key"], jobright_id=item.get("jobright_id"),
                  jd_url=item.get("jd_url"))
        try:
            result = build_for_job(job, args.user, out_dir=out_dir, root=root,
                                   use_llm=cfg["use_llm"],
                                   allow_scrape=cfg["allow_scrape"])
        except Exception as exc:  # noqa: BLE001 - one build never blocks the rest
            failed.append((short, f"{item.get('company', '?')}: {exc}"))
            continue
        if result is None:
            failed.append((short, f"{item.get('company', '?')}: no JD found "
                           "(site may block scraping — use /resume with the JD "
                           "pasted)"))
            continue
        item["resume"] = store.put_resume(
            args.user, short, result.out_path.name, result.out_path.read_bytes())
        built.append(f"{item['company']} — {item['title']}")
        print(f"BUILT {short} {item['company']}")

    st.save_state(state, state_path)

    if args.summary:
        lines = []
        if built:
            lines.append(f"📄 **Built {len(built)} resume(s)** — links appear on "
                         "the rows once this run finishes:")
            lines += [f"- {b}" for b in built]
        if failed:
            lines.append("")
            lines.append(f"⚠️ **{len(failed)} couldn't build:**")
            lines += [f"- `{s}` — {why}" for s, why in failed]
        if not lines:
            lines.append("Nothing to build — the selected rows were already "
                         "built.")
        Path(args.summary).write_text("\n".join(lines) + "\n", encoding="utf-8")

    _gh_output(built=len(built), failed=len(failed))
    for short, why in failed:
        print(f"FAIL {short} {why}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
