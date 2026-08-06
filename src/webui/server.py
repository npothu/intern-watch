"""Local HTTP server behind `python -m src.webui`.

Read model: matches come from origin/main's state/seen.json via `git show`
(the Actions-committed authority -- the checkout copy is usually stale), and
the dashboard issue body is overlaid on top, because ticks made on GitHub
since the last cron run live only there.

Write model: the ONLY write path is the dashboard issue's applied checkboxes
-- the same PATCH a human tick performs; the watcher persists them into
seen.json on its next run. The server binds to localhost by default, never
mutates the working tree, and never pushes. Resume builds run the normal
local pipeline (src.resume) into the gitignored out/ directory.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import mimetypes
import os
import re
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx

from .. import dashboard, ledger, state as st
from ..models import Job
from ..resume.build import build_for_job
from . import core

log = logging.getLogger(__name__)

API = "https://api.github.com"
STATIC = Path(__file__).resolve().parent / "static"

_DOCX_MIME = ("application/vnd.openxmlformats-officedocument"
              ".wordprocessingml.document")
# Committed resume blobs are the only repo paths served from git; anything
# fancier than this shape is refused rather than sanitized.
_REPO_FILE_RE = re.compile(r"^resumes/[A-Za-z0-9._\- /]+\.docx$")


class ApiError(Exception):
    """User-visible request failure (rendered as JSON with its message)."""


def _git(root: Path, *args: str) -> bytes:
    proc = subprocess.run(["git", "-C", str(root), *args],
                          capture_output=True, check=True)
    return proc.stdout


def detect_repo(root: Path) -> str:
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
    tok = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if tok:
        return tok
    try:  # the user is authenticated through the gh CLI locally
        proc = subprocess.run(["gh", "auth", "token"], capture_output=True,
                              text=True, check=True)
        return proc.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


class Hub:
    """All mutable server state + the git/GitHub plumbing around it."""

    def __init__(self, root: Path, user: str, terms_order: list[str], *,
                 fetch: bool = True):
        self.root = root
        self.user = user
        self.terms_order = terms_order
        self.fetch = fetch
        self.repo = detect_repo(root)
        self.token = detect_token()
        self.lock = threading.Lock()
        self.state: dict = st.empty_state()
        self.fetched_main = False
        self.issue_number: int | None = None
        self.issue_url = ""
        self.checked: set[str] | None = None
        self.present: set[str] | None = None
        self.hidden: set[str] | None = None
        self.h_present: set[str] | None = None
        self.saved: set[str] | None = None
        self.s_present: set[str] | None = None
        self.local_resumes: dict[str, str] = {}  # short -> filename in out/
        self.ledger: dict = {}  # state/applications.json from origin/main
        # workflow-dispatched writes not yet visible in state; overlaid on
        # snapshots until the dashboard-write commit lands on main
        self.pending: dict[str, dict] = {}
        self.warnings: list[str] = []

    # -- GitHub issue plumbing ------------------------------------------

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self.token}",
                "Accept": "application/vnd.github+json",
                "User-Agent": "intern-watch webui (local)"}

    def _issue_get(self, client: httpx.Client, number: int) -> dict:
        resp = client.get(f"{API}/repos/{self.repo}/issues/{number}")
        resp.raise_for_status()
        return resp.json()

    @property
    def writable(self) -> bool:
        return bool(self.token and self.repo and self.issue_number)

    # -- refresh --------------------------------------------------------

    def refresh(self) -> None:
        """Re-read origin/main state and the dashboard issue. Degrades to
        the checkout's seen.json (with a visible warning) when offline."""
        warnings: list[str] = []
        if self.fetch:
            try:
                _git(self.root, "fetch", "origin", "main", "-q")
            except (OSError, subprocess.CalledProcessError):
                warnings.append("git fetch failed (offline?) — matches may "
                                "lag behind the last watcher run")
        try:
            state = json.loads(
                _git(self.root, "show", "origin/main:state/seen.json"))
            fetched_main = True
        except (OSError, subprocess.CalledProcessError, ValueError):
            state = st.load_state(self.root / "state" / "seen.json")
            fetched_main = False
            warnings.append("couldn't read state from origin/main — showing "
                            "the local checkout's copy")
        try:  # ledger appears with the first applied tick; absence is normal
            book = json.loads(
                _git(self.root, "show",
                     "origin/main:state/applications.json"))
        except (OSError, subprocess.CalledProcessError, ValueError):
            book = ledger.load_ledger(
                self.root / "state" / "applications.json")

        number = state.get("_meta", {}).get("dashboard_issue", {}) \
                      .get(self.user)
        checked = present = hidden = h_present = saved = s_present = None
        issue_url = ""
        if number and self.token and self.repo:
            try:
                with httpx.Client(headers=self._headers(),
                                  timeout=30.0) as client:
                    issue = self._issue_get(client, number)
                issue_url = issue.get("html_url", "")
                body = issue.get("body") or ""
                checked, present = dashboard.parse_checkboxes(body)
                hidden, h_present = dashboard.parse_dismissed(body)
                saved, s_present = dashboard.parse_saved(body)
            except httpx.HTTPError as exc:
                warnings.append(f"couldn't read dashboard issue #{number} "
                                f"({exc.__class__.__name__}) — applied ticks "
                                "made on GitHub may not show")
        elif number:
            warnings.append("no GitHub token (set GITHUB_TOKEN or log in "
                            "with `gh auth login`) — applied toggles are "
                            "read-only this session")

        with self.lock:
            self.state = state
            self.ledger = book
            self.fetched_main = fetched_main
            self.issue_number = number
            self.issue_url = issue_url
            self.checked, self.present = checked, present
            self.hidden, self.h_present = hidden, h_present
            self.saved, self.s_present = saved, s_present
            self.warnings = warnings

    # -- reads ----------------------------------------------------------

    def snapshot(self) -> dict:
        today = dt.datetime.now(dt.timezone.utc).date()
        with self.lock:
            matches = core.shape_matches(
                st.matches_items(self.state, self.user),
                self.checked, self.present, self.hidden, self.h_present,
                self.saved, self.s_present)
            jobs = self.state.get("jobs", {})
            local = dict(self.local_resumes)
            book = {s: dict(r)
                    for s, r in self.ledger.get(self.user, {}).items()}
            payload = {
                "applications": book,
                "user": self.user,
                "generated": dt.datetime.now(dt.timezone.utc)
                               .isoformat(timespec="seconds"),
                "fetched_main": self.fetched_main,
                "warnings": list(self.warnings),
                "terms_order": list(self.terms_order),
                "issue": {"number": self.issue_number, "url": self.issue_url,
                          "writable": self.writable},
                "repo": self.repo,
            }
        for item in matches:
            if item["short"] in local:
                item["local_resume"] = local[item["short"]]
            rec = book.get(item["short"])
            if rec:  # tracker status from the permanent ledger
                item["status"] = rec.get("status")
            # staleness: a match gone from every source is probably a closed
            # posting -- the frontend badges it and can filter on it
            last = jobs.get(item.get("key"), {}).get("last_seen")
            if last:
                try:
                    item["stale_days"] = (
                        today - dt.date.fromisoformat(last)).days
                except ValueError:
                    pass
        with self.lock:
            # a queued status may target a record whose match was pruned, so
            # it can't drain through the matches overlay: reconcile against
            # the ledger book first, then overlay the rest onto both views
            for s in list(self.pending):
                fields = self.pending[s]
                if fields.get("status") and \
                        book.get(s, {}).get("status") == fields["status"]:
                    del fields["status"]
                    if not fields:
                        del self.pending[s]
            self.pending = core.overlay_pending(matches, self.pending)
            for s, fields in self.pending.items():
                rec = book.get(s)
                if rec and "status" in fields:
                    rec["status"] = fields["status"]
                    rec["pending"] = True
        core.attach_artifacts(
            matches,
            core.artifact_index(self.root / "state" / "apply_artifacts"))
        payload["matches"] = matches
        return payload

    def _find_item(self, short: str) -> dict | None:
        with self.lock:
            for item in st.matches_items(self.state, self.user):
                if dashboard.short_key(item.get("key", "")) == short:
                    return dict(item)
        return None

    # -- writes ---------------------------------------------------------

    def _dispatch_write(self, client: httpx.Client, short: str, field: str,
                        value: str, note: str = "") -> None:
        """Queue a dashboard-write workflow run: Actions edits the match /
        ledger record in state directly and repaints the issue. Used for
        rows outside the issue's rendered window (no checkbox to PATCH) and
        for tracker statuses (no issue representation at all)."""
        inputs = {"user": self.user, "short": short,
                  "field": field, "value": value}
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

    def _write_box(self, flip, short: str, on: bool, cache_attr: str,
                   field: str) -> bool:
        """Set one per-row toggle. Rendered rows get the instant checkbox
        PATCH; unrendered rows fall back to a workflow-dispatched state
        write. Returns True when the write was queued (not yet on main)."""
        if not self.writable:
            raise ApiError("this state persists through the dashboard "
                           "issue and no GitHub token/issue is available — "
                           "run `gh auth login` and refresh")
        with self.lock:  # serialize read-modify-write PATCHes
            with httpx.Client(headers=self._headers(),
                              timeout=30.0) as client:
                issue = self._issue_get(client, self.issue_number)
                body = flip(issue.get("body") or "", short, on)
                if body is None:
                    self._dispatch_write(client, short, field,
                                         "true" if on else "false")
                    self.pending.setdefault(short, {})[field] = on
                    return True
                resp = client.patch(
                    f"{API}/repos/{self.repo}/issues/{self.issue_number}",
                    json={"body": body})
                resp.raise_for_status()
            cache: set[str] | None = getattr(self, cache_attr)
            if cache is not None:
                (cache.add if on else cache.discard)(short)
        return False

    def set_applied(self, short: str, applied: bool) -> dict:
        queued = self._write_box(core.flip_applied, short, applied,
                                 "checked", "applied")
        return {"ok": True, "short": short, "applied": applied,
                "queued": queued}

    def set_dismissed(self, short: str, dismissed: bool) -> dict:
        queued = self._write_box(core.flip_dismissed, short, dismissed,
                                 "hidden", "dismissed")
        return {"ok": True, "short": short, "dismissed": dismissed,
                "queued": queued}

    def set_saved(self, short: str, saved: bool) -> dict:
        queued = self._write_box(core.flip_saved, short, saved,
                                 "saved", "saved")
        return {"ok": True, "short": short, "saved": saved,
                "queued": queued}

    def set_status(self, short: str, status: str, note: str = "") -> dict:
        """Tracker status update — always workflow-mediated (statuses have
        no issue checkbox). The pending overlay carries it until the
        dashboard-write commit lands on main."""
        if status not in ledger.STATUSES:
            raise ApiError(f"unknown status {status!r} (have: "
                           f"{', '.join(ledger.STATUSES)})")
        if not (self.token and self.repo):
            raise ApiError("status updates dispatch a workflow and no "
                           "GitHub token is available — run `gh auth "
                           "login` and refresh")
        with self.lock:
            with httpx.Client(headers=self._headers(),
                              timeout=30.0) as client:
                self._dispatch_write(client, short, "status", status, note)
            # a status implies an application: overlay both
            self.pending.setdefault(short, {}).update(
                {"status": status, "applied": True})
        return {"ok": True, "short": short, "status": status,
                "queued": True}

    def build_resume(self, short: str, jd_text: str = "") -> dict:
        item = self._find_item(short)
        if item is None:
            raise ApiError(f"no match with short key {short!r} for user "
                           f"{self.user!r}")
        job = Job(company=item.get("company", ""),
                  title=item.get("title", ""), url=item.get("url", ""),
                  source="webui", dedup_key=item["key"],
                  jobright_id=item.get("jobright_id"),
                  jd_url=item.get("jd_url"))
        out_dir = self.root / "out"
        out_dir.mkdir(exist_ok=True)
        result = build_for_job(job, self.user, out_dir=out_dir,
                               root=self.root, allow_scrape=True,
                               jd_text=jd_text or None)
        if result is None:
            return {"ok": False, "needs_jd": True,
                    "error": f"no JD reachable for {job.company} — the site "
                             "may block bots; paste the JD text and retry"}
        # out/<short>/<Clean_Name>.docx — keep the subdir in the served path
        rel = result.out_path.relative_to(out_dir).as_posix()
        with self.lock:
            self.local_resumes[short] = rel
        return {"ok": True, "short": short, "file": rel,
                "path": f"/files/out/{rel}", "pages": round(result.pages, 2),
                "used_llm": result.used_llm, "report": result.report}


