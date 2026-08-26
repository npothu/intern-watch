"""The apply queue: turn accepted matches into application attempts.

Reads `state["matches"][user]` (the same snapshots that feed the dashboard /
email), and for each eligible match: resolve the apply URL -> classify the ATS
-> open a browser session -> run the matching filler -> record the outcome back
into state. Two modes:

  autofill  fill + attach the tailored resume, PAUSE before submit (review).
  submit    fill AND submit — but ONLY for matches the user has APPROVED
            (`approved_to_apply` on the snapshot). This is the gate.

Per-match apply bookkeeping is stored on the snapshot dict itself (no schema
change to state.py): `apply_status`, `apply_message`, `applied_at`, and the
existing `applied` flag is set True once a submit is confirmed.
"""

from __future__ import annotations

import datetime as dt
import logging
import re
from dataclasses import dataclass
from pathlib import Path

from .. import dashboard
from .. import ledger as ledger_mod
from .. import state as state_mod
from ..paths import DATA_ROOT as DATA_ROOT
from .auth import Logins, account_for
from .base import ApplyContext, ApplyMode, ApplyResult, ApplyStatus, ATSFamily
from .driver import browser_session
from .fillers import get_filler
from .inbox import Inbox
from .profile import ApplyProfile
from .resolve import resolve

log = logging.getLogger(__name__)

DEFAULT_STATE = DATA_ROOT / "state" / "seen.json"


def resume_path_for(profile: ApplyProfile, company: str) -> Path:
    """Mirror src/resume naming: <First>_<Last>_<Company>.docx in resume_dir."""
    slug = re.sub(r"[^A-Za-z0-9]+", "", company) or "Tailored"
    rd = Path(profile.resume_dir)
    if not rd.is_absolute():
        rd = DATA_ROOT / rd
    return rd / f"{profile.first_name}_{profile.last_name}_{slug}.docx"


@dataclass
class PlanItem:
    """A resolved, ready-to-run application (before the browser is touched)."""

    match: dict
    final_url: str
    family: ATSFamily
    resume_path: Path
    eligible: bool
    skip_reason: str = ""

    @property
    def key(self) -> str:
        return str(self.match.get("key", ""))

    @property
    def company(self) -> str:
        return str(self.match.get("company", ""))


def _already_done(match: dict, user: str = "",
                  ledger: dict | None = None) -> str:
    """The reason this match must NOT be (re-)submitted, or "" when it may run.

    The permanent applications ledger is consulted FIRST and is authoritative:
    a record carrying a submit_attempt means an earlier run actually clicked
    submit (whatever the confirmation check then decided), so we must never
    click again even if the match status looks like an error - that false
    negative is exactly the double-submit chain this guard closes. A ledger
    record WITHOUT a submit_attempt means the user already ticked the job
    applied by hand; auto-applying again is still a duplicate submission, so we
    block that too (and say so). Only THEN do we fall back to the match's own
    applied/submitted flags for callers that pass no ledger."""
    if ledger is not None:
        rec = ledger.get(user, {}).get(dashboard.short_key(str(match.get("key", ""))))
        if rec is not None:
            if rec.get("submit_attempt"):
                return "submit already attempted per ledger"
            return "already applied per ledger"
    if bool(match.get("applied")) or match.get("apply_status") == "submitted":
        return "already applied"
    return ""


def build_plan(matches: list[dict], profile: ApplyProfile, mode: ApplyMode,
               *, only_keys: set[str] | None = None,
               require_resume: bool = True, user: str = "",
               ledger: dict | None = None) -> list[PlanItem]:
    """Resolve each candidate match into a PlanItem. Network only (no browser);
    safe for --dry-run. `eligible` reflects gating: submit mode needs approval,
    a present resume (unless require_resume=False), and a not-already-applied
    job. When a `ledger` (keyed by `user`) is supplied, its records are the
    authoritative no-double-apply guard - see `_already_done`."""
    plan: list[PlanItem] = []
    for m in matches:
        key = str(m.get("key", ""))
        if only_keys is not None and key not in only_keys:
            continue
        url = str(m.get("url", ""))
        if not url:
            continue
        final_url, family = resolve(url)
        rp = resume_path_for(profile, m.get("company", ""))

        eligible, reason = True, ""
        done = _already_done(m, user, ledger)
        if done:
            eligible, reason = False, done
        elif mode is ApplyMode.submit and not m.get("approved_to_apply"):
            eligible, reason = False, "not approved for submit"
        elif require_resume and not rp.exists():
            eligible, reason = False, f"no tailored resume at {rp.name}"

        plan.append(PlanItem(match=m, final_url=final_url, family=family,
                             resume_path=rp, eligible=eligible, skip_reason=reason))
    return plan


