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
switching the store on is behavior-neutral. `ConvexStore` serves the same
state through a Convex deployment's HTTP API; `STORE` env selects the
driver, defaulting to github.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import httpx

from . import dashboard, ledger
from . import state as st
from .webui import core

log = logging.getLogger(__name__)

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

    # The issue plumbing the webui reads straight off the driver. A driver with
    # no dashboard issue (ConvexStore) leaves these empty/None rather than
    # omitting them, which is what keeps the issue-specific webui paths off.
    repo: str
    token: str
    issue_number: int | None
    issue_url: str

    def get_ticks(self, user: str) -> TicksView | None: ...

    def set_ticks(self, user: str, writes: list[TickWrite]) -> list[str]: ...

    def get_ledger(self, user: str) -> dict: ...

    def record_status(self, user: str, short: str, status: str,
                      note: str = "") -> None: ...

    def push_matches(self, user: str, matches: list[dict]) -> None: ...

    def get_matches(self, user: str) -> list[dict] | None: ...

    def get_actions(self, user: str) -> dict | None:
        """The user's mail-sync inbox actions ({actions, health}), or None
        when the driver doesn't serve mail sync or the read failed."""
        ...

    def resolve_action(self, user: str, action_id: str, short: str = "",
                       status: str = "", dismiss: bool = False) -> None:
        """Resolve one inbox action server-side. Raises ApiError on failure
        (bad status, unknown action, already resolved, or an unavailable
        driver)."""
        ...

    def put_resume(self, user: str, short: str, filename: str,
                   data: bytes) -> str:
        """Store a built .docx and return the driver-native reference to it
        (what callers record on the match item as its `resume` value).
        GitHubStore: writes the file under `resumes/<user>/<short>/` (the
        commit step keeps committing the directory) and returns the
        repo-relative posix path, exactly as the pre-seam flow expected.
        ConvexStore: uploads the bytes to Convex file storage and returns the
        storage id."""
        ...

    def get_resume_urls(self, user: str) -> dict[str, str]:
        """A {short: serving URL} map of the user's STORE-HOSTED (http/https)
        built resumes. GitHubStore returns {} - its resumes are repo-relative
        paths already on the match items, which surfaces rebuild into their
        repo-blob (dashboard) or /files/repo (webui) link as always. A
        Convex deployment's serving URL per short comes back in one batched query."""
        ...

    def get_watch_prefs(self, user: str) -> dict | None:
        """The user's watch preferences (the Settings > Watch object, see
        src/prefs.py) or None when the driver holds none / the read failed.
        A failed read must degrade to the yaml, never abort the run."""
        ...

    def put_watch_report(self, user: str, report: dict) -> None:
        """Record the resolved preferences this run used (prefs.watch_report)
        so the settings page can show them. Best-effort: never raises."""
        ...

    @property
    def writable(self) -> bool:
        """Whether a write can reach the store (issue + creds present for
        GitHub; always True for a hosted driver). The webui gates its
        toggle paths on this."""
        ...

    @property
    def read_warning(self) -> str | None:
        """Human warning to surface when get_ticks can't read the store, set
        by every get_ticks call: None on success (or when silence is the
        right outcome, e.g. no dashboard issue at all). The webui appends it
        to the `/api/state` warnings when get_ticks returned None."""
        ...


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
        # Human read-back warning (None on success or when silence is right),
        # set by every get_ticks call; the webui surfaces it in /api/state.
        self.read_warning: str | None = None

    @property
    def writable(self) -> bool:
        """A write reaches GitHub only with creds + a resolved issue."""
        return bool(self.token and self.repo and self.issue_number)

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
            # A known issue with no way to read it needs the legacy "no GitHub
            # token" warning; no issue at all means silence is correct (the
            # webui appended nothing in that case).
            self.read_warning = (
                "no GitHub token (set GITHUB_TOKEN or log in with "
                "`gh auth login`) — applied toggles are read-only this "
                "session" if self.issue_number else None)
            return None
        try:
            with httpx.Client(headers=self._headers(),
                              timeout=30.0) as client:
                issue = self._issue_get(client, self.issue_number)
        except httpx.HTTPError as exc:
            self.error_name = exc.__class__.__name__
            self.read_warning = (
                f"couldn't read dashboard issue #{self.issue_number} "
                f"({self.error_name}) — applied ticks made on GitHub may "
                "not show")
            return None
        self.error_name = None
        self.read_warning = None
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

    # -- resume storage -----------------------------------------------------

    def put_resume(self, user: str, short: str, filename: str,
                   data: bytes) -> str:
        """Write the built .docx to resumes/<user>/<short>/<filename> and
        return the repo-relative posix path. The workflow's existing commit
        step (`[ -d resumes ] && git add resumes/`) picks it up unchanged,
        so this is byte-identical to the pre-seam placement: same file
        locations, same commit expectation, same dashboard link."""
        out = (self.root / "resumes" / user / short / filename)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
        return out.relative_to(self.root).as_posix()

    def get_resume_urls(self, user: str) -> dict[str, str]:
        """No remote-serving: the repo-relative `resumes/...` path is already
        on each match item, so surfaces link it as the repo-blob (dashboard)
        or /files/repo (webui) they have always used. Nothing is fetched -- the
        commit step keeps serving resumes from the repo."""
        return {}

    # -- match snapshot (not served by this driver) ------------------------

    def push_matches(self, user: str, matches: list[dict]) -> None:
        """Publish the current match snapshot. The GitHub driver serves
        matches through committed state/seen.json, so there is nothing to
        push."""

    def get_matches(self, user: str) -> list[dict] | None:
        """The GitHub driver doesn't serve a snapshot; callers keep reading
        seen.json directly."""
        return None

    # -- watch prefs (not served by this driver) ----------------------------

    def get_watch_prefs(self, user: str) -> dict | None:
        """No hosted settings page behind this driver: the yaml is the whole
        configuration."""
        return None

    def put_watch_report(self, user: str, report: dict) -> None:
        """Nothing reads a report here."""

    # -- mail sync (not served by this driver) ------------------------------

    def get_actions(self, user: str) -> dict | None:
        """The GitHub driver has no mail-sync backend; the webui frontend
        hides the inbox tab when this returns None."""
        return None

    def resolve_action(self, user: str, action_id: str, short: str = "",
                       status: str = "", dismiss: bool = False) -> None:
        """Mail-sync actions live only behind the Convex store."""
        raise ApiError("inbox actions need the convex store")