class Handler(BaseHTTPRequestHandler):
    hub: Hub  # injected by make_server

    # -- helpers --------------------------------------------------------

    def _json(self, obj: dict, code: int = 200) -> None:
        blob = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)

    def _read_body(self) -> dict:
        try:
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}")
        except (ValueError, json.JSONDecodeError) as exc:
            raise ApiError(f"bad request body: {exc}") from exc

    def _file(self, data: bytes, ctype: str, filename: str = "") -> None:
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if filename:
            self.send_header("Content-Disposition",
                             f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args) -> None:  # quiet by default
        log.debug("%s %s", self.address_string(), fmt % args)

    # -- routes ---------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 (http.server API)
        path = self.path.split("?", 1)[0]
        try:
            if path in ("/", "/index.html"):
                page = (STATIC / "index.html").read_bytes()
                self._file(page, "text/html; charset=utf-8")
            elif path == "/api/state":
                self._json(self.hub.snapshot())
            elif path.startswith("/files/"):
                self._serve_file(path[len("/files/"):])
            else:
                self._json({"error": "not found"}, 404)
        except ApiError as exc:
            self._json({"error": str(exc)}, 400)
        except Exception:  # noqa: BLE001 — surface, don't kill the thread
            log.exception("GET %s failed", path)
            self._json({"error": "internal error (see server log)"}, 500)

    def do_POST(self) -> None:  # noqa: N802
        try:
            if self.path == "/api/refresh":
                self.hub.refresh()
                self._json(self.hub.snapshot())
            elif self.path == "/api/applied":
                body = self._read_body()
                self._json(self.hub.set_applied(str(body.get("short", "")),
                                                bool(body.get("applied"))))
            elif self.path == "/api/dismissed":
                body = self._read_body()
                self._json(self.hub.set_dismissed(
                    str(body.get("short", "")),
                    bool(body.get("dismissed"))))
            elif self.path == "/api/saved":
                body = self._read_body()
                self._json(self.hub.set_saved(str(body.get("short", "")),
                                              bool(body.get("saved"))))
            elif self.path == "/api/status":
                body = self._read_body()
                self._json(self.hub.set_status(
                    str(body.get("short", "")),
                    str(body.get("status", "")),
                    str(body.get("note", "")).strip()))
            elif self.path == "/api/resume":
                body = self._read_body()
                self._json(self.hub.build_resume(
                    str(body.get("short", "")),
                    str(body.get("jd_text", "")).strip()))
            else:
                self._json({"error": "not found"}, 404)
        except ApiError as exc:
            self._json({"error": str(exc)}, 400)
        except Exception:  # noqa: BLE001
            log.exception("POST %s failed", self.path)
            self._json({"error": "internal error (see server log)"}, 500)

    def _serve_file(self, rel: str) -> None:
        from urllib.parse import unquote
        rel = unquote(rel)
        if rel.startswith("out/"):
            p = core.safe_join(self.hub.root / "out", rel[len("out/"):])
            if p is None:
                raise ApiError("no such file")
            self._file(p.read_bytes(), _DOCX_MIME, p.name)
        elif rel.startswith("artifacts/"):
            p = core.safe_join(
                self.hub.root / "state" / "apply_artifacts",
                rel[len("artifacts/"):])
            if p is None:
                raise ApiError("no such artifact")
            ctype = mimetypes.guess_type(p.name)[0] or \
                "application/octet-stream"
            self._file(p.read_bytes(), ctype)
        elif rel.startswith("repo/"):
            # committed resumes live only on origin/main (Actions commits
            # them); serve the blob straight from git, never the checkout
            blob = rel[len("repo/"):]
            if not _REPO_FILE_RE.fullmatch(blob) or ".." in blob:
                raise ApiError("no such file")
            try:
                data = _git(self.hub.root, "show", f"origin/main:{blob}")
            except subprocess.CalledProcessError as exc:
                raise ApiError("file not on origin/main") from exc
            self._file(data, _DOCX_MIME, Path(blob).name)
        else:
            raise ApiError("no such file")


def make_server(hub: Hub, host: str, port: int) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {"hub": hub})
    return ThreadingHTTPServer((host, port), handler)
