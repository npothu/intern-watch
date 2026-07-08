"""Shared contracts for the auto-apply subsystem.

These types are the stable interface every other module in `src/apply/` builds
against — the resolver produces an `ATSFamily`, the drivers hand a Playwright
`Page` to a `Filler`, and every filler returns an `ApplyResult`. Keep this file
dependency-light (no Playwright import at module load) so it can be imported in
plain unit tests.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

if TYPE_CHECKING:                       # type-only; never imported at runtime
    from playwright.sync_api import Page

    from .auth import LoginAccount
    from .profile import ApplyProfile


class ATSFamily(str, Enum):
    """Application-tracking system behind a final (post-redirect) apply URL."""

    greenhouse = "greenhouse"
    workday = "workday"
    lever = "lever"
    ashby = "ashby"
    unknown = "unknown"                  # no deterministic filler -> LLM agent


class ApplyMode(str, Enum):
    autofill = "autofill"               # fill, attach resume, then PAUSE for a human
    submit = "submit"                   # fill AND submit (gating happens upstream)


class ApplyStatus(str, Enum):
    submitted = "submitted"             # form submitted, confirmation observed
    filled_paused = "filled_paused"     # filled and left for human review/submit
    blocked_login = "blocked_login"     # auth/MFA wall — needs interactive login
    blocked_captcha = "blocked_captcha"  # CAPTCHA — cannot proceed unattended
    # A REQUIRED field was left unfilled, so submit was refused BEFORE clicking
    # (fail-closed). Detected-required is a lower bound, never a completeness
    # guarantee; .unfilled_fields carries the blocking field labels.
    blocked_incomplete = "blocked_incomplete"
    unsupported = "unsupported"         # ATS family has no filler (manual apply)
    error = "error"                     # unexpected failure (see .message)

    @property
    def ok(self) -> bool:
        return self in (ApplyStatus.submitted, ApplyStatus.filled_paused)


@dataclass
class ApplyContext:
    """Everything a filler needs for one application attempt.

    `job` is the display-ready match snapshot from `state["matches"][user]`
    (keys: key, company, title, url, location, ...). `final_url` is the
    post-redirect destination from the resolver; `family` its classification.
    """

    job: dict[str, Any]
    profile: "ApplyProfile"
    resume_path: Path
    mode: ApplyMode
    final_url: str
    family: ATSFamily
    user: str = "example"
    # Where to drop pause-time screenshots / artifacts for this attempt.
    artifacts_dir: Path | None = None
    # Resolved login for this ATS, if the user supplied credentials. Fillers
    # behind an auth wall (Workday) sign in — or register — with this.
    account: "LoginAccount | None" = None
    # Optional inbox.Inbox for resolving emailed verification links / OTP codes
    # during account creation. None disables email resolution.
    inbox: Any = None
    # Fail-closed submit gate: when True (default), submit mode refuses to click
    # if a REQUIRED field is unfilled (-> blocked_incomplete). Off restores the
    # prior fire-and-submit behavior. Resolved from the profile + a CLI override.
    submit_gate: bool = True

    @property
    def dedup_key(self) -> str:
        return str(self.job.get("key", ""))


@dataclass
class ApplyResult:
    """Outcome of one application attempt. Returned by every Filler.apply()."""

    status: ApplyStatus
    family: ATSFamily
    message: str = ""
    final_url: str = ""
    filled_fields: list[str] = field(default_factory=list)
    screenshot_path: Path | None = None
    # Fields the filler could not map (surfaced to the human in autofill mode).
    unfilled_fields: list[str] = field(default_factory=list)
    # Set the MOMENT the submit control was clicked (whatever happens after), so
    # the queue can write a permanent ledger attempt and never re-submit this job
    # even when confirmation detection returns a false negative. Keys:
    # on, family, final_url, confirmed, signal, screenshot. None => no click.
    submit_attempt: dict[str, Any] | None = None

    @property
    def ok(self) -> bool:
        return self.status.ok


@runtime_checkable
class Filler(Protocol):
    """One ATS family's form driver. Stateless: all inputs arrive via `ctx`."""

    family: ATSFamily

    def apply(self, page: "Page", ctx: ApplyContext) -> ApplyResult:
        """Drive `page` (already navigated to ctx.final_url) through the form.

        Must respect ctx.mode: in `autofill` mode fill + attach the resume and
        return `filled_paused` WITHOUT clicking the final submit; in `submit`
        mode complete and submit, returning `submitted` only after observing a
        confirmation. Return a `blocked_*`/`unsupported`/`error` status instead
        of raising whenever the form cannot be completed unattended.
        """
        ...
