"""TrackerStore seam: where "human state" (applied/saved/dismissed ticks,
the applications ledger, and the current match snapshot) lives.

The webui and the watcher cron both read and write that state, and until now
every access path repeated the same ~90 lines of repo/token/issue plumbing
(GitHub API call, git show of committed state, dashboard-write workflow
dispatch). This module is the seam that makes the mechanism pluggable:
callers talk to a `TrackerStore` and never care whether the driver is GitHub
(this file) or, later, a hosted store.

`GitHubStore` wraps the existing logic wholesale -- same API calls, same parse
functions, same workflow dispatch, same user-visible error strings -- so
switching the store on is behavior-neutral. A `convex` driver arrives in a
follow-up; `STORE` env selects the driver, defaulting to github.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import httpx

from . import dashboard, ledger, state as st
from .webui import core

API = "https://api.github.com"


class ApiError(Exception):
    """User-visible request failure (rendered as JSON by the webui)."""


@dataclass
class TickWrite:
    """One toggle a caller wants persisted on the dashboard issue."""
    short: str
    field: str  # "applied" | "saved" | "dismissed"
    value: bool


@dataclass
class TicksView:
    """The issue's read-back state. For each toggle kind, the set of shorts
    that is checked and the set that carries a rendered box; the `*_present`
    gate keeps the rendered-only sync rule (a truncated dashboard can't
    un-apply, un-hide, or un-save). `None` from get_ticks means the read
    failed and callers degrade exactly as before.

    `issue_open` mirrors the issue's `state`: GitHub serves closed issues
    with HTTP 200, so the parse still succeeds, and callers that must not
    touch a deliberately closed dashboard can check this."""
    checked: set[str] = field(default_factory=set)
    present: set[str] = field(default_factory=set)
    hidden: set[str] = field(default_factory=set)
    h_present: set[str] = field(default_factory=set)
    saved: set[str] = field(default_factory=set)
    s_present: set[str] = field(default_factory=set)
    issue_open: bool = True


class TrackerStore(Protocol):
    """Human state behind a pluggable driver. Return conventions mirror the
    GitHub reality callers already degrade on: get_ticks returns None when the
    read fails, set_ticks returns the shorts that were only QUEUED
    (workflow-dispatched) rather than applied instantly, and get_matches
    returns None when the driver doesn't serve a match snapshot. Drivers also
    expose the repo/token/issue_number/issue_url plumbing fields the webui
    reads from them."""

    def get_ticks(self, user: str) -> TicksView | None: ...

    def set_ticks(self, user: str, writes: list[TickWrite]) -> list[str]: ...

    def get_ledger(self, user: str) -> dict: ...

    def record_status(self, user: str, short: str, status: str,
                      note: str = "") -> None: ...

    def push_matches(self, user: str, matches: list[dict]) -> None: ...

    def get_matches(self, user: str) -> list[dict] | None: ...


def _git(root: Path, *args: str) -> bytes:
    proc = subprocess.run(["git", "-C", str(root), *args],
                          capture_output=True, check=True)
    return proc.stdout


def detect_repo(root: Path) -> str:
    """owner/name from GITHUB_REPOSITORY (Actions) or the origin remote."""
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if repo:
        return repo
    try:
        url = _git(root, "remote", "get-url", "origin").decode().strip()
    except (OSError, subprocess.CalledProcessError):
        return ""
    m = re.search(r"github\.com[:/]([^/\s]+/[^/\s]+?)(?:\.git)?$", url)
    return m.group(1) if m else ""


def detect_token() -> str:
    """GITHUB_TOKEN / GH_TOKEN, falling back to the gh CLI's stored login."""
    tok = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if tok:
        return tok
    try:  # the user is authenticated through the gh CLI locally
        proc = subprocess.run(["gh", "auth", "token"], capture_output=True,
                              text=True, check=True)
        return proc.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


