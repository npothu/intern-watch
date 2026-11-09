"""Rename a watcher user key inside the data repo's state/ JSON files.

Companion to convex/migrations.ts:renameUser for the Python-side state the
watcher commits to the data repo. Dry run by default; pass --write to save.

    python scripts/rename_state_user.py --data-dir ../autojobfinder --from nathan --delete
    python scripts/rename_state_user.py --data-dir ../autojobfinder --from example --to nathan
    ... --write

Refuses if `--to` already appears anywhere `--from` would be moved to (move an
old target aside first, as above). After renaming, it re-walks both files and
fails if the old key is still present as a dict key or list item.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

USER_KEY = re.compile(r"^[a-zA-Z0-9_-]{1,100}$")

# seen.json top-level dicts keyed by user.
SEEN_USER_DICTS = ("matches", "content", "outbox", "last_email")


class Collision(Exception):
    pass


def _move_key(d: dict, src: str, dst: str, where: str, report: list[str]) -> None:
    if src not in d:
        return
    if dst in d:
        raise Collision(f"{where}: '{dst}' already present")
    # Preserve key order so diffs stay small.
    items = [(dst if k == src else k, v) for k, v in d.items()]
    d.clear()
    d.update(items)
    report.append(where)


def _move_list(lst: list, src: str, dst: str) -> bool:
    if src not in lst:
        return False
    out = []
    for x in lst:
        x = dst if x == src else x
        if x not in out:
            out.append(x)
    lst[:] = out
    return True


def rename_seen(seen: dict, src: str, dst: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    report: list[str] = []
    meta = seen.setdefault("_meta", {})
    _move_key(meta.get("dashboard_issue", {}), src, dst, "_meta.dashboard_issue", report)
    if _move_list(meta.get("crossdedup_done", []), src, dst):
        report.append("_meta.crossdedup_done")
    for name in SEEN_USER_DICTS:
        _move_key(seen.get(name, {}), src, dst, name, report)
    for c in seen.get("companies", {}).values():
        if isinstance(c, dict) and isinstance(c.get("top"), dict):
            before = len(report)
            _move_key(c["top"], src, dst, "companies.*.top", report)
            counts["companies.*.top"] = counts.get("companies.*.top", 0) + (len(report) - before)
        if isinstance(c, dict) and isinstance(c.get("judged_by"), dict):
            before = len(report)
            _move_key(c["judged_by"], src, dst, "companies.*.judged_by", report)
            counts["companies.*.judged_by"] = (counts.get("companies.*.judged_by", 0)
                                               + (len(report) - before))
    for j in seen.get("jobs", {}).values():
        if not isinstance(j, dict):
            continue
        if isinstance(j.get("notified_for"), list) and _move_list(j["notified_for"], src, dst):
            counts["jobs.*.notified_for"] = counts.get("jobs.*.notified_for", 0) + 1
        if isinstance(j.get("llm_top"), dict):
            before = len(report)
            _move_key(j["llm_top"], src, dst, "jobs.*.llm_top", report)
            counts["jobs.*.llm_top"] = counts.get("jobs.*.llm_top", 0) + (len(report) - before)
    for r in report:
        if not r.endswith((".top", "llm_top", ".judged_by")):
            counts[r] = counts.get(r, 0) + 1
    return counts


def rename_applications(apps: dict, src: str, dst: str) -> dict[str, int]:
    report: list[str] = []
    _move_key(apps, src, dst, "applications", report)
    return {"applications": len(apps.get(dst, {}))} if report else {}


def delete_user(seen: dict, apps: dict, user: str) -> dict[str, int]:
    """Remove every trace of `user` from the user-keyed places rename touches."""
    counts: dict[str, int] = {}

    def bump(k: str) -> None:
        counts[k] = counts.get(k, 0) + 1

    if apps.pop(user, None) is not None:
        bump("applications")
    meta = seen.get("_meta", {})
    if meta.get("dashboard_issue", {}).pop(user, None) is not None:
        bump("_meta.dashboard_issue")
    if user in meta.get("crossdedup_done", []):
        meta["crossdedup_done"] = [u for u in meta["crossdedup_done"] if u != user]
        bump("_meta.crossdedup_done")
    for name in SEEN_USER_DICTS:
        if user in seen.get(name, {}):
            del seen[name][user]
            bump(name)
    for c in seen.get("companies", {}).values():
        if isinstance(c, dict) and isinstance(c.get("top"), dict) and user in c["top"]:
            del c["top"][user]
            bump("companies.*.top")
        if isinstance(c, dict) and isinstance(c.get("judged_by"), dict) and user in c["judged_by"]:
            del c["judged_by"][user]
            bump("companies.*.judged_by")
    for j in seen.get("jobs", {}).values():
        if not isinstance(j, dict):
            continue
        if isinstance(j.get("notified_for"), list) and user in j["notified_for"]:
            j["notified_for"] = [u for u in j["notified_for"] if u != user]
            bump("jobs.*.notified_for")
        if isinstance(j.get("llm_top"), dict) and user in j["llm_top"]:
            del j["llm_top"][user]
            bump("jobs.*.llm_top")
    return counts


def leftovers(obj, key: str, path: str = "$") -> list[str]:
    """Paths where `key` still appears as a dict key or list item."""
    out: list[str] = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == key:
                out.append(f"{path}.{k}")
            out.extend(leftovers(v, key, f"{path}.*"))
    elif isinstance(obj, list):
        for x in obj:
            if x == key:
                out.append(f"{path}[]")
            else:
                out.extend(leftovers(x, key, f"{path}[]"))
    return out


def write_atomically(files: list[tuple[Path, object]]) -> None:
    """Replace each file atomically, keeping a .bak of the original.

    Everything is serialized and written to temporary siblings first, so a
    serialization or disk error leaves every original untouched. The two
    os.replace calls are each atomic; if the process dies between them, restore
    from the .bak files (both are written before either replace happens).
    """
    import os
    import shutil
    staged = []
    for path, obj in files:
        # Same formatting as src/state.py's writer, so the diff is only the rename.
        text = json.dumps(obj, indent=1, sort_keys=True) + "\n"
        tmp = path.with_name(path.name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        staged.append((path, tmp))
    for path, _ in staged:
        shutil.copy2(path, path.with_name(path.name + ".bak"))
    for path, tmp in staged:
        os.replace(tmp, path)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--data-dir", required=True, type=Path)
    ap.add_argument("--from", dest="src", required=True)
    target = ap.add_mutually_exclusive_group(required=True)
    target.add_argument("--to", dest="dst")
    target.add_argument("--delete", action="store_true",
                        help="permanently remove --from instead of renaming it")
    ap.add_argument("--write", action="store_true", help="save changes (default: dry run)")
    a = ap.parse_args(argv)
    bad_dst = a.dst is not None and (not USER_KEY.match(a.dst) or a.src == a.dst)
    if not USER_KEY.match(a.src) or bad_dst:
        ap.error("user keys must match [a-zA-Z0-9_-]{1,100} and differ")

    seen_p = a.data_dir / "state" / "seen.json"
    apps_p = a.data_dir / "state" / "applications.json"
    seen = json.loads(seen_p.read_text(encoding="utf-8"))
    apps = json.loads(apps_p.read_text(encoding="utf-8"))
    if a.delete:
        counts = delete_user(seen, apps, a.src)
    else:
        try:
            counts = {**rename_applications(apps, a.src, a.dst), **rename_seen(seen, a.src, a.dst)}
        except Collision as e:
            print(f"refusing: {e} (delete or move the existing '{a.dst}' first)", file=sys.stderr)
            return 2
    left = leftovers(seen, a.src) + leftovers(apps, a.src)
    target = "(deleted)" if a.delete else a.dst
    print(json.dumps({"from": a.src, "to": target, "write": a.write, "changed": counts,
                      "leftovers": left[:20]}, indent=2))
    if left:
        print(f"refusing: '{a.src}' still present at {len(left)} path(s)", file=sys.stderr)
        return 3
    if a.write:
        write_atomically([(seen_p, seen), (apps_p, apps)])
    return 0


if __name__ == "__main__":
    sys.exit(main())
