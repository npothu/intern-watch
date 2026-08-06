"""Local HTTP server behind `python -m src.webui`.

Read model: matches come from origin/main's state/seen.json via `git show`
(the Actions-committed authority -- the checkout copy is usually stale), and
the dashboard issue body is overlaid on top, because ticks made on GitHub
since the last cron run live only there.

Write model: the ONLY write path is the dashboard issue's applied checkboxes
-- the same PATCH a human tick performs; the watcher persists them into
seen.json on its next run. Both reads and writes go through the TrackerStore
seam (src.store), which today delegates to the same GitHub mechanism. The
server binds to localhost by default, never mutates the working tree, and
never pushes. Resume builds run the normal local pipeline (src.resume) into
the gitignored out/ directory.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import mimetypes
import re
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .. import dashboard, state as st
from ..models import Job
from ..resume.build import build_for_job
from ..store import (ApiError, TickWrite, TrackerStore, _git, make_store)
from . import core

log = logging.getLogger(__name__)

STATIC = Path(__file__).resolve().parent / "static"

_DOCX_MIME = ("application/vnd.openxmlformats-officedocument"
              ".wordprocessingml.document")
# Committed resume blobs are the only repo paths served from git; anything
# fancier than this shape is refused rather than sanitized.
_REPO_FILE_RE = re.compile(r"^resumes/[A-Za-z0-9._\- /]+\.docx$")
# tick field -> the Hub cache set that mirrors it for rows it writes
# instantly (issue-rendered). Shared by the single and batch paths so the
# optimistic cache and the store stay in lockstep.
_FIELD_ATTR = {"applied": "checked", "saved": "saved",
               "dismissed": "hidden"}
_SHORT_RE = re.compile(r"[0-9a-f]{12}")


class Hub:
    """All mutable server state + the git/GitHub plumbing around it.

    The store (GitHubStore by default) owns the issue/ledger access; the Hub
    keeps the git fetch/show reads, the snapshot shaping, and the pending
    overlay that makes queued writes visible before the workflow commit
    lands on main.
    """

    def __init__(self, root: Path, user: str, terms_order: list[str], *,
                 fetch: bool = True,
                 store: TrackerStore | None = None):
        self.root = root
        self.user = user
        self.terms_order = terms_order
        self.fetch = fetch
        self.store = store or make_store(root, {"name": user})
        self.repo = self.store.repo
        self.token = self.store.token
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
        self.ledger: dict = {}  # this user's book from state/applications.json
        # workflow-dispatched writes not yet visible in state; overlaid on
        # snapshots until the dashboard-write commit lands on main
        self.pending: dict[str, dict] = {}
        self.warnings: list[str] = []

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
        # ledger appears with the first applied tick; absence is normal
        book = self.store.get_ledger(self.user)

        number = state.get("_meta", {}).get("dashboard_issue", {}) \
                      .get(self.user)
        checked = present = hidden = h_present = saved = s_present = None
        issue_url = ""
        self.store.issue_number = number
        if number and self.token and self.repo:
            ticks = self.store.get_ticks(self.user)
            if ticks is None:
                exc_name = self.store.error_name or "HTTPError"
                warnings.append(f"couldn't read dashboard issue #{number} "
                                f"({exc_name}) — applied ticks made on "
                                "GitHub may not show")
            else:
                issue_url = self.store.issue_url
                checked, present = ticks.checked, ticks.present
                hidden, h_present = ticks.hidden, ticks.h_present
                saved, s_present = ticks.saved, ticks.s_present
                # deliberately ignore ticks.issue_open: the webui has always
                # overlaid ticks from closed issues (view-only read-back),
                # unlike the cron which must not repaint a closed dashboard
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
            book = {s: dict(r) for s, r in self.ledger.items()}
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

    def set_ticks_batch(self, field: str, shorts: list[str],
                        on: bool) -> dict:
        """Persist one toggle across many shorts in a single store call
        (one accumulated issue PATCH; off-window rows fall back to one
        workflow dispatch each, surfaced through the pending overlay until
        the commit lands). Validates the field and every short up front.
        Returns the batch payload including which shorts were only queued."""
        attr = _FIELD_ATTR.get(field)
        if attr is None:
            raise ApiError(f"unknown tick field {field!r} "
                           f"(have: {', '.join(_FIELD_ATTR)})")
        if len(shorts) > 500:
            raise ApiError(f"tick batch too large ({len(shorts)} shorts, "
                           f"max 500)")
        bad = next((s for s in shorts if not _SHORT_RE.fullmatch(s)), None)
        if bad is not None:
            raise ApiError(f"bad short key {bad!r} (need 12 lowercase hex)")
        if not self.writable:
            raise ApiError("this state persists through the dashboard "
                           "issue and no GitHub token/issue is available — "
                           "run `gh auth login` and refresh")
        with self.lock:  # serialize read-modify-write PATCHes
            queued = self.store.set_ticks(
                self.user, [TickWrite(s, field, on) for s in shorts])
            for s in shorts:
                if s in queued:
                    self.pending.setdefault(s, {})[field] = on
                else:
                    cache: set[str] | None = getattr(self, attr)
                    if cache is not None:
                        (cache.add if on else cache.discard)(s)
        return {"ok": True, "field": field, "value": on,
                "count": len(shorts), "queued": queued}

    def set_applied(self, short: str, applied: bool) -> dict:
        res = self.set_ticks_batch("applied", [short], applied)
        return {"ok": True, "short": short, "applied": applied,
                "queued": short in res["queued"]}

    def set_dismissed(self, short: str, dismissed: bool) -> dict:
        res = self.set_ticks_batch("dismissed", [short], dismissed)
        return {"ok": True, "short": short, "dismissed": dismissed,
                "queued": short in res["queued"]}

    def set_saved(self, short: str, saved: bool) -> dict:
        res = self.set_ticks_batch("saved", [short], saved)
        return {"ok": True, "short": short, "saved": saved,
                "queued": short in res["queued"]}

    def set_status(self, short: str, status: str, note: str = "") -> dict:
        """Tracker status update — always workflow-mediated (statuses have
        no issue checkbox). The pending overlay carries it until the
        dashboard-write commit lands on main."""
        with self.lock:
            self.store.record_status(self.user, short, status, note)
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

    def _toggle(self, body: dict, field: str) -> dict:
        """Serve both the legacy single-toggle body ({short, <field>}) and
        the batch body ({shorts: [...]}); a single toggle returns the EXACT
        legacy payload shape so a cached page keeps working."""
        on = bool(body.get(field))
        shorts = body.get("shorts")
        if shorts is not None:
            return self.hub.set_ticks_batch(
                field, [str(s) for s in shorts], on)
        short = str(body.get("short", ""))
        res = self.hub.set_ticks_batch(field, [short], on)
        return {"ok": True, "short": short, field: on,
                "queued": short in res["queued"]}

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
                self._json(self._toggle(self._read_body(), "applied"))
            elif self.path == "/api/dismissed":
                self._json(self._toggle(self._read_body(), "dismissed"))
            elif self.path == "/api/saved":
                self._json(self._toggle(self._read_body(), "saved"))
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