def resolve_submit_gate(profile: ApplyProfile, override: bool | None) -> bool:
    """The effective submit-gate setting: an explicit CLI override (True/False)
    wins; otherwise the profile default (`submit_gate`, default True)."""
    if override is not None:
        return override
    return bool(getattr(profile, "submit_gate", True))


def run_item(item: PlanItem, profile: ApplyProfile, mode: ApplyMode,
             user: str, today: dt.date,
             artifacts_root: Path | None = None,
             logins: Logins | None = None,
             submit_gate: bool | None = None,
             ledger_path: Path | None = None) -> ApplyResult:
    """Open a session and run the filler for one PlanItem. Records the outcome
    onto item.match, and - the moment a submit was actually clicked - writes a
    permanent attempt into the applications ledger so this job can never be
    re-submitted (see `_record_submit_attempt`). Never raises - failures become
    an `error` ApplyResult.

    `submit_gate` overrides the profile's default fail-closed gate for this run
    (None -> use the profile setting). `ledger_path` overrides the default
    ledger file (tests)."""
    filler = get_filler(item.family)
    if filler is None:
        res = ApplyResult(status=ApplyStatus.unsupported, family=item.family,
                          message=f"no filler for {item.family.value}",
                          final_url=item.final_url)
        _record(item.match, res, today)
        return res

    artifacts_dir = None
    if artifacts_root is not None:
        artifacts_dir = artifacts_root / (item.key or "job")
        artifacts_dir.mkdir(parents=True, exist_ok=True)

    account = account_for(logins, item.final_url) if logins else None
    inbox = Inbox.from_config(profile.inbox)
    ctx = ApplyContext(job=item.match, profile=profile, resume_path=item.resume_path,
                       mode=mode, final_url=item.final_url, family=item.family,
                       user=user, artifacts_dir=artifacts_dir, account=account,
                       inbox=inbox,
                       submit_gate=resolve_submit_gate(profile, submit_gate))
    try:
        with browser_session(profile, item.family) as page:
            page.goto(item.final_url, wait_until="domcontentloaded")
            res = filler.apply(page, ctx)
    except Exception as exc:                 # session/launch failure
        log.exception("apply failed for %s", item.key)
        res = ApplyResult(status=ApplyStatus.error, family=item.family,
                          message=f"{type(exc).__name__}: {exc}",
                          final_url=item.final_url)
    _record(item.match, res, today)
    if res.submit_attempt is not None:
        _record_submit_attempt(item.match, res, user, today,
                               ledger_path or ledger_mod.ledger_path(DATA_ROOT))
    return res


def _record_submit_attempt(match: dict, res: ApplyResult, user: str,
                           today: dt.date, path: Path) -> None:
    """Persist a submit attempt to the applications ledger, merge-safe: load the
    current file, add/update ONLY this job's record, save. Creating the record
    (via record_applied) snapshots the match so the attempt survives the match
    being pruned; an existing record is left as-is except for its submit_attempt
    field. Never raises - a ledger write failure must not lose the apply result.

    Note: the CLI runs locally, so this write lands in the LOCAL checkout only;
    the watcher's Actions runs do not see it until it is committed. That is fine
    for the guard - the local file still protects local re-drains - but means
    the local and origin/main ledgers can diverge until a commit reconciles."""
    try:
        ledger = ledger_mod.load_ledger(path)
        ledger_mod.record_applied(ledger, user, match, today)  # no-op if present
        short = dashboard.short_key(str(match.get("key", "")))
        rec = ledger.get(user, {}).get(short)
        if rec is not None:
            rec["submit_attempt"] = res.submit_attempt
        ledger_mod.save_ledger(ledger, path)
    except Exception:
        log.warning("ledger submit-attempt write failed for %s",
                    match.get("key", ""), exc_info=True)


def _record(match: dict, res: ApplyResult, today: dt.date) -> None:
    match["apply_status"] = res.status.value
    match["apply_message"] = res.message
    match["apply_family"] = res.family.value
    if res.status is ApplyStatus.submitted:
        match["applied"] = True
        match["applied_at"] = today.isoformat()


def approve(matches: list[dict], key: str, approved: bool = True) -> bool:
    for m in matches:
        if str(m.get("key", "")) == key:
            m["approved_to_apply"] = approved
            return True
    return False


# --- thin state-file helpers so the CLI doesn't reach into src.state directly ---

def load_matches(state_path: Path, user: str) -> tuple[dict, list[dict]]:
    state = state_mod.load_state(state_path)
    return state, state.get("matches", {}).get(user, [])


def save(state: dict, state_path: Path) -> None:
    state_mod.save_state(state, state_path)
