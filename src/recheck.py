"""Re-evaluate rejected jobs when the config that rejected them changes.

A rejection is final only while its reason holds. On every rejection the
watcher records, per user, the stage that rejected the job and a fingerprint
of just the config that stage read for this job:

    jobs[key]["rj"] = {"<user>": "<stage>:<8-hex fingerprint>"}

Stages, in pipeline order (filters.UserFilter.evaluate, then the LLM):

- ``role``  include / exclude / strict keyword lists, whether this job comes
  from a strict source, and filters.ROLE_MATCH_VERSION (the matching code).
- ``elim``  the resolved `eliminate:` knobs (grad_only, unpaid, clearance,
  veteran, max age, countries).
- ``term``  the term policy and which of this job's terms are wanted now (so
  a rolling window only touches jobs whose season just entered it).
- ``rules`` the rule conditions that apply to this job's terms, whether its
  company is a priority company, and whether it is on each company list the
  rules name (so adding one tracker company only touches that employer).
- ``llm``   the rules and term fingerprints plus the prose top-company
  definition and the CACHED per-employer verdict for this company.

Each run, a still-listed job (present in this run's fetch) whose recorded
fingerprint differs from the current one is re-run from the top, stage order
unchanged. A deterministic reject on that first pass only refreshes the
record (no LLM, no JD fetch: a JD can only add rejection reasons, never
remove one). A job that now passes or needs the LLM goes through the normal
pipeline, after the run's new jobs, under RECHECK_CAP and the user's LLM cap.
An acceptance is delivered through the outbox and dashboard tagged
[RECHECK] (never the immediate priority email); a reject records the new
fingerprint. Nothing delivered is ever re-evaluated or withdrawn, and jobs
tagged `seeded` (first-sight backlog, src/seeding.py) are never rechecked.

Sticky top-company verdicts are NOT re-judged by a recheck: the verdict in
state["companies"] is reused as is. Editing `top_company_definition` changes
the llm fingerprint, so those jobs are re-run, but against the same cached
verdict, so they stay rejected. Deleting the employer's companies entry (the
existing way to re-judge) also changes the fingerprint, and the re-run then
asks the LLM again. Re-judging every employer on any wording tweak would
spend the LLM budget on employers the edit was never about.

Bootstrap: rejections recorded before this code have no fingerprint. Once per
user, every still-listed, undelivered, non-seeded job with evidence that it
was evaluated is marked ``legacy:`` (a fingerprint that never matches), and
the normal recheck path then works through them under the caps. Evidence of
evaluation: an `llm` entry, or a `first_seen` later than the oldest
`first_seen` in state (the first run seeds everything without evaluating it).
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
from typing import TYPE_CHECKING

from . import state as st
from .filters import ROLE_MATCH_VERSION
from .models import Job

if TYPE_CHECKING:
    from .filters import UserFilter, Verdict

log = logging.getLogger(__name__)

RECHECK_CAP = 50   # rechecked jobs entering the full pipeline per user per run
LEGACY = "legacy"  # bootstrap stage marker; its empty fingerprint never matches

_ROLE_REASONS = ("excluded-keyword", "no-role-keyword", "no-strict-role-keyword")
_TERM_REASONS = ("unknown-term", "term-not-wanted")


def stage_of(verdict: Verdict, after_llm: bool = False) -> str:
    """The stage a reject verdict came from."""
    reason = verdict.reasons[0] if verdict.reasons else ""
    if reason.startswith(_ROLE_REASONS):
        return "role"
    if reason.startswith("eliminated:"):
        return "elim"
    if after_llm:
        return "llm"
    if reason.startswith(_TERM_REASONS):
        return "term"
    return "rules"


def _h(*parts: object) -> str:
    blob = json.dumps(parts, sort_keys=True, default=sorted)
    return hashlib.sha1(blob.encode()).hexdigest()[:8]


def _role_fp(uf: UserFilter, job: Job) -> str:
    strict = bool(set(job.sources) & uf.strict_sources)
    return _h("role", ROLE_MATCH_VERSION, uf.include, uf.exclude,
              uf.strict_include if strict else [], strict)


def _elim_fp(uf: UserFilter) -> str:
    return _h("elim", uf.elim_unpaid, uf.elim_grad_only, uf.elim_phd_only,
              uf.elim_active_clearance, uf.elim_veteran_only,
              uf.elim_max_age_days, sorted(uf.elim_countries or ()))


def _llm_configured(uf: UserFilter) -> bool:
    # The config, not uf.llm_enabled: process_user switches that off when the
    # API key is missing, and a local run without a key must not look like a
    # config change.
    llm = uf.cfg.get("llm") or {}
    return bool(llm.get("enabled"))


def _matched_terms(uf: UserFilter, job: Job) -> set[str]:
    return set(job.terms) & uf.terms_wanted if job.terms else set(uf.terms_wanted)


def _term_fp(uf: UserFilter, job: Job) -> str:
    if job.terms:
        return _h("term", sorted(set(job.terms) & uf.terms_wanted))
    return _h("term", "unknown", uf.unknown_term_policy, _llm_configured(uf),
              "term_inference" in uf.llm_tasks)


def _rules_fp(uf: UserFilter, job: Job) -> str:
    matched = _matched_terms(uf, job)
    conds = [c for r in uf.rules
             if not set(r.get("when", {}).get("term", []))
             or set(r.get("when", {}).get("term", [])) & matched
             for c in r.get("accept_if_any", [])]
    lists = sorted({c["company_in_file"] for c in conds if "company_in_file" in c})
    on_lists = [uf._company_list(p).match(job.company) for p in lists]
    return _h("rules", conds, uf.is_priority(job.company), lists, on_lists)


def _llm_fp(uf: UserFilter, job: Job, state: dict) -> str:
    llm = uf.cfg.get("llm") or {}
    return _h("llm", _rules_fp(uf, job), _term_fp(uf, job),
              llm.get("top_company_definition", ""),
              st.company_top_get(state, job.company, uf.name))


def fingerprint(uf: UserFilter, stage: str, job: Job, state: dict) -> str:
    if stage == "role":
        return _role_fp(uf, job)
    if stage == "elim":
        return _elim_fp(uf)
    if stage == "term":
        return _term_fp(uf, job)
    if stage == "rules":
        return _rules_fp(uf, job)
    if stage == "llm":
        return _llm_fp(uf, job, state)
    return ""


# ------------------------------------------------------------ state record

def get(state: dict, key: str, user: str) -> tuple[str, str] | None:
    rec = state["jobs"].get(key, {}).get("rj", {}).get(user)
    if rec is None:
        return None
    stage, _, fp = rec.partition(":")
    return stage, fp


def record(state: dict, uf: UserFilter, job: Job, stage: str) -> None:
    """Remember that `stage` rejected `job` for this user, and under what."""
    fp = fingerprint(uf, stage, job, state)
    entry = state["jobs"].setdefault(job.dedup_key, {})
    entry.setdefault("rj", {})[uf.name] = f"{stage}:{fp}"


def clear(state: dict, key: str, user: str) -> None:
    entry = state["jobs"].get(key, {})
    rj = entry.get("rj", {})
    if rj.pop(user, None) is not None and not rj:
        del entry["rj"]


# ------------------------------------------------------------ selection

def _eligible(state: dict, key: str, user: str, owned: set[str]) -> bool:
    entry = state["jobs"].get(key)
    if entry is None or entry.get("seeded") or key in owned:
        return False
    return (user not in entry.get("notified_for", [])
            and user not in entry.get("pending", []))


def owned_keys(state: dict, user: str) -> set[str]:
    """Keys this user's outbox or dashboard already holds."""
    return {i.get("key", "") for bucket in ("outbox", "matches")
            for i in state.get(bucket, {}).get(user, [])}


