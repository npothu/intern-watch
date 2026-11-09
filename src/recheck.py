"""Re-evaluate rejected jobs when the config that rejected them changes.

A rejection is final only while its reason holds. On every rejection the
watcher records, per user, the stage that rejected the job and a fingerprint
of just the config that stage read for this job:

    jobs[key]["rj"] = {"<user>": "<stage>:<8-hex fingerprint>"}

Stages, in pipeline order (filters.UserFilter.evaluate, then the LLM):

- ``role``  include / exclude / strict keyword lists, whether this job comes
  from a strict source, and filters.ROLE_MATCH_VERSION (the matching code).
- ``elim``  the resolved `eliminate:` knobs (grad_only, unpaid, clearance,
  veteran, max age, countries) and filters.ELIM_MATCH_VERSION.
- ``term``  the term policy and which of this job's terms (its source term,
  else its cached LLM term) are wanted now, so a rolling window only touches
  jobs whose season just entered it.
- ``rules`` the rule conditions that apply to this job's terms, whether its
  company is a priority company, whether it is on each company list the
  rules name (so adding one tracker company only touches that employer), and
  the configured LLM flag and tasks (turning the model on rechecks these).

A run whose configured LLM is unavailable (API key missing) skips rechecks:
without the model an unknown term reads as accepted and a top-company rule
hard-rejects, and either verdict would be committed for good.
- ``llm``   the rules and term fingerprints plus the prose top-company
  definition and the CACHED per-employer verdict for this company.

Each run, a still-listed job (present in this run's fetch) whose recorded
fingerprint differs from the current one is re-run from the top, stage order
unchanged. A deterministic reject on that first pass only refreshes the
record (no LLM, no JD fetch: a JD can only add rejection reasons, never
remove one). A job that now passes or needs the LLM goes through the normal
pipeline, after the run's new jobs, under a per-run cap, the user's LLM cap
and a daily delivery budget (`limits()`: the user yaml's `recheck:` block,
defaulting to RECHECK_CAP and RECHECK_DAILY_DELIVERIES).
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

Bootstrap: rejections recorded before this code have no fingerprint. Every
run, each still-listed, undelivered, non-seeded job first seen on or before
the user's bootstrap date (`_meta.recheck_bootstrap`) with no record and
evidence that it was evaluated is marked ``legacy:`` (a fingerprint that
never matches), and the normal recheck path then works through them under
the caps. Evidence of
evaluation: an `llm` entry, or a `first_seen` later than the seed day (the
oldest `first_seen` when the bootstrap first ran, stored then: the first run
seeds everything without evaluating it). An entry with no `first_seen` is
skipped.
Keys recorded under a content signature (state["content"]) are skipped: they
were accepted and then delivered or suppressed as a content duplicate.
Limit: the evidence is per job, not per user, so a user added to an instance
after a job's first_seen can get it via the bootstrap.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
from collections.abc import Iterable
from typing import TYPE_CHECKING

from . import state as st
from .filters import ELIM_MATCH_VERSION, ROLE_MATCH_VERSION
from .models import Job

if TYPE_CHECKING:
    from .filters import UserFilter, Verdict

log = logging.getLogger(__name__)

RECHECK_CAP = 50   # rechecked jobs entering the full pipeline per user per run
# Recheck deliveries per user per day. The digest goes out at a few fixed
# slots, so a per-run cap alone would still pile a big config change (or the
# bootstrap: ~160 recoveries on the reference instance) into one or two
# digests. Once today's budget is spent, rechecks wait for tomorrow (their
# fingerprint stays stale, so nothing is lost).
RECHECK_DAILY_DELIVERIES = 40
RECHECK_LIMIT_MAX = 2000   # config_check's sanity bound for both knobs


def limits(cfg: dict) -> tuple[int | None, int]:
    """(daily delivery limit or None for unlimited, re-runs per run) for a
    user, from the yaml/overlaid config's optional `recheck:` block:
    `daily_limit` (int; null = no daily limit, 0 = no recheck deliveries)
    and `per_run` (int; 0 pauses pipeline rechecks). With either at 0 the
    free re-fingerprint pass and bootstrap marking still run.
    Defaults are the module constants. A malformed value falls back to the
    default (config_check reports it) rather than taking the watcher down."""
    block = cfg.get("recheck")
    block = block if isinstance(block, dict) else {}

    def _int(value: object) -> int | None:
        """A real int in 0..RECHECK_LIMIT_MAX (bools and floats are not),
        else None (malformed)."""
        if (isinstance(value, bool) or not isinstance(value, int)
                or not 0 <= value <= RECHECK_LIMIT_MAX):
            return None
        return value

    daily: int | None = RECHECK_DAILY_DELIVERIES
    if "daily_limit" in block:
        raw = block["daily_limit"]
        if raw is None:                  # null: no daily limit
            daily = None
        elif (v := _int(raw)) is not None:
            daily = v                    # 0: no recheck deliveries (paused)
    per_run = _int(block.get("per_run"))
    return daily, RECHECK_CAP if per_run is None else per_run
LEGACY = "legacy"  # bootstrap stage marker; its empty fingerprint never matches
RECHECK_REASON = "recheck"   # reasons marker on a re-evaluated rejection

_ROLE_REASONS = ("excluded-keyword", "no-role-keyword", "no-strict-role-keyword")
_TERM_REASONS = ("unknown-term", "term-not-wanted")


def stage_of(verdict: Verdict, after_llm: bool = False) -> str:
    """The stage a reject verdict came from."""
    reason = verdict.reasons[0] if verdict.reasons else ""
    if reason.startswith(_ROLE_REASONS):
        return "role"
    if reason.startswith("eliminated:"):
        return "elim"
    if reason.startswith(_TERM_REASONS):
        return "term"   # also an LLM-inferred term that is not wanted
    if after_llm:
        return "llm"
    return "rules"


def _h(*parts: object) -> str:
    blob = json.dumps(parts, sort_keys=True, default=sorted)
    return hashlib.sha1(blob.encode()).hexdigest()[:8]


def _role_fp(uf: UserFilter, job: Job, state: dict) -> str:
    strict = bool(set(job.sources) & uf.strict_sources)
    return _h("role", ROLE_MATCH_VERSION, uf.include, uf.exclude,
              uf.strict_include if strict else [], strict)


def _elim_fp(uf: UserFilter, job: Job, state: dict) -> str:
    return _h("elim", ELIM_MATCH_VERSION, uf.elim_unpaid, uf.elim_grad_only,
              uf.elim_phd_only, uf.elim_active_clearance, uf.elim_veteran_only,
              uf.elim_max_age_days, sorted(uf.elim_countries or ()))


def llm_configured(uf: UserFilter) -> bool:
    # The config, not uf.llm_enabled: process_user switches that off when the
    # API key is missing, and a local run without a key must not look like a
    # config change.
    llm = uf.cfg.get("llm") or {}
    return bool(llm.get("enabled"))


def _terms(job: Job, state: dict) -> tuple[list[str], bool]:
    """(terms the pipeline judged the job on, whether they came from the JD
    body): a source term, else the JD-inferred term kept at record time,
    else the cached LLM term. The JD and LLM terms are written onto the
    run's Job only, and the next run's freshly fetched Job has neither, yet
    both must hash alike."""
    if job.terms:
        return list(job.terms), job.terms_from_jd
    kept = inferred_terms(state, job.dedup_key)
    if kept:
        return kept
    term = st.llm_cache_get(state, job.dedup_key).get("term")
    return ([term] if term else []), False


def _judged_terms(uf: UserFilter, job: Job, state: dict) -> list[str] | None:
    """The terms evaluate() acted on, or None when it treated the term as
    unknown: no term at all, or a JD term this user does not want (a JD
    term is accept-only, filters.UserFilter.evaluate)."""
    terms, from_jd = _terms(job, state)
    if not terms or (from_jd and not set(terms) & uf.terms_wanted):
        return None
    return terms


def _term_fp(uf: UserFilter, job: Job, state: dict) -> str:
    terms = _judged_terms(uf, job, state)
    if terms is not None:
        return _h("term", sorted(set(terms) & uf.terms_wanted))
    return _h("term", "unknown", uf.unknown_term_policy, llm_configured(uf),
              "term_inference" in uf.llm_tasks)


def _rules_fp(uf: UserFilter, job: Job, state: dict) -> str:
    terms = _judged_terms(uf, job, state)
    matched = (set(terms) & uf.terms_wanted if terms is not None
               else set(uf.terms_wanted))
    conds = []
    for rule in uf.rules:
        when = set(rule.get("when", {}).get("term", []))
        if not when or when & matched:
            conds.extend(rule.get("accept_if_any", []))
    lists = sorted({c["company_in_file"] for c in conds if "company_in_file" in c})
    on_lists = [uf._company_list(p).match(job.company) for p in lists]
    # The configured LLM (the yaml flag and tasks, never "is the key set"):
    # turning top-company / metro judgment on must recheck rules rejects.
    return _h("rules", conds, uf.is_priority(job.company), lists, on_lists,
              llm_configured(uf), sorted(uf.llm_tasks))


def _llm_fp(uf: UserFilter, job: Job, state: dict) -> str:
    llm = uf.cfg.get("llm") or {}
    return _h("llm", _rules_fp(uf, job, state), _term_fp(uf, job, state),
              llm.get("top_company_definition", ""),
              st.company_top_get(state, job.company, uf.name))


_FINGERPRINTS = {"role": _role_fp, "elim": _elim_fp, "term": _term_fp,
                 "rules": _rules_fp, "llm": _llm_fp}


def fingerprint(uf: UserFilter, stage: str, job: Job, state: dict) -> str:
    fp = _FINGERPRINTS.get(stage)
    return fp(uf, job, state) if fp else ""


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
    if job.terms and (job.terms_inferred or job.terms_from_jd):
        # main.infer_terms_from_jds read it from the JD body or the URL; a
        # later run's fresh Job may not (its body is fetched lazily): keep
        # the term it was judged on.
        entry["inferred_terms"] = {"terms": list(job.terms),
                                   "jd": bool(job.terms_from_jd)}
    elif job.terms:
        entry.pop("inferred_terms", None)   # a source/LLM term now


def inferred_terms(state: dict, key: str) -> tuple[list[str], bool] | None:
    """(terms, from the JD body) kept by `record`, or None."""
    kept = state["jobs"].get(key, {}).get("inferred_terms")
    if not isinstance(kept, dict) or not kept.get("terms"):
        return None
    return list(kept["terms"]), bool(kept.get("jd"))


def mark_stale(state: dict, key: str, user: str) -> None:
    """Keep a recheck that was accepted but held back (JD cap, daily budget)
    queued for the next run: a fingerprint that never matches."""
    state["jobs"].setdefault(key, {}).setdefault("rj", {})[user] = f"{LEGACY}:"


def clear(state: dict, key: str, user: str) -> None:
    entry = state["jobs"].get(key, {})
    rj = entry.get("rj", {})
    if rj.pop(user, None) is not None and not rj:
        del entry["rj"]


def delivered_today(state: dict, user: str, today: dt.date) -> int:
    day, n = state["_meta"].get("recheck_daily", {}).get(user, ["", 0])
    return int(n) if day == today.isoformat() else 0


def add_delivered(state: dict, user: str, today: dt.date, n: int) -> None:
    daily = state["_meta"].setdefault("recheck_daily", {})
    daily[user] = [today.isoformat(), delivered_today(state, user, today) + n]


# ------------------------------------------------------------ selection

def _eligible(state: dict, key: str, user: str, owned: set[str]) -> bool:
    entry = state["jobs"].get(key)
    if entry is None or entry.get("seeded") or key in owned:
        return False
    return (user not in entry.get("notified_for", [])
            and user not in entry.get("pending", []))


def owned_keys(state: dict, user: str,
               ledger_keys: Iterable[str] = ()) -> set[str]:
    """Keys this user already has, which a recheck must never touch: in the
    outbox or on the dashboard, under a content signature (delivered, or
    suppressed as a content duplicate of a delivery), or in the
    applications ledger (`ledger_keys`; it outlives the 120-day matches
    prune, which matters for dashboard-only users with no notified_for)."""
    owned = {i.get("key", "") for bucket in ("outbox", "matches")
             for i in state.get(bucket, {}).get(user, [])}
    owned |= {k for sig in state.get("content", {}).get(user, {}).values()
              for k in sig.get("keys", [])}
    owned |= set(ledger_keys)
    return owned


def _has_history(state: dict, user: str) -> bool:
    if state.get("last_email", {}).get(user) or state.get("matches", {}).get(user):
        return True
    return any(user in e.get("notified_for", []) for e in state["jobs"].values())


QUIET_DAY_MIN_KEYS = 25   # a seed is a bulk day; a small quiet day is real


def _quiet_days(state: dict, today: dt.date) -> list[str]:
    """Bulk first_seen days (QUIET_DAY_MIN_KEYS+ new keys) before today on
    which nothing was delivered to anyone and nothing reached the LLM: a
    first-run seed or a `--seed` run (no evaluation), not an evaluated day.
    Today is left out (this run judges before it delivers, so today always
    looks quiet), and so is a small day whose few jobs all failed the role
    filter: it was evaluated and its rejections should still recover. On
    the reference instance this is only the first run's seed day."""
    active: set[str] = set()
    counts: dict[str, int] = {}
    for e in state["jobs"].values():
        if not (day := e.get("first_seen")):
            continue
        counts[day] = counts.get(day, 0) + 1
        if "llm" in e or e.get("notified_for"):
            active.add(day)
    return sorted(day for day, n in counts.items()
                  if day not in active and n >= QUIET_DAY_MIN_KEYS
                  and day < today.isoformat())