class ConvexStore:
    """TrackerStore driver over a Convex deployment's HTTP API (no pip
    package: the deployment itself holds the schema + functions in
    `convex/`, and this driver just POSTs JSON to /api/query and
    /api/mutation). Select with STORE=convex.

    Config comes from env: CONVEX_URL (the deployment origin) and
    CONVEX_SECRET, which must equal the deployment's TRACKER_SECRET env var
    (every query and mutation checks it - reads return per-user tracker data,
    so they are gated too). get_ticks returns None on transport/API failure
    (recording `error_name`), so callers degrade exactly as they do for the
    GitHub driver; the mutation endpoints raise ApiError instead.

    There is no dashboard issue in this model, so the issue plumbing fields
    the webui reads are all empty: repo/token/issue_number are unset, which
    keeps the issue-specific webui paths (read-back overlay, tick
    write-through) off. get_ticks still honors the rendered-only rule:
    because there is no render window in a DB, every short that has a tick
    row counts as *present* -- a row's existence is what makes an untick
    meaningful."""

    CHUNK = 200  # push_matches batching; Convex actions have payload limits

    def __init__(self, root: Path, user_cfg: dict | None = None):
        self.root = root
        self.user = (user_cfg or {}).get("name", "")
        url = os.environ.get("CONVEX_URL", "")
        secret = os.environ.get("CONVEX_SECRET", "")
        if not url or not secret:
            raise ApiError(
                "STORE=convex needs CONVEX_URL and CONVEX_SECRET env vars "
                "(CONVEX_SECRET must match the deployment's TRACKER_SECRET) "
                "-- see README \"Database backend\"")
        self.url = url.rstrip("/")
        self.secret = secret
        # Issue plumbing the webui reads; empty keeps the issue paths off.
        self.repo = ""
        self.token = ""
        self.issue_number: int | None = None
        self.issue_url = ""
        # Which exception the last get_ticks call died on (like GitHubStore).
        self.error_name: str | None = None
        # Human read-back warning, set by every get_ticks call (None on
        # success); the webui surfaces it in /api/state when ticks are absent.
        self.read_warning: str | None = None

    @property
    def writable(self) -> bool:
        """The deployment serves every write directly; always writable."""
        return True

    def _post(self, kind: str, fn: str, args: dict,
              module: str = "tracker") -> dict | list | None:
        """POST one Convex HTTP endpoint and return the decoded `value`, or
        raise ApiError on transport failure or a non-success status body.
        `module` is the Convex module prefix for the function path (`tracker`
        for human-state functions, `mail` for the mail-sync ones)."""
        payload = {"path": f"{module}:{fn}", "args": args, "format": "json"}
        try:
            with httpx.Client(timeout=30.0) as client:
                resp = client.post(f"{self.url}/api/{kind}", json=payload)
        except httpx.HTTPError as exc:
            raise ApiError(f"convex {kind} {fn} request failed: {exc}") from exc
        try:
            data = resp.json()
        except ValueError as exc:
            raise ApiError(f"convex {kind} {fn} returned non-JSON") from exc
        if data.get("status") != "success":
            raise ApiError(f"convex {kind} {fn} error: "
                           f"{data.get('errorMessage', 'unknown')}")
        return data.get("value")

    # -- read-back ---------------------------------------------------------

    def get_ticks(self, user: str) -> TicksView | None:
        """The user's tick state, or None when the read failed (like
        GitHubStore; recorded on `error_name`)."""
        try:
            rows = self._post("query", "getTicks",
                              {"user": user, "secret": self.secret})
        except ApiError as exc:
            self.error_name = exc.__class__.__name__
            # Fold the root cause into a human warning rather than the bare
            # 'ApiError' class name, which says nothing useful on its own.
            self.read_warning = (
                f"couldn't reach the Convex store ({exc}) -- ticks and "
                "statuses may be stale")
            return None
        self.error_name = None
        self.read_warning = None
        rows = rows or []
        shorts = {r["short"] for r in rows}
        checked = {r["short"] for r in rows if r.get("applied")}
        hidden = {r["short"] for r in rows if r.get("dismissed")}
        saved = {r["short"] for r in rows if r.get("saved")}
        # No render window: every row-bearing short is present for all three
        # kinds, so an un-toggle left a row behind and is honored on read-back.
        return TicksView(checked, shorts, hidden, shorts, saved, shorts,
                         issue_open=True)

    # -- ledger ------------------------------------------------------------

    def get_ledger(self, user: str) -> dict:
        """The user's ledger book, shaped like src/ledger.py records so the
        webui's tracker tab renders it: the display `snapshot` fields merged
        in, plus status / history / applied. History entries carry the date
        (`on`) the webui sorts and displays on."""
        rows = self._post("query", "getLedger",
                          {"user": user, "secret": self.secret}) or []
        book: dict = {}
        for row in rows:
            rec = dict(row.get("snapshot") or {})
            rec["status"] = row["status"]
            if row.get("note"):
                rec["note"] = row["note"]
            rec["history"] = [
                {"on": e["at"][:10], "status": e["status"],
                 **({"note": e["note"]} if e.get("note") else {})}
                for e in row.get("history", [])]
            # `applied` = the date the record was created (Convex has no
            # separate applied field); a migration-copied snapshot may carry
            # the original apply date, which wins over the insertion date.
            rec.setdefault("applied", (row.get("createdAt") or "")[:10])
            book[row["short"]] = rec
        return book

    # -- writes ------------------------------------------------------------

    def set_ticks(self, user: str, writes: list[TickWrite]) -> list[str]:
        """Persist every toggle in one mutation; Convex commits instantly so
        nothing is ever workflow-queued (the returned short list stays
        empty). Raises ApiError on an API error status."""
        if not writes:
            return []
        payload = [{"short": w.short, "field": w.field, "value": w.value}
                   for w in writes]
        self._post("mutation", "setTicks",
                   {"user": user, "writes": payload, "secret": self.secret})
        return []

    def record_status(self, user: str, short: str, status: str,
                      note: str = "", snapshot: dict | None = None) -> None:
        """Record a tracker status on the application, creating the record
        when absent. Validates the status name first (same ApiError text as
        GitHubStore). `snapshot` (the display fields) is stored on the
        record so get_ledger can rebuild the webui's record shape; it is
        only set when provided, mirroring the Convex mutation."""
        if status not in ledger.STATUSES:
            raise ApiError(f"unknown status {status!r} (have: "
                           f"{', '.join(ledger.STATUSES)})")
        args: dict = {"user": user, "short": short, "status": status,
                      "note": note, "secret": self.secret}
        if snapshot is not None:
            args["snapshot"] = snapshot
        self._post("mutation", "recordStatus", args)

    def push_matches(self, user: str, matches: list[dict]) -> None:
        """Publish the full match snapshot, augmented with each item's short
        key (the Convex upsert key). Each chunk is a pure upsert; the
        full-snapshot prune (rows absent from the WHOLE pushed set) runs once
        afterward as a separate `pruneMatches` call -- never per chunk, or a
        >200 snapshot would delete every earlier chunk's rows."""
        items = [{**m, "short": dashboard.short_key(m["key"])}
                 for m in matches if m.get("key")]
        for i in range(0, len(items), self.CHUNK):
            self._post("mutation", "pushMatches",
                       {"user": user, "items": items[i:i + self.CHUNK],
                        "secret": self.secret})
        self._post("mutation", "pruneMatches",
                   {"user": user,
                    "keep": [it["short"] for it in items],
                    "secret": self.secret})

    def get_matches(self, user: str) -> list[dict] | None:
        """The pushed match snapshot, item payloads only (storage fields
        stripped). None when the read fails, like GitHubStore."""
        try:
            items = self._post("query", "getMatches",
                               {"user": user, "secret": self.secret})
        except ApiError:
            return None
        # _post returns whatever JSON the deployment sent; treat a non-list as
        # an empty snapshot rather than handing callers the wrong shape.
        return items if isinstance(items, list) else []

    # -- mail sync ----------------------------------------------------------

    def get_actions(self, user: str) -> dict | None:
        """The user's mail-sync inbox actions {actions, health|None}, or
        None when the read fails (like get_matches: the webui hides the inbox
        tab when it can't get actions)."""
        try:
            actions = self._post("query", "getActions",
                                 {"user": user, "secret": self.secret},
                                 module="mail")
        except ApiError:
            return None
        return actions if isinstance(actions, dict) else None

    def resolve_action(self, user: str, action_id: str, short: str = "",
                       status: str = "", dismiss: bool = False) -> None:
        """Resolve one inbox action: dismiss it, or apply a tracker status to
        its matched job. Only includes the short/status keys when non-empty
        and `dismiss` when True (the mutation throws on a bad status, unknown
        action, or one already resolved)."""
        args: dict = {"user": user, "id": action_id,
                      "secret": self.secret}
        if dismiss:
            args["dismiss"] = True
        else:
            if short:
                args["short"] = short
            if status:
                args["status"] = status
        self._post("mutation", "resolveAction", args, module="mail")

    def set_mail_account(self, user: str, email: str,
                         refresh_token: str) -> None:
        """Store the user's Gmail OAuth refresh token (only reachable through
        this Convex driver; used by the mail-auth setup CLI)."""
        # An action, not a mutation: the backend encrypts the token before
        # storing it, and generating the AES IV needs randomness that only an
        # action may use.
        self._post("action", "setMailAccount",
                   {"user": user, "email": email,
                    "refreshToken": refresh_token, "secret": self.secret},
                   module="mail")

    # -- resume storage ----------------------------------------------------

    # The DOCX Open Packaging mime the Convex file-storage upload requires.
    _DOCX_MIME = ("application/vnd.openxmlformats-officedocument"
                  ".wordprocessingml.document")

    def put_resume(self, user: str, short: str, filename: str,
                   data: bytes) -> str:
        """Upload the built .docx to Convex file storage and return the
        storage id (the reference recorded on the match item). Flow: mint an
        upload URL -> POST the bytes -> attach the storage id to the (user,
        short) row (replace-on-upsert, old object deleted server-side)."""
        upload_url = self._post(
            "mutation", "generateResumeUploadUrl",
            {"user": user, "short": short, "secret": self.secret})
        if not isinstance(upload_url, str) or not upload_url:
            raise ApiError("generateResumeUploadUrl returned no upload URL")
        try:
            with httpx.Client(timeout=60.0) as client:
                resp = client.post(upload_url, content=data,
                                   headers={"Content-Type": self._DOCX_MIME})
                resp.raise_for_status()
                storage_id = resp.json().get("storageId")
        except (httpx.HTTPError, ValueError, KeyError) as exc:
            raise ApiError(f"convex resume upload failed: {exc}") from exc
        if not storage_id:
            raise ApiError("convex resume upload returned no storageId")
        self._post("mutation", "attachResume",
                   {"user": user, "short": short, "filename": filename,
                    "storageId": storage_id, "secret": self.secret})
        return storage_id

    def put_profile(self, user: str, data: dict) -> None:
        """Upsert a user's resume profile (bank) JSON into the `profiles`
        table, so the Convex-native resume builder can compose a tailored
        .docx without reading the repo. Used by
        scripts/migrate_profiles_to_convex.py to seed a deployment.

        Sent as a JSON string, not the raw dict: Convex field names must be
        non-control ASCII, and profile JSON can carry user-authored dict keys
        (e.g. a project name with an em dash) that fail as object fields with
        an opaque "Server Error". putProfile validates and stores the string
        as-is; the build's reader parses it back out."""
        self._post("mutation", "putProfile",
                   {"user": user, "data": json.dumps(data),
                    "secret": self.secret},
                   module="resume")

    def get_resume_urls(self, user: str) -> dict[str, str]:
        """The deployment's serving URLs for the user's built resumes, one
        batched query (never one round-trip per row). Surfaces link these
        URLs directly; nothing is served from a committed blob. Empty on a
        failed read."""
        try:
            rows = self._post("query", "getResumeUrls",
                              {"user": user, "secret": self.secret})
        except ApiError:
            return {}
        if not rows:
            return {}
        return {row["short"]: row["url"] for row in rows
                if row.get("url")}

    # -- watch prefs ---------------------------------------------------------

    def get_watch_prefs(self, user: str) -> dict | None:
        """The Settings > Watch object, or None (no row yet, or the read
        failed -- logged, since a silent fallback to the yaml would make the
        page's saved values look ignored)."""
        try:
            value = self._post("query", "getWatch",
                               {"user": user, "secret": self.secret},
                               module="settings")
        except ApiError as exc:
            log.warning("watch prefs read failed for %s (%s) -- using the "
                        "yaml alone this run", user, exc)
            return None
        if not isinstance(value, dict):
            return None
        prefs = value.get("watch")
        return prefs if isinstance(prefs, dict) else None

    def put_watch_report(self, user: str, report: dict) -> None:
        """Best-effort: the report is a courtesy to the settings page and
        must never fail the run that produced the matches."""
        try:
            self._post("mutation", "putWatchReport",
                       {"user": user, "report": report, "secret": self.secret},
                       module="settings")
        except ApiError as exc:
            log.warning("watch report push failed for %s (%s)", user, exc)


def make_store(root: Path, user_cfg: dict | None = None) -> TrackerStore:
    """Pick the TrackerStore driver from the STORE env var (default
    `github`). `convex` serves human state through a Convex deployment's
    HTTP API; anything else is a configuration error."""
    name = os.environ.get("STORE", "github")
    if name == "github":
        return GitHubStore(root, user_cfg)
    if name == "convex":
        return ConvexStore(root, user_cfg)
    raise ValueError(f"unknown STORE={name!r} (have: github, convex)")