class GitHubStore:
    """TrackerStore driver over the current GitHub mechanism: the dashboard
    issue holds the ticks, git-committed state files hold the ledger, and the
    `dashboard-write` workflow handles everything with no issue
    representation. This is pure delegation to the existing helpers -- the
    behavior baseline a future Convex driver must match."""

    def __init__(self, root: Path, user_cfg: dict | None = None):
        self.root = root
        self.user = (user_cfg or {}).get("name", "")
        self.repo = detect_repo(root)
        self.token = detect_token()
        self.issue_number: int | None = self._resolve_issue_number()
        self.issue_url = ""
        # Which exception class the last issue GET died on; the webui uses it
        # to reproduce its "couldn't read dashboard issue" warning verbatim.
        self.error_name: str | None = None

    def _resolve_issue_number(self) -> int | None:
        """The user's dashboard issue number from committed state, with the
        same origin/main-first / local-fallback read the webui refresh does."""
        try:
            state = json.loads(
                _git(self.root, "show", "origin/main:state/seen.json"))
        except (OSError, subprocess.CalledProcessError, ValueError):
            state = st.load_state(self.root / "state" / "seen.json")
        return (state.get("_meta", {}).get("dashboard_issue", {})
                .get(self.user))

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.token}",
                "Accept": "application/vnd.github+json",
                "User-Agent": "intern-watch webui (local)"}

    def _issue_get(self, client: httpx.Client, number: int) -> dict:
        resp = client.get(f"{API}/repos/{self.repo}/issues/{number}")
        resp.raise_for_status()
        return resp.json()

    # -- read-back ---------------------------------------------------------

    def get_ticks(self, user: str) -> TicksView | None:
        """The issue's tick state, or None when it can't be read at all
        (token/repo/issue missing, or the GET failed)."""
        if not (self.repo and self.token and self.issue_number):
            return None
        try:
            with httpx.Client(headers=self._headers(),
                              timeout=30.0) as client:
                issue = self._issue_get(client, self.issue_number)
        except httpx.HTTPError as exc:
            self.error_name = exc.__class__.__name__
            return None
        self.error_name = None
        self.issue_url = issue.get("html_url", "")
        body = issue.get("body") or ""
        checked, present = dashboard.parse_checkboxes(body)
        hidden, h_present = dashboard.parse_dismissed(body)
        saved, s_present = dashboard.parse_saved(body)
        return TicksView(checked, present, hidden, h_present, saved,
                         s_present,
                         issue_open=issue.get("state") != "closed")

    # -- ledger ------------------------------------------------------------

    def get_ledger(self, user: str) -> dict:
        """The user's ledger book from state/applications.json, origin/main
        first with the local checkout as fallback -- the same read the webui
        refresh does. Absence is normal until the first applied tick."""
        try:
            book = json.loads(
                _git(self.root, "show",
                     "origin/main:state/applications.json"))
        except (OSError, subprocess.CalledProcessError, ValueError):
            book = ledger.load_ledger(
                self.root / "state" / "applications.json")
        return book.get(user, {})

    # -- writes ------------------------------------------------------------

    _FLIPS = {"applied": core.flip_applied, "saved": core.flip_saved,
              "dismissed": core.flip_dismissed}

    def set_ticks(self, user: str, writes: list[TickWrite]) -> list[str]:
        """Apply toggles to the dashboard issue. Rendered markers flip via a
        single PATCH (one fetched body, changes accumulated); markers absent
        from the body (rows outside the rendered window) queue one
        dashboard-write dispatch each, exactly like the webui's per-toggle
        fallback. Returns the shorts that were only QUEUED."""
        if not writes:
            return []
        if not (self.repo and self.token and self.issue_number):
            raise ApiError("this state persists through the dashboard "
                           "issue and no GitHub token/issue is available — "
                           "run `gh auth login` and refresh")
        queued: list[str] = []
        with httpx.Client(headers=self._headers(), timeout=30.0) as client:
            issue = self._issue_get(client, self.issue_number)
            body = issue.get("body") or ""
            changed = False
            for w in writes:
                flip = self._FLIPS.get(w.field)
                if flip is None:
                    raise ApiError(f"unknown tick field {w.field!r} "
                                   f"(have: {', '.join(self._FLIPS)})")
                new_body = flip(body, w.short, w.value)
                if new_body is None:
                    self._dispatch_write(client, user, w.short, w.field,
                                         "true" if w.value else "false")
                    queued.append(w.short)
                else:
                    body = new_body
                    changed = True
            if changed:
                resp = client.patch(
                    f"{API}/repos/{self.repo}/issues/{self.issue_number}",
                    json={"body": body})
                resp.raise_for_status()
        return queued

    def record_status(self, user: str, short: str, status: str,
                      note: str = "") -> None:
        """Tracker status update -- always workflow-mediated (statuses have
        no issue checkbox). Validates the status name first, exactly like the
        webui's set_status did."""
        if status not in ledger.STATUSES:
            raise ApiError(f"unknown status {status!r} (have: "
                           f"{', '.join(ledger.STATUSES)})")
        if not (self.repo and self.token):
            raise ApiError("status updates dispatch a workflow and no "
                           "GitHub token is available — run `gh auth "
                           "login` and refresh")
        with httpx.Client(headers=self._headers(), timeout=30.0) as client:
            self._dispatch_write(client, user, short, "status", status,
                                 note)

    def _dispatch_write(self, client: httpx.Client, user: str, short: str,
                        field: str, value: str, note: str = "") -> None:
        """Queue a dashboard-write workflow run: Actions edits the match /
        ledger record in state directly and repaints the issue. Used for
        rows outside the issue's rendered window (no checkbox to PATCH) and
        for tracker statuses (no issue representation at all)."""
        inputs = {"user": user, "short": short, "field": field,
                  "value": value}
        if note:
            inputs["note"] = note
        resp = client.post(
            f"{API}/repos/{self.repo}/actions/workflows/"
            "dashboard-write.yml/dispatches",
            json={"ref": "main", "inputs": inputs})
        if resp.status_code == 404:
            raise ApiError("the dashboard-write workflow isn't on main "
                           "yet — merge the PR that adds it, then retry")
        resp.raise_for_status()

    # -- match snapshot (not served by this driver) ------------------------

    def push_matches(self, user: str, matches: list[dict]) -> None:
        """Publish the current match snapshot. The GitHub driver serves
        matches through committed state/seen.json, so there is nothing to
        push."""

    def get_matches(self, user: str) -> list[dict] | None:
        """The GitHub driver doesn't serve a snapshot; callers keep reading
        seen.json directly."""
        return None


def make_store(root: Path, user_cfg: dict | None = None) -> TrackerStore:
    """Pick the TrackerStore driver from the STORE env var (default
    `github`). A `convex` driver arrives in a follow-up."""
    name = os.environ.get("STORE", "github")
    if name == "github":
        return GitHubStore(root, user_cfg)
    raise ValueError(f"unknown STORE={name!r} (have: github; convex "
                     f"arrives in a follow-up)")