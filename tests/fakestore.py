"""In-memory TrackerStore for tests.

Ticks, the ledger book, recorded statuses and the pushed match snapshot all
live in plain dicts: set_ticks applies instantly and reports nothing queued,
push_matches stores for get_matches. Use it to test Hub wiring (or any store
consumer) without touching the network or git. Structurally satisfies
src.store.TrackerStore, including the repo/token/issue plumbing fields the
webui reads.
"""

from __future__ import annotations

from src.store import TicksView, TickWrite


class FakeStore:
    """TrackerStore stand-in (structural, not a runtime Protocol check)."""

    def __init__(self) -> None:
        self.repo = ""
        self.token = ""
        self.issue_number: int | None = None
        self.issue_url = ""
        self.error_name: str | None = None
        self.read_warning: str | None = None
        self.ticks: dict[str, TicksView | None] = {}
        self.ledger: dict[str, dict] = {}
        self.matches: dict[str, list[dict] | None] = {}
        self.statuses: list[tuple[str, str, str, str]] = []
        # mail-sync: configurable inbox (None = unavailable) + a record of
        # resolve calls and a configurable error to raise
        self.actions: dict | None = None
        self.resolve_calls: list[tuple[str, str, str, str, bool]] = []
        self.resolve_error: Exception | None = None
        self.resumes: dict[str, dict[str, tuple[str, bytes]]] = {}
        # shorts whose resume get_resume_urls serves as a remote URL (a
        # hosted store) rather than the default GitHub repo-relative path.
        self.remote_resumes: set[str] = set()

    @property
    def writable(self) -> bool:
        return bool(self.token and self.repo and self.issue_number)

    def get_ticks(self, user: str) -> TicksView | None:
        return self.ticks.get(user)

    def set_ticks(self, user: str, writes: list[TickWrite]) -> list[str]:
        """Apply instantly to the stored view (creating an empty one when
        none was registered), queue nothing."""
        view = self.ticks.setdefault(user, TicksView())
        for w in writes:
            target, present = {
                "applied": ("checked", "present"),
                "saved": ("saved", "s_present"),
                "dismissed": ("hidden", "h_present"),
            }.get(w.field, (None, None))
            if target is None:
                raise ValueError(f"unknown tick field {w.field!r}")
            bucket, pset = getattr(view, target), getattr(view, present)
            if w.value:
                bucket.add(w.short)
            else:
                bucket.discard(w.short)
            # presence means "rendered" independent of value: the rendered-
            # only rule in shape_matches needs the short in the matching
            # *_present set or the tick it wrote here is silently dropped
            pset.add(w.short)
        return []

    def get_ledger(self, user: str) -> dict:
        return self.ledger.get(user, {})

    def record_status(self, user: str, short: str, status: str,
                      note: str = "") -> None:
        self.statuses.append((user, short, status, note))

    def push_matches(self, user: str, matches: list[dict]) -> None:
        self.matches[user] = list(matches)

    def get_matches(self, user: str) -> list[dict] | None:
        return self.matches.get(user)

    def get_actions(self, user: str) -> dict | None:
        """The configured inbox, or None when mail sync is unavailable."""
        return self.actions

    def resolve_action(self, user: str, action_id: str, short: str = "",
                       status: str = "", dismiss: bool = False) -> None:
        self.resolve_calls.append((user, action_id, short, status, dismiss))
        if self.resolve_error is not None:
            raise self.resolve_error

    def put_resume(self, user: str, short: str, filename: str,
                   data: bytes) -> str:
        """Record the resume, returning the default GitHub-shape
        repo-relative path (the same reference the repo-committed flow uses)."""
        self.resumes.setdefault(user, {})[short] = (filename, data)
        return f"resumes/{user}/{short}/{filename}"

    def get_resume_urls(self, user: str) -> dict[str, str]:
        """Only the STORE-HOSTED (http/https) subset, matching the real
        drivers' contract: GitHubStore returns {}, a hosted store returns a
        serving URL per short."""
        return {
            short: f"https://store.example/files/{short}"  # hosted store
            for short in self.resumes.get(user, {})
            if short in self.remote_resumes
        }