def bootstrap(state: dict, user: str, listed: dict[str, Job],
              skip: set[str], today: dt.date) -> int:
    """One-time per user: mark still-listed legacy rejections for recheck.
    Returns how many were marked (0 once done)."""
    done = state["_meta"].setdefault("recheck_bootstrap", {})
    if user in done:
        return 0
    jobs = state["jobs"]
    oldest = min((e.get("first_seen", "") for e in jobs.values()), default="")
    owned = owned_keys(state, user)
    n = 0
    for key in listed:
        entry = jobs.get(key)
        if (key in skip or entry is None or user in entry.get("rj", {})
                or not _eligible(state, key, user, owned)):
            continue
        if "llm" not in entry and entry.get("first_seen", "") <= oldest:
            continue  # seeded by the first run, never evaluated
        entry.setdefault("rj", {})[user] = f"{LEGACY}:"
        n += 1
    done[user] = today.isoformat()
    log.info("user %s: recheck bootstrap marked %d still-listed legacy "
             "rejection(s) for re-evaluation", user, n)
    return n


def stale(state: dict, uf: UserFilter, listed: dict[str, Job],
          skip: set[str]) -> list[Job]:
    """Still-listed rejected jobs whose fingerprint no longer matches,
    newest first_seen first."""
    owned = owned_keys(state, uf.name)
    out: list[Job] = []
    for key, job in listed.items():
        rec = get(state, key, uf.name)
        if rec is None or key in skip or not _eligible(state, key, uf.name, owned):
            continue
        stage, fp = rec
        if stage == LEGACY or fp != fingerprint(uf, stage, job, state):
            out.append(job)
    out.sort(key=lambda j: state["jobs"][j.dedup_key].get("first_seen", ""),
             reverse=True)
    return out