def bootstrap(state: dict, user: str, listed: dict[str, Job],
              skip: set[str], today: dt.date, owned: set[str]) -> int:
    """Mark still-listed legacy rejections (judged before this code) for
    recheck. Runs every run, so a legacy rejection that was off its list on
    the first run is still picked up when it comes back. Returns how many
    were marked this run."""
    boot = state["_meta"].setdefault("recheck_bootstrap", {})
    rec = boot.get(user)
    if not isinstance(rec, dict):
        # Fixed once. A user with no history in state (added to an existing
        # instance) never judged the jobs already there: nothing qualifies.
        history = _has_history(state, user)
        dates = [d for e in state["jobs"].values() if (d := e.get("first_seen"))]
        rec = boot[user] = {
            "since": (rec if isinstance(rec, str) else today.isoformat())
            if history else "",
            "seed_day": min(dates, default=""),
            "skip_days": _quiet_days(state, today)}
    since, seed_day = rec["since"], rec["seed_day"]
    # Days the operator knows were seeded (a `--seed` run before seeded
    # tags existed, mixed into an otherwise evaluated day).
    skip_days = set(rec.get("skip_days", ())) | set(
        state["_meta"].get("recheck_skip_days", ()))
    jobs = state["jobs"]
    n = 0
    for key in listed:
        entry = jobs.get(key)
        if (key in skip or entry is None or user in entry.get("rj", {})
                or not _eligible(state, key, user, owned)):
            continue
        first = entry.get("first_seen")
        if not first or first > since:
            continue  # unknown age, or judged by this code (it records rj)
        if "llm" not in entry and (first <= seed_day or first in skip_days):
            continue  # seeded (first run / --seed), never evaluated
        entry.setdefault("rj", {})[user] = f"{LEGACY}:"
        n += 1
    if n:
        log.info("user %s: recheck bootstrap marked %d still-listed legacy "
                 "rejection(s) for re-evaluation", user, n)
    return n


def stale(state: dict, uf: UserFilter, listed: dict[str, Job],
          skip: set[str], owned: set[str] | None = None) -> list[Job]:
    """Still-listed rejected jobs whose fingerprint no longer matches,
    newest first_seen first."""
    if owned is None:
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
