"""Per-user match dashboard, maintained as one GitHub issue.

The repo is private, so GitHub Pages is out (and would leak the data anyway);
an issue gives a browsable, grouped list with *clickable* checkboxes in the
GitHub UI. Each run regenerates the issue body from state["matches"], but
first reads back which boxes the user ticked, so "applied" persists in
seen.json and survives the rewrite. Closing the issue pauses updates;
reopening it resumes them.

Rows are tied to matches via a short key hash in an HTML comment -- dedup
keys themselves can contain "--", which is illegal inside a comment.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import logging
import os
import re
from typing import TYPE_CHECKING

import httpx

from . import content_dedup
from . import state as st
from .normalize import canonical_url
from .notify import _group_items

if TYPE_CHECKING:  # annotation-only; .store imports this module at runtime
    from .store import TicksView

log = logging.getLogger(__name__)

API = "https://api.github.com"
# Row-count ceiling (newest matches win) plus a byte budget: GitHub caps
# issue bodies at 65536 chars, and a fixed row count alone can't guarantee
# that -- 200 worst-case rows overflow it comfortably. build_body shrinks
# the shown window until the rendered body fits the budget.
MAX_ROWS = 200
BODY_BUDGET = 60000  # headroom under the 65536 cap

_LINE_RE = re.compile(r"^\s*[-*]\s*\[([ xX])\].*?<!--iw:([0-9a-f]{12})-->",
                      re.MULTILINE)
# Per-row "build resume" sub-checkbox (distinct marker so it never collides with
# the applied box's `iw:` marker -- `iwb:` doesn't match `iw:`).
_BUILD_RE = re.compile(r"^\s*[-*]\s*\[([ xX])\].*?<!--iwb:([0-9a-f]{12})-->",
                       re.MULTILINE)
# Per-row "hide" checkbox; ticked rows collapse into the Hidden section on the
# next repaint, where unticking restores them.
_DISMISS_RE = re.compile(r"^\s*[-*]\s*\[([ xX])\].*?<!--iwd:([0-9a-f]{12})-->",
                         re.MULTILINE)
# Per-row "saved" (bookmark) checkbox; distinct marker so it never collides
# with `iw:`/`iwb:`/`iwd:`. Purely a persisted flag, no side effects like
# `dismissed` moving the row -- symmetric with `applied`.
_SAVE_RE = re.compile(r"^\s*[-*]\s*\[([ xX])\].*?<!--iws:([0-9a-f]{12})-->",
                      re.MULTILINE)
# Top-level "build selected resumes" trigger box.
_TRIGGER_RE = re.compile(r"^\s*[-*]\s*\[([ xX])\].*?<!--iw:build-->",
                         re.MULTILINE)


def short_key(key: str) -> str:
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]


def parse_checkboxes(body: str) -> tuple[set[str], set[str]]:
    """(short keys checked, short keys present) from a dashboard body."""
    checked, present = set(), set()
    for mark, short in _LINE_RE.findall(body):
        present.add(short)
        if mark in "xX":
            checked.add(short)
    return checked, present


def parse_build_selections(body: str) -> set[str]:
    """Short keys whose per-row 'build resume' box is ticked."""
    return {short for mark, short in _BUILD_RE.findall(body) if mark in "xX"}


def parse_dismissed(body: str) -> tuple[set[str], set[str]]:
    """(short keys hidden, short keys carrying a hide box) from a body."""
    checked, present = set(), set()
    for mark, short in _DISMISS_RE.findall(body):
        present.add(short)
        if mark in "xX":
            checked.add(short)
    return checked, present


def parse_saved(body: str) -> tuple[set[str], set[str]]:
    """(short keys saved, short keys carrying a save box) from a body."""
    checked, present = set(), set()
    for mark, short in _SAVE_RE.findall(body):
        present.add(short)
        if mark in "xX":
            checked.add(short)
    return checked, present


def build_trigger_checked(body: str) -> bool:
    """True if the top 'Build selected resumes' box is ticked."""
    m = _TRIGGER_RE.search(body)
    return bool(m and m.group(1) in "xX")


def _md(text: str) -> str:
    """Escape the markdown that would break a list line or link text."""
    return re.sub(r"([\[\]*_`<>])", r"\\\1", text)


def _url(url: str) -> str:
    return url.replace("(", "%28").replace(")", "%29")


def _row(item: dict, repo: str = "", branch: str = "main",
         interactive: bool = True) -> str:
    short = short_key(item["key"])
    tag = f"**{_md(item['tag'])}** " if item.get("tag") else ""
    salary = f" · {_md(item['salary'])}" if item.get("salary") else ""
    added = f" · seen {item['added']}" if item.get("added") else ""
    # commit-mode resumes land in-repo; link to the blob so the user can grab
    # the .docx straight from the dashboard. No `resume` key => no link.
    resume = ""
    if repo and item.get("resume"):
        resume = f" · [📄 resume](/{repo}/blob/{branch}/{item['resume']})"
    if not interactive:
        # Read-only digest row: a plain line with NO checkbox and NO
        # iw:/iwd:/iws: markers, but the same displayed suffix parts
        # (tag, salary, added, resume) as the interactive row so the two
        # render identically apart from the controls. There is no short key
        # to act on, so the `/resume` build command is dropped too.
        return (f"- {tag}{_md(item['company'])} — "
                f"[{_md(item['title'])}]({_url(item['url'])}) "
                f"({_md(item['location'])}){salary}{added}{resume}")
    box = "x" if item.get("applied") else " "
    # Visible build command: the short key lives in the HTML comment (hidden by
    # GitHub's renderer), so surface the exact comment to copy-paste. For sites
    # we can't scrape, paste the JD on the lines below the /resume comment.
    cmd = f" · `/resume {short}`"
    main = (f"- [{box}] {tag}{_md(item['company'])} — "
            f"[{_md(item['title'])}]({_url(item['url'])}) "
            f"({_md(item['location'])}){salary}{added}{resume}{cmd} "
            f"<!--iw:{short}-->")
    # Per-row build toggle: tick it (plus the top trigger) to batch-build. Once
    # built (item has a `resume` path), the box renders ticked -- the link on
    # the row above is the artifact -- and the batch run skips it next time.
    built = bool(item.get("resume"))
    bbox = "x" if built else " "
    blabel = "📄 resume built" if built else "📄 build resume"
    sub = f"  - [{bbox}] {blabel} <!--iwb:{short}-->"
    # Saved toggle: a plain bookmark flag, read back like `applied` (see
    # parse_saved) -- no side effect on the row's position.
    sbox = "x" if item.get("saved") else " "
    save = f"  - [{sbox}] ⭐ saved <!--iws:{short}-->"
    # Hide toggle: tick it and the row moves to the Hidden section on the
    # next repaint (read back like `applied`, see parse_dismissed).
    hide = f"  - [ ] 🚫 hide <!--iwd:{short}-->"
    return f"{main}\n{sub}\n{save}\n{hide}"


def _hidden_row(item: dict, interactive: bool = True) -> str:
    """One-liner inside the Hidden section. Interactive: box ticked, untick
    to restore. Read-only digest: a plain line (no checkbox, no marker)."""
    short = short_key(item["key"])
    if not interactive:
        return (f"- {_md(item['company'])} — "
                f"[{_md(item['title'])}]({_url(item['url'])})")
    return (f"- [x] {_md(item['company'])} — "
            f"[{_md(item['title'])}]({_url(item['url'])}) "
            f"<!--iwd:{short}-->")


def build_body(matches: list[dict], terms_order: list[str],
               now: dt.datetime, repo: str = "", branch: str = "main",
               interactive: bool = True) -> str:
    """Markdown body: header stats, then active matches grouped by term
    (newest first), then dismissed matches in a collapsed Hidden section.
    Check a box = applied; tick a hide box = dismissed; everything else is
    regenerated each run.

    With `interactive=False` the body is a read-only digest: rows carry no
    checkboxes and no markers, and the header note says the tracker is
    managed by the store (edited in the local webui) rather than by ticking
    this issue. Used when the TrackerStore has no GitHub-issue plumbing."""
    active = sorted((i for i in matches if not i.get("dismissed")),
                    key=lambda i: i.get("added", ""), reverse=True)
    dismissed = sorted((i for i in matches if i.get("dismissed")),
                       key=lambda i: i.get("added", ""), reverse=True)
    applied = sum(1 for i in matches if i.get("applied"))
    saved = sum(1 for i in matches if i.get("saved"))

    def render(n: int, d_n: int) -> str:
        shown, overflow = active[:n], active[n:]
        d_shown, d_overflow = dismissed[:d_n], dismissed[d_n:]
        if interactive:
            intro = [
                "Maintained automatically by intern-watch. **Tick a row's "
                "checkbox once you've applied** — it is read back into state "
                "on the next run. Tick **⭐ saved** to bookmark a row for "
                "later. Tick **🚫 hide** to move a row to the Hidden "
                "section. Any other edit to this issue gets overwritten.",
                "",
                "To get tailored resumes: tick the **📄 build resume** box "
                "under each job you want, then tick the trigger below. "
                "Already-built rows are skipped; the trigger resets itself "
                "when the build finishes.",
                "",
                "- [ ] **Build selected resumes** <!--iw:build-->",
            ]
        else:
            intro = [
                "Maintained automatically by intern-watch. **Read-only "
                "digest**: the tracker state lives in the store now and is "
                "edited in the local webui (`python -m src.webui`); ticks "
                "made here are not read back. Any edit to this issue gets "
                "overwritten.",
                "",
            ]
        parts = [
            f"**{len(active)} matches · {applied} applied · {saved} saved · "
            f"{len(dismissed)} hidden** — updated "
            f"{now.strftime('%b %d, %I:%M %p UTC').lstrip('0')}",
            "",
            *intro,
        ]
        for term, group in _group_items(shown, terms_order):
            parts.append(f"\n### {term}\n")
            group = sorted(group, key=lambda i: (i.get("added", ""),
                                                 i["company"].casefold()),
                           reverse=True)
            parts.extend(_row(item, repo, branch, interactive)
                         for item in group)
        if overflow:
            parts.append(f"\n*…and {len(overflow)} older match(es) not shown "
                         "(their applied state is kept in state/seen.json).*")
        if d_shown:
            parts.append("\n<details>")
            if interactive:
                parts.append(f"<summary>🗂 Hidden ({len(dismissed)}) — untick "
                             "to restore</summary>\n")
            else:
                parts.append(f"<summary>🗂 Hidden ({len(dismissed)})"
                             "</summary>\n")
            parts.extend(_hidden_row(item, interactive) for item in d_shown)
            if d_overflow:
                parts.append(f"\n*…and {len(d_overflow)} more hidden "
                             "match(es) (kept in state/seen.json).*")
            parts.append("\n</details>")
        return "\n".join(parts)

    n = min(len(active), MAX_ROWS)
    d_n = min(len(dismissed), MAX_ROWS)
    body = render(n, d_n)
    # Row counts alone can't bound bytes: shrink the window until the body
    # fits GitHub's cap. Unrendered rows keep their state (rendered-only
    # sync rule), so trimming is always safe.
    while len(body) > BODY_BUDGET and (n > 10 or d_n > 10):
        n, d_n = max(10, n * 4 // 5), max(10, d_n * 4 // 5)
        body = render(n, d_n)
    return body


# A match gone from every source this long is almost certainly a closed
# posting. The watcher hides those itself: rows outside the issue's rendered
# window have no checkbox, so this is the ONLY way they ever get cleaned up.
# 7 matches the webui's "likely closed" badge (one concept, one threshold);
# it also matches jobright's ~7-day README retention, so a jobright-only
# match auto-hides ~two weeks after posting even if technically still open —
# acceptable dashboard hygiene, and a restore is one untick away.
AUTO_HIDE_AFTER_DAYS = 7


def auto_dismiss_stale(state: dict, user: str, today: dt.date,
                       days: int = AUTO_HIDE_AFTER_DAYS) -> int:
    """Mark unapplied matches whose job vanished from every source `days`+
    ago as dismissed. Rows the user manually restored (`restored` flag, set
    by matches_set_dismissed) are never re-hidden; everything auto-hidden
    lands in the issue's Hidden section, where unticking restores it and
    sets that flag. Returns how many were hidden."""
    jobs = state.get("jobs", {})
    cutoff = (today - dt.timedelta(days=days)).isoformat()
    n = 0
    for item in state["matches"].get(user, []):
        if item.get("applied") or item.get("dismissed") \
                or item.get("restored"):
            continue
        last = jobs.get(item.get("key"), {}).get("last_seen")
        if last and last <= cutoff:
            item["dismissed"] = True
            n += 1
    if n:
        log.info("user %s: auto-hid %d stale match(es) (gone %d+ days)",
                 user, n, days)
    return n


def _same_posting(a: dict, b: dict) -> bool:
    """Two dashboard rows are the same real posting if they share a canonical
    employer-URL identity, or (for pre-resolver rows whose jr: url is still the
    jobright link, so canon is None) their content signatures are compatible."""
    ca = canonical_url(a.get("url") or "")
    cb = canonical_url(b.get("url") or "")
    if ca and cb:
        return ca == cb
    return content_dedup.compatible(content_dedup.signature_from_item(a),
                                    content_dedup.signature_from_item(b))


def dedup_existing_matches(state: dict, user: str) -> int:
    """One-time cleanup: cross-source duplicate rows already on the dashboard
    (the same posting delivered as both a jr: and a url: match before the
    url-index existed) are collapsed by hiding all but one per group. Rows are
    grouped by _same_posting -- shared canonical url, or compatible content
    signature for the historical jr: rows whose stored url is still the
    (uncanonicalizable) jobright link. Survivor: an applied/saved row if any,
    else the earliest-added. A group with more than one acted-on row is left
    fully intact -- never risk hiding a row the user acted on. Rows already
    dismissed/restored are left as-is (symmetric with auto_dismiss_stale).
    Idempotent via a _meta flag. Returns how many rows were newly hidden."""
    flag = state.setdefault("_meta", {}).setdefault("crossdedup_done", [])
    if user in flag:
        return 0
    items = state["matches"].get(user, [])
    # Greedy grouping: each row joins the first group it matches (order-stable,
    # so the earliest row anchors each group).
    groups: list[list[dict]] = []
    for item in items:
        for grp in groups:
            if _same_posting(grp[0], item):
                grp.append(item)
                break
        else:
            groups.append([item])
    n = 0
    for rows in groups:
        if len(rows) < 2:
            continue
        acted = [r for r in rows if r.get("applied") or r.get("saved")]
        if len(acted) > 1:
            continue  # more than one acted-on row -- don't choose, keep all
        survivor = acted[0] if acted else min(
            rows, key=lambda r: r.get("added", ""))
        for r in rows:
            if r is survivor or r.get("dismissed") or r.get("restored"):
                continue
            if r.get("applied") or r.get("saved"):
                continue
            # Set the flag directly (like auto_dismiss_stale) rather than via
            # matches_set_dismissed, which would un-dismiss every other row.
            r["dismissed"] = True
            log.info("user %s: retro-hid dup %s == %s [layer=retro]",
                     user, r.get("key"), survivor.get("key"))
            n += 1
    if n:
        log.info("user %s: hid %d cross-source duplicate row(s) [layer=retro]",
                 user, n)
    flag.append(user)
    return n


def sync_user(state: dict, user: str, terms_order: list[str],
              now: dt.datetime, repo: str, token: str,
              ticks: "TicksView | None" = None,
              interactive: bool = True) -> None:
    """Read applied/hide checkboxes back into state, auto-hide stale rows,
    then rewrite (or create) the user's dashboard issue. Raises httpx errors
    to the caller.

    `ticks` is the store-produced read-back (src.store); when None the issue
    is fetched and parsed here instead -- the legacy path (dashboard-write /
    resume-batch runs) that also owns the closed-issue skip and the
    recreate-on-gone behavior. A store read-back can't discover a gone or
    recreated issue, but it CAN see a closed one (HTTP 200 with `state:
    closed`), so the same skip applies before any read-back or repaint.

    `interactive=False` (a store with no GitHub-issue plumbing, e.g.
    STORE=convex) still reads ticks back and syncs state, but writes a
    read-only digest body with no checkboxes; when there is no repo/token to
    write to, the issue write is skipped entirely."""
    matches = st.matches_items(state, user)
    if not matches:
        return
    issue_numbers = state["_meta"].setdefault("dashboard_issue", {})
    number = issue_numbers.get(user)
    headers = {"Authorization": f"Bearer {token}",
               "Accept": "application/vnd.github+json",
               "User-Agent": "intern-watch (job alert bot)"}
    title = f"📋 intern-watch matches — {user}"

    with httpx.Client(headers=headers, timeout=30.0) as client:
        if number and repo and token and ticks is None:
            resp = client.get(f"{API}/repos/{repo}/issues/{number}")
            if resp.status_code in (404, 410):
                log.warning("dashboard issue #%d gone -- creating a new one",
                            number)
                number = None
            else:
                resp.raise_for_status()
                issue = resp.json()
                if issue.get("state") == "closed":
                    log.info("user %s: dashboard issue #%d is closed -- "
                             "skipping update (reopen it to resume)",
                             user, number)
                    return
                # module-level import would cycle (dashboard <-> store via
                # webui.core); this legacy construction is the only place
                # sync_user needs the concrete type
                from .store import TicksView
                body = issue.get("body") or ""
                ticks = TicksView(*parse_checkboxes(body),
                                  *parse_dismissed(body),
                                  *parse_saved(body))
        if ticks is not None and not ticks.issue_open:
            log.info("user %s: dashboard issue #%d is closed -- "
                     "skipping update (reopen it to resume)",
                     user, number)
            return
        if ticks is not None:
            by_short = {short_key(m["key"]): m["key"] for m in matches}
            checked, present = ticks.checked, ticks.present
            st.matches_set_applied(
                state, user,
                {by_short[s] for s in checked if s in by_short},
                {by_short[s] for s in present if s in by_short})
            hidden, h_present = ticks.hidden, ticks.h_present
            st.matches_set_dismissed(
                state, user,
                {by_short[s] for s in hidden if s in by_short},
                {by_short[s] for s in h_present if s in by_short})
            saved, s_present = ticks.saved, ticks.s_present
            st.matches_set_saved(
                state, user,
                {by_short[s] for s in saved if s in by_short},
                {by_short[s] for s in s_present if s in by_short})

        # after read-back (so a manual restore this cycle wins first), sweep
        # long-gone postings and existing cross-source duplicates into Hidden
        auto_dismiss_stale(state, user, now.date())
        dedup_existing_matches(state, user)

        branch = os.environ.get("GITHUB_REF_NAME") or "main"
        body = build_body(st.matches_items(state, user), terms_order, now,
                          repo, branch, interactive=interactive)
        if not (repo and token):
            # A store with no issue plumbing (STORE=convex) has no dashboard
            # issue to write -- the read-back + hygiene above is the point.
            log.info("user %s: no issue plumbing (repo/token unset) -- "
                     "state synced, no dashboard issue written", user)
            return
        if number:
            resp = client.patch(f"{API}/repos/{repo}/issues/{number}",
                                json={"title": title, "body": body})
            resp.raise_for_status()
        else:
            resp = client.post(f"{API}/repos/{repo}/issues",
                               json={"title": title, "body": body})
            resp.raise_for_status()
            issue_numbers[user] = resp.json()["number"]
            log.info("user %s: created dashboard issue #%d", user,
                     issue_numbers[user])
    log.info("user %s: dashboard issue #%d updated (%d matches)",
             user, issue_numbers[user], len(matches))


def main(argv: list[str] | None = None) -> int:
    """Refresh a user's dashboard issue from current state. Used by the
    `resume-batch` and `dashboard-write` workflows to repaint the issue
    without waiting for the watcher. Needs GITHUB_REPOSITORY/GITHUB_TOKEN;
    no-ops cleanly if they're absent.

    The read-back ticks come from the TrackerStore (the same GitHub
    mechanism); only a GitHub-issue driver paints an interactive body -- a
    convex store writes a read-only digest with no checkboxes."""
    import argparse
    import sys
    from pathlib import Path

    from .filters import load_users
    # Local import: .store imports this module at runtime (via webui.core),
    # so a module-level import here would cycle (dashboard <-> store).
    from .store import GitHubStore, make_store

    ap = argparse.ArgumentParser(prog="python -m src.dashboard",
                                 description=main.__doc__)
    ap.add_argument("--user", default="",
                    help="watcher user (default: the sole users/*.yaml)")
    ap.add_argument("--root", default=str(Path(__file__).resolve().parents[1]),
                    help="repo root (override for tests)")
    args = ap.parse_args(argv)

    repo = os.environ.get("GITHUB_REPOSITORY", "")
    token = os.environ.get("GITHUB_TOKEN", "")
    if not repo or not token:
        print("GITHUB_REPOSITORY/GITHUB_TOKEN not set; nothing to refresh",
              file=sys.stderr)
        return 0

    from . import ledger

    root = Path(args.root)
    users = {u["name"]: u for u in load_users(root / "users")}
    if not args.user:
        if len(users) != 1:
            print(f"several users configured ({', '.join(sorted(users))}) — "
                  "pick one with --user", file=sys.stderr)
            return 2
        args.user = next(iter(users))
    terms_order = list((users.get(args.user) or {}).get("terms_wanted", []))
    state_path = root / "state" / "seen.json"
    state = st.load_state(state_path)
    now = dt.datetime.now(dt.timezone.utc)
    store = make_store(root, users.get(args.user) or {"name": args.user})
    ticks = store.get_ticks(args.user)
    sync_user(state, args.user, terms_order, now, repo, token,
              ticks=ticks, interactive=isinstance(store, GitHubStore))
    ledger.sync_file(state, args.user, ledger.ledger_path(root), now.date())
    st.save_state(state, state_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
