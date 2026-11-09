"""Orchestrator: fetch -> parse -> dedupe -> per-user filter/LLM/notify -> state.

Usage:
  python -m src.main              # normal run (notifies, writes state)
  python -m src.main --dry-run    # full pipeline, print digest, no webhook/state
  python -m src.main --backfill   # first run only: notify instead of seeding
  python -m src.main --explain K  # trace one job's decision; no notify, no write
"""

from __future__ import annotations

import argparse
import datetime as dt
import logging
import os
import sys
import time
from pathlib import Path

import httpx
import yaml

from . import content_dedup, dashboard, ledger, recheck, seeding
from . import prefs as prefs_mod
from . import state as st
from .adapters import make_adapter
from .dedupe import _merge_pair, dedupe
from .envfile import load_dotenv
from .filters import UserFilter, Verdict, keyword_label, load_users, role_text
from .llm import api_key_env_for, classify
from .models import Job, SourceConfig
from .normalize import (
    apply_url_rank,
    canonical_url,
    extract_jobright_id,
    norm_company,
    preferred_apply_url,
)
from .notify import (
    build_digest,
    build_email,
    build_health_email,
    build_priority_email,
    match_item,
    primary_term,
    send_discord,
    send_email,
)
from .paths import DATA_ROOT as DATA_ROOT
from .paths import ROOT as ROOT
from .resume.build import build_for_job, resume_build_cfg
from .store import ApiError, GitHubStore, TrackerStore, make_store

log = logging.getLogger("intern-baddie")


def load_sources(path: Path) -> list[SourceConfig]:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    return [SourceConfig(**s) for s in raw["sources"]]


def fetch_all(sources: list[SourceConfig], state: dict, today: dt.date,
              report: seeding.FetchReport | None = None) -> list[Job]:
    """Fetch every source. `report`, when given, collects the sources and
    boards that answered (for first-sight seeding)."""
    from .adapters.base import GitHubTokenAuth
    headers = {"User-Agent": "intern-baddie (job alert bot)"}
    token = os.environ.get("GITHUB_TOKEN")
    all_jobs: list[Job] = []
    prev_counts = state["_meta"]["source_rows"]
    with httpx.Client(headers=headers,
                      auth=GitHubTokenAuth(token) if token else None) as client:
        for cfg in sources:
            started = time.monotonic()
            try:
                adapter = make_adapter(cfg)
                jobs = adapter.fetch(client, today)
            except Exception as exc:  # noqa: BLE001 - one source never kills the run
                fails = st.record_source_failure(state, cfg.name, str(exc), today)
                log.warning("source %s failed after %.1fs (%s) -- skipping, run "
                            "continues (%d consecutive)", cfg.name,
                            time.monotonic() - started, exc, fails)
                continue
            log.info("source %s: %d row(s) in %.1fs", cfg.name, len(jobs),
                     time.monotonic() - started)
            if not jobs and prev_counts.get(cfg.name, 0) > 0:
                fails = st.record_source_failure(
                    state, cfg.name,
                    f"parsed 0 rows (was {prev_counts[cfg.name]})", today)
                log.warning("source %s parsed 0 rows (was %d) -- treating as "
                            "broken, skipping (%d consecutive)",
                            cfg.name, prev_counts[cfg.name], fails)
                continue
            st.record_source_success(state, cfg.name)
            prev_counts[cfg.name] = len(jobs)
            all_jobs.extend(jobs)
            if report is not None:
                if jobs:
                    report.sources[cfg.name] = cfg.backfill
                report.boards.update(getattr(adapter, "fetched_boards", {}))
                for job in jobs:
                    if job.board:
                        report.boards.setdefault(job.board, False)
    return all_jobs


JD_FETCH_CAP = 80  # per run; a --backfill burst must not hammer Greenhouse
RECHECK_JD_MAX_FAILURES = 3  # consecutive failed recheck JD fetches, then stop


def enrich_jds(jobs: list[Job], state: dict | None = None,
               deferred: list[str] | None = None) -> int:
    """Fetch the JD for jobs carrying a per-job content URL (Greenhouse,
    SmartRecruiters, Oracle CX, Eightfold -- Lever/Ashby/Jibe descriptions
    arrive inline with the board listing). One small GET per job, new/pending
    jobs only by construction of the caller's list. A fetch that fails leaves
    description None; the filters just see less.

    At most JD_FETCH_CAP per run, oldest first (state first_seen, then key) so
    a burst drains in arrival order. The keys over the cap are appended to
    `deferred`: the caller must leave them pending, NOT evaluate them now --
    decisions are final, and the clearance / grad-only lines live in the JD."""
    from .adapters import eightfold
    from .adapters import oracle_cx as oracle
    from .adapters import smartrecruiters_api as sr
    from .adapters.ats_boards import JD_MAX_CHARS
    from .normalize import strip_html

    targets = [j for j in jobs if j.jd_url and not j.description]
    if not targets:
        return 0
    jobs_state = (state or {}).get("jobs", {})
    targets.sort(key=lambda j: (
        jobs_state.get(j.dedup_key, {}).get("first_seen") or "9999",
        j.dedup_key))
    if len(targets) > JD_FETCH_CAP:
        over = targets[JD_FETCH_CAP:]
        log.info("jd enrichment capped at %d of %d jobs; %d left pending "
                 "for next run", JD_FETCH_CAP, len(targets), len(over))
        if deferred is not None:
            deferred.extend(j.dedup_key for j in over)
        targets = targets[:JD_FETCH_CAP]
    fetched = 0
    headers = {"User-Agent": "intern-baddie (job alert bot)"}
    with httpx.Client(headers=headers, timeout=20.0) as client:
        for job in targets:
            if not job.jd_url:          # targets are jd_url-bearing by
                continue                # construction; keep it locally true
            try:
                resp = client.get(job.jd_url)
                resp.raise_for_status()
                payload = resp.json()
                # Greenhouse returns {content: "<html>"}; SmartRecruiters
                # detail nests the body under jobAd.sections; the Oracle CX
                # detail feed under items[0].External*Str; Eightfold under
                # data.jobDescription.
                if "jobAd" in payload:
                    body = sr.jd_text(payload)
                elif oracle.is_detail_payload(payload):
                    body = oracle.jd_text(payload)
                elif eightfold.is_detail_payload(payload):
                    body = eightfold.jd_text(payload)
                else:
                    body = strip_html(payload.get("content") or "") or None
                job.description = (body or "")[:JD_MAX_CHARS] or None
                fetched += 1
            except Exception as exc:  # noqa: BLE001 - JD is best-effort extra signal
                log.warning("jd fetch failed for %s (%s)", job.dedup_key, exc)
    log.info("fetched %d/%d greenhouse JD(s)", fetched, len(targets))
    return fetched


def infer_terms_from_jds(jobs: list[Job], today: dt.date,
                         quiet: bool = False) -> int:
    """Fill the term of unknown-term jobs from a JD body already in hand
    (ATS boards: Lever/Ashby inline, Greenhouse/SmartRecruiters via
    enrich_jds). Fetches nothing. Runs before any user's filter, so the term
    step sees the result and the LLM is only asked about jobs this could not
    resolve; the filter order itself is unchanged. Only new and pending jobs
    pass through here: a job an earlier run rejected (e.g. term-unresolved)
    stays rejected. Returns jobs resolved."""
    from .normalize import infer_term

    resolved = 0
    for job in jobs:
        if job.terms or not job.description:
            continue
        # Anchor yearless rules on the run date, not date_posted: the job is
        # live today, so "summer internship" means the next summer from now
        # (evergreen postings keep a date_posted from a past cycle).
        got = infer_term(job.title, job.url, job.description, today)
        if got.terms:
            job.terms, job.term_confidence = got.terms, got.confidence
            # Only a term read from the JD body is accept-only; one found
            # in the URL slug is source data, like a title term.
            job.terms_from_jd = got.source == "jd"
            job.terms_inferred = True
            resolved += 1
            if not quiet:
                log.info("term from %s for %s: %s (%s)", got.source,
                         job.dedup_key, ", ".join(got.terms), got.confidence)
    if resolved and not quiet:
        log.info("inferred the term of %d job(s) from their JD", resolved)
    return resolved


class _JobrightEnricher:
    """Run-scoped lazy JD fetcher for jobright jobs that survive to an accept.

    Cost: jobright READMEs carry thousands of rows; we only ever touch the page
    for a job that's about to be NOTIFIED, fetch each job at most once (the
    composed JD is cached on job.description and shared across users/passes via
    the deduped Job objects), and stop after JD_FETCH_CAP fetches per run.
    Fail open: any fetch/parse miss keeps the job and the description stays None.
    """

    def __init__(self, session=None) -> None:
        self.session = session
        self.client: httpx.Client | None = None
        self.fetched = 0
        # Rechecks draw on their own budget (also JD_FETCH_CAP), so a large
        # recheck backlog for one user never starves a later user's
        # screening of brand-new jobs.
        self.recheck_fetched = 0
        self.recheck_failures = 0   # consecutive; see RECHECK_JD_MAX_FAILURES
        self.attempted: set[str] = set()

    def _ensure_client(self) -> httpx.Client:
        if self.client is None:
            self.client = httpx.Client(timeout=20.0, follow_redirects=True)
        return self.client

    def keeps(self, job: Job, recheck: bool = False) -> bool:
        """True if `job` should still be notified. Fetches the jobright JD on
        demand and re-applies the user's elimination rules to it."""
        from .adapters.jobright_page import fetch_description

        # already has a JD, or isn't jobright-fetchable: nothing to add
        if job.description or not job.jobright_id:
            return True
        if job.dedup_key in self.attempted:  # cached miss this run
            return True
        if (self.recheck_fetched if recheck else self.fetched) >= JD_FETCH_CAP:
            log.info("jobright JD enrichment capped at %d this run%s -- "
                     "keeping %s unchecked", JD_FETCH_CAP,
                     " (rechecks)" if recheck else "", job.dedup_key)
            return True
        if recheck and self.recheck_failures >= RECHECK_JD_MAX_FAILURES:
            return True   # jobright looks down: the recheck waits (stale)
        self.attempted.add(job.dedup_key)
        # Attempts, not successes, count toward the cap: with jobright down
        # every try is a timeout, and a large recheck batch must not turn
        # into hundreds of them.
        if recheck:
            self.recheck_fetched += 1
        else:
            self.fetched += 1
        try:
            # The authed fetch carries the JD and the employer link in one
            # request (the later resolve step hits the session memo), but a
            # broken login must not cost the JD we used to get anonymously.
            if self.session is not None:
                from .adapters.jobright_page import compose_description
                job_result = self.session.fetch_job_result(job.jobright_id)
                if job_result:
                    job.description = compose_description(job_result)
            if not job.description:
                job.description = fetch_description(self._ensure_client(),
                                                    job.jobright_id)
        except Exception as exc:  # noqa: BLE001 - a jobright change must never
            log.warning("jobright JD fetch failed for %s (%s) -- keeping job",
                        job.dedup_key, exc)  # suppress real matches
        if recheck:
            self.recheck_failures = 0 if job.description else (
                self.recheck_failures + 1)
            if self.recheck_failures == RECHECK_JD_MAX_FAILURES:
                log.warning("jobright JD fetch failed %d times in a row -- "
                            "no more recheck fetches this run",
                            RECHECK_JD_MAX_FAILURES)
        return True

    def close(self) -> None:
        if self.client is not None:
            self.client.close()


def _drop_eliminated(uf: UserFilter, accepted: list[tuple[Job, list[str]]],
                     enricher: _JobrightEnricher | None,
                     today: dt.date | None = None,
                     state: dict | None = None) -> list[tuple[Job, list[str]]]:
    """Second-chance elimination: for jobright accepts with no JD yet, fetch
    the info page and re-run the rule engine; drop (logging the reason) any job
    that now eliminates on its fetched description. With `state`, a drop is
    recorded as an elim-stage rejection (src/recheck.py), and a RECHECK accept
    whose JD could not be fetched (cap or failure) is held back for a later
    run rather than delivered unchecked."""
    if enricher is None:
        return accepted
    kept: list[tuple[Job, list[str]]] = []
    for job, reasons in accepted:
        # Only jobright accepts need the page fetch; for those, re-run this
        # user's elimination against the JD (freshly fetched or cached from an
        # earlier user this run -- per-user rules can differ).
        if job.jobright_id:
            enricher.keeps(job, recheck=RECHECK_REASON in reasons)
            if RECHECK_REASON in reasons and not job.description:
                # Capped or failed: a recheck is never delivered unjudged on
                # its JD (a new job is; it has no earlier verdict to keep).
                log.info("user %s: recheck of %s waits for its JD",
                         uf.name, job.dedup_key)
                if state is not None:
                    recheck.mark_stale(state, job.dedup_key, uf.name)
                continue
            if job.description and (reason := uf._eliminate_reason(job, today)):
                log.info("user %s: dropped %s after jobright JD fetch (%s)",
                         uf.name, job.dedup_key, reason)
                if state is not None:
                    recheck.record(state, uf, job, "elim")
                continue
        kept.append((job, reasons))
    return kept


def _drop_content_dupes(state: dict, name: str,
                        accepted: list[tuple[Job, list[str]]],
                        terms_order: list[str],
                        today: dt.date) -> list[tuple[Job, list[str]]]:
    """Suppress accepted jobs whose content signature (company|title|term|
    state) was already delivered to this user within the window. jobright
    re-emits one posting under many dedup keys (distinct ids, US/Canada splits,
    multiple feeds); each is "new" to the jr:/url: check but is the same job.
    Genuinely distinct postings (different state, different term) keep distinct
    signatures and pass through. Suppressed jobs stay recorded in state (their
    dedup_key was already touched) but are not notified; each is logged."""
    kept: list[tuple[Job, list[str]]] = []
    for job, reasons in accepted:
        term = primary_term(job, terms_order) or ""
        sig = content_dedup.content_signature(job, term)
        matched = content_dedup.find_compatible(
            state, name, sig, today, content_dedup.SUPPRESS_WINDOW_DAYS)
        if matched is not None:
            prior = st.content_keys(state, name, matched)
            log.info("user %s: content-dupe suppressed %s ~= %s (sig %s ~ %s) "
                     "[layer=content]", name, job.dedup_key,
                     prior[0] if prior else "?", sig, matched)
            st.content_mark(state, name, matched, job.dedup_key, today)
            continue
        st.content_mark(state, name, sig, job.dedup_key, today)
        kept.append((job, reasons))
    return kept


def _owned_by_user(state: dict, name: str, key: str) -> bool:
    """Delivered or delivery-owned by this user: notified, queued in the
    outbox, or on the dashboard matches list."""
    return (st.was_notified(state, key, name)
            or any(i.get("key") == key
                   for i in state.get("outbox", {}).get(name, []))
            or any(i.get("key") == key
                   for i in state.get("matches", {}).get(name, [])))


def _drop_url_dupes(state: dict, name: str,
                    accepted: list[tuple[Job, list[str]]],
                    terms_order: list[str],
                    today: dt.date) -> list[tuple[Job, list[str]]]:
    """Deterministic cross-source join: suppress an accepted job whose
    canonical employer-URL identity was already delivered to this user under a
    different dedup_key (the jr:/url: namespace split). Runs after
    _resolve_employer_urls so a jobright job carries its real employer url.
    Jobs with no canonical url (unresolved jobright link) pass through to the
    fuzzy content gate. Prefer the direct application link, then known term,
    non-jobright source and arrival order. Existing deliveries keep their keys
    and gain the better link without being delivered again."""
    survivors: dict[str, Job] = {}
    ordered = list(enumerate(accepted))
    owned: dict[str, str] = {}
    snapshots = [item for bucket in ("matches", "outbox")
                 for item in state.get(bucket, {}).get(name, [])]
    for item in sorted(snapshots, key=lambda item: bool(item.get("dismissed"))):
        key = item.get("key", "")
        url = st.apply_url_get(state, key) or item.get("url") or ""
        canon = canonical_url(url)
        if canon and key:
            owned.setdefault(canon, key)

    def rank(item: tuple[int, tuple[Job, list[str]]]) -> tuple[int, bool, bool, int]:
        idx, (job, _r) = item
        return (apply_url_rank(job.url), bool(job.terms), not job.jobright_id, -idx)

    kept: list[tuple[Job, list[str]]] = []
    for _idx, (job, reasons) in sorted(ordered, key=rank, reverse=True):
        canon = canonical_url(job.url)
        if canon is None:
            kept.append((job, reasons))
            continue
        # Within-batch: fold a later same-canon job into the batch survivor.
        winner = survivors.get(canon)
        if winner is not None:
            _merge_pair(winner, job)
            st.mark_notified(state, job.dedup_key, name)
            st.mark_dup_of(state, job.dedup_key, winner.dedup_key)
            log.info("user %s: url-dupe suppressed %s == %s (canon %s) "
                     "[layer=url-index-batch]", name, job.dedup_key,
                     winner.dedup_key, canon)
            continue
        # Cross-run: a prior delivery this user already owns wins.
        prior = owned.get(canon) or st.url_index_get(state, canon)
        if (prior is not None and prior != job.dedup_key
                and _owned_by_user(state, name, prior)):
            st.touch(state, prior, job.sources, today)
            st.mark_notified(state, job.dedup_key, name)
            st.mark_dup_of(state, job.dedup_key, prior)
            for item in snapshots:
                if item.get("key") == prior:
                    item["url"] = preferred_apply_url(item.get("url") or "", job.url)
            cached = st.apply_url_get(state, prior) or ""
            st.apply_url_put(state, prior, preferred_apply_url(cached, job.url))
            log.info("user %s: url-dupe suppressed %s == %s (canon %s) "
                     "[layer=url-index]", name, job.dedup_key, prior, canon)
            continue
        survivors[canon] = job
        st.url_index_put(state, canon, job.dedup_key)
        kept.append((job, reasons))
    # Restore arrival order for stable downstream behavior.
    kept.sort(key=lambda jr: accepted.index(jr))
    return kept


def _apply_twin_jds(uf: UserFilter, candidates: list[Job],
                    accepted: list[tuple[Job, list[str]]], name: str,
                    today: dt.date) -> list[tuple[Job, list[str]]]:
    """An accepted job with no JD whose canonical URL matches a candidate of
    this run that has one (its ATS twin) takes that JD and is evaluated
    again, so the clearance / grad-only / unpaid lines that live only in the
    ATS JD reach it too. A reject here is final, like any reject; any other
    verdict keeps the earlier accept. Runs after _resolve_employer_urls so a
    jobright twin carries its employer URL."""
    jds: dict[str, str] = {}
    for job in candidates:
        canon = canonical_url(job.url) if job.description else None
        # The longest body wins: a short aggregator blurb must not shadow the
        # full ATS JD that carries the eliminating lines.
        if canon and len(job.description or "") > len(jds.get(canon, "")):
            jds[canon] = job.description or ""
    if not jds:
        return accepted
    kept = []
    for job, reasons in accepted:
        canon = canonical_url(job.url)
        if not job.description and canon in jds:
            job.description = jds[canon]
            verdict = uf.evaluate(job, today=today)
            if verdict.status == "reject":
                log.info("user %s: %s rejected with its twin's JD (%s)", name,
                         job.dedup_key, "; ".join(verdict.reasons))
                continue
        kept.append((job, reasons))
    return kept


def _resolve_employer_urls(accepted: list[tuple[Job, list[str]]], state: dict,
                           resolver) -> None:
    """Resolve accepted jobright jobs to their employer apply url, so email,
    dashboard and webui snapshots show it instead of the info page. Fails open:
    keeps the jobright url when there is no resolver, the url is already an
    employer link, or resolution returns nothing. Runs before any display
    snapshot is taken and never touches job.jobright_id."""
    if resolver is None:
        return
    for job, _reasons in accepted:
        jr_id = extract_jobright_id(job.url)
        if jr_id is None:
            continue
        url = st.apply_url_get(state, job.dedup_key)
        if url is None:
            url = resolver.resolve_apply_url(jr_id)
            if url is not None:
                st.apply_url_put(state, job.dedup_key, url)
        if url is not None:
            job.url = url


BACKFILL_RESOLVE_CAP = 5


def _backfill_apply_urls(state: dict, resolver,
                         limit: int = BACKFILL_RESOLVE_CAP) -> int:
    """Resolve a few already-DELIVERED jobright matches that still lack a cached
    apply_url, oldest-first, so the url_index converges even on runs that hit
    the session cap. Shares the resolver's per-run cap. Forward-only: stores
    apply_url + the index entry; never rewrites the delivered item's display
    url. Returns how many resolved."""
    if resolver is None:
        return 0
    targets: dict[str, str] = {}   # jr key -> added date, oldest kept
    for items in state.get("matches", {}).values():
        for item in items:
            key = item.get("key", "")
            if (key.startswith("jr:") and st.apply_url_get(state, key) is None
                    and key not in targets):
                targets[key] = item.get("added", "")
    resolved = 0
    for key in sorted(targets, key=lambda k: targets[k])[:limit]:
        url = resolver.resolve_apply_url(key[3:])
        if not url:
            continue
        st.apply_url_put(state, key, url)
        canon = canonical_url(url)
        if canon:
            st.url_index_put(state, canon, key)
        resolved += 1
    if resolved:
        log.info("backfilled %d employer apply url(s) for the url index",
                 resolved)
    return resolved


def _jd_term_unwanted(uf: UserFilter, job: Job) -> bool:
    """A JD-derived term this user does not want: the job was treated as
    unknown-term for them (see UserFilter.evaluate)."""
    return job.terms_from_jd and not set(job.terms) & uf.terms_wanted


def _finalize(uf: UserFilter, job: Job, facts: dict) -> tuple[Verdict, Job]:
    """Re-run the rule engine with LLM facts; returns the verdict and the Job
    it judged (what the caller should deliver).

    An LLM-supplied term for a job with NO term is written onto the shared
    job (term is objective and shared across users). A JD-derived term is
    replaced by the LLM's only when this user did not want it - the only
    case in which the term question reached the LLM for them - and then on
    a deep per-user copy, so another user who does want the JD term still
    accepts on it, whatever order users run in. A wanted JD term stands:
    the facts were asked for the company or metro, and a term cached from
    another user's question must not move the job to a different season."""
    if facts.get("term") and _jd_term_unwanted(uf, job):
        job = job.model_copy(deep=True, update={"terms": [facts["term"]],
                                                "term_confidence": "inferred",
                                                "terms_from_jd": False,
                                                "terms_inferred": False})
    elif facts.get("term") and not job.terms:
        job.terms, job.term_confidence = [facts["term"]], "inferred"
    return uf.evaluate(job, llm_facts=facts), job


def _delivered(uf: UserFilter, job: Job) -> Job:
    """The Job an accept delivers. One accepted while its JD term was not
    wanted (the term-unknown fallback, or unknown_term_policy keep) goes
    out as a deep copy whose snapshot says "Unknown term" instead of a
    season this user does not want. Its `terms` keep the JD guess: the
    content-dedup signature must stay specific, since an "Unknown term"
    signature is a wildcard that would suppress a later Summer posting of
    the same company/title for the whole suppress window."""
    if _jd_term_unwanted(uf, job):
        return job.model_copy(deep=True, update={"term_display_unknown": True})
    return job


def _cache_covers(needs: list[str], cached: dict) -> bool:
    field_for = {"term": "term", "top_company": "is_top_company",
                 "atlanta_metro": "in_atlanta_metro"}
    return all(field_for[n] in cached for n in needs)


def _cached_facts(state: dict, job: Job, user: str) -> dict:
    """Per-job objective facts (term, atlanta) merged with the per-employer
    "top company" verdict."""
    facts = st.llm_cache_get(state, job.dedup_key)
    top = st.company_top_get(state, job.company, user)
    if top is not None:
        facts["is_top_company"] = top
    return facts


def _build_resumes(user_cfg: dict, accepted: list[tuple[Job, list[str]]],
                   name: str, dry_run: bool) -> dict[str, str]:
    """Auto-build a tailored .docx per accepted job for commit/email modes.

    Returns {dedup_key -> driver-native resume reference} for jobs that built
    (GitHubStore: the repo-relative `resumes/...` path; ConvexStore: the file
    storage id). Off unless `resume_build.enabled` and a mode in {commit,
    email}. On --dry-run nothing is built (no LLM cost / no files): we only
    log the count that would build. `max_per_run` caps the spend; the rest
    defer to a later run when they're re-seen. Each build is isolated so a
    failure never drops the match or blocks the remaining jobs/users."""
    cfg = resume_build_cfg(user_cfg)
    if not cfg["enabled"] or not (set(cfg["modes"]) & {"commit", "email"}):
        return {}
    if not accepted:
        return {}
    if dry_run:
        n = min(len(accepted), int(cfg["max_per_run"]))
        log.info("user %s: dry run, would build %d resume(s)", name, n)
        return {}

    store = make_store(DATA_ROOT, user_cfg)
    # Build into a gitignored scratch dir; the STORE owns where the .docx
    # finally lands (GitHub: resumes/<user>/, committed as ever; Convex: file
    # storage, so the watch commit step finds nothing new under resumes/).
    out_dir = DATA_ROOT / "out" / "autobuild" / name
    out_dir.mkdir(parents=True, exist_ok=True)
    paths: dict[str, str] = {}
    cap = int(cfg["max_per_run"])
    for i, (job, _) in enumerate(accepted):
        if i >= cap:
            log.info("user %s: resume build cap (%d) reached -- deferring %d "
                     "resume(s) to a later run", name, cap, len(accepted) - cap)
            break
        try:
            result = build_for_job(job, name, out_dir=out_dir, root=DATA_ROOT,
                                   use_llm=cfg["use_llm"],
                                   allow_scrape=cfg["allow_scrape"])
        except Exception as exc:  # noqa: BLE001 - a build never drops the match
            log.warning("user %s: resume build failed for %s (%s) -- match "
                        "kept without a resume", name, job.dedup_key, exc)
            continue
        if result is not None:
            paths[job.dedup_key] = store.put_resume(
                name, dashboard.short_key(job.dedup_key),
                result.out_path.name, result.out_path.read_bytes())
    return paths


def _prefs_store(user_cfg: dict) -> TrackerStore | None:
    """The hosted store that may hold watch prefs, or None. Only a hosted
    driver (STORE=convex) serves them; the GitHub driver is skipped rather
    than constructed, since its init shells out to git for issue plumbing
    this path never needs. A misconfigured hosted store is logged and the
    run continues on the yaml alone."""
    if os.environ.get("STORE", "github") == "github":
        return None
    try:
        return make_store(DATA_ROOT, user_cfg)
    except (ApiError, ValueError) as exc:
        log.warning("user %s: store unavailable for watch prefs (%s) -- "
                    "using the yaml alone", user_cfg.get("name"), exc)
        return None


def _restamp_priority(state: dict, name: str, uf: UserFilter) -> int:
    """Mark already-delivered matches whose employer is priority NOW. A
    company added to the list after a match landed should pin that match
    too, on the dashboard issue and in the pushed snapshot, not only its
    future postings. Forward-only: a company removed from the list keeps
    the stamp it earned when it was on it. Never touches rejections."""
    n = 0
    for item in state.get("matches", {}).get(name, []):
        if item.get("priority") or not uf.is_priority(item.get("company", "")):
            continue
        item["priority"] = True
        item["tag"] = "[PRIORITY]"
        n += 1
    return n


RECHECK_REASON = recheck.RECHECK_REASON


def _hold_over_budget(state: dict, uf: UserFilter,
                      accepted: list[tuple[Job, list[str]]],
                      today: dt.date) -> list[tuple[Job, list[str]]]:
    """Enforce the daily recheck delivery budget: recheck accepts beyond what
    is left of it today are held back (stale, re-run tomorrow). Runs before
    the dedupe gates, which record what they let through."""
    name = uf.name
    daily, _per_run = recheck.limits(uf.cfg)
    if daily is None:
        return accepted
    left = daily - recheck.delivered_today(state, name, today)
    kept: list[tuple[Job, list[str]]] = []
    held = 0
    for job, reasons in accepted:
        if RECHECK_REASON in reasons:
            if left <= 0:
                recheck.mark_stale(state, job.dedup_key, name)
                held += 1
                continue
            left -= 1
        kept.append((job, reasons))
    if held:
        log.info("user %s: daily recheck budget reached -- %d recheck "
                 "match(es) wait for tomorrow", name, held)
    return kept


def _rechecks(uf: UserFilter, state: dict, listed: dict[str, Job],
              candidates: list[Job], today: dt.date, owned: set[str],
              llm_slots: int | None) -> list[Job]:
    """Still-listed rejected jobs whose rejecting config changed (see
    src/recheck.py). A deterministic reject is re-fingerprinted here for
    free; the rest (now accepted, or needing the LLM) are returned, capped,
    for the full pipeline.

    Selection is per seat, not head-of-line: one that needs a fresh LLM
    call takes one of `llm_slots` (what this run's new jobs left of the LLM
    cap; None = no cap), at most one per employer whose top-company verdict
    is missing (one call judges the employer), and is skipped (still stale)
    when none is left, while deterministic ones behind it still get a seat.
    Rechecks needing a Greenhouse-style JD fetch are limited to what
    enrich_jds will fetch this run, so none is judged without its JD."""
    name = uf.name
    skip = {job.dedup_key for job in candidates}
    recheck.bootstrap(state, name, listed, skip, today, owned)
    # Read the term from a JD body / URL already in hand, as a new job's
    # would be, before fingerprinting or judging (fetches nothing; quiet,
    # since the same jobs come through every run).
    infer_terms_from_jds(
        [job for key, job in listed.items()
         if key not in skip and recheck.get(state, key, name) is not None],
        today, quiet=True)
    stale = recheck.stale(state, uf, listed, skip, owned)
    out: list[tuple[Job, bool, str | None]] = []   # (job, needs llm, employer)
    refreshed = 0
    for job in stale:
        # Restore the inferred term it was judged on, so the term step
        # reads what it read then.
        kept = recheck.inferred_terms(state, job.dedup_key)
        if not job.terms and kept:
            job.terms, job.term_confidence = kept[0], "inferred"
            job.terms_from_jd, job.terms_inferred = kept[1], True
        # Judge with the cached LLM term, as _finalize would, so a still-
        # unwanted inferred term is re-fingerprinted here for free.
        term = None if job.terms else st.llm_cache_get(
            state, job.dedup_key).get("term")
        probe = (job.model_copy(update={"terms": [term],
                                        "term_confidence": "inferred"})
                 if term else job)
        verdict = uf.evaluate(probe, today=today)
        if (verdict.status == "reject" and job.jd_url and not job.description
                and not job.terms
                and recheck.stage_of(verdict) not in ("role", "elim")):
            # Its JD (not fetched yet) may name the term: judge it with the
            # body in the full pass rather than record a term-less verdict.
            # (No JD term can undo a role or elimination reject.)
            out.append((job, False, None))
        elif verdict.status == "reject":
            recheck.record(state, uf, job, recheck.stage_of(verdict))
            refreshed += 1
        else:
            needs_llm = (verdict.status == "ambiguous" and not _cache_covers(
                verdict.needs, _cached_facts(state, probe, name)))
            employer = (norm_company(job.company)
                        if needs_llm and "top_company" in verdict.needs
                        and st.company_top_get(state, job.company, name) is None
                        else None)
            out.append((job, needs_llm, employer))
    selected: list[Job] = []
    jd_budget = JD_FETCH_CAP
    daily, per_run = recheck.limits(uf.cfg)
    budget_spent = (daily is not None
                    and recheck.delivered_today(state, name, today) >= daily)
    employers: set[str] = set()
    for job, needs_llm, employer in out:
        if budget_spent or len(selected) >= per_run:
            break
        if needs_llm:
            if employer is not None and employer in employers:
                continue
            if llm_slots is not None and llm_slots <= 0:
                continue
        if job.jd_url and not job.description:
            if jd_budget <= 0:
                continue
            jd_budget -= 1
        if needs_llm:
            if employer is not None:
                employers.add(employer)
            if llm_slots is not None:
                llm_slots -= 1
        selected.append(job)
    if stale:
        log.info("user %s: recheck: %d stale rejection(s); %d still rejected "
                 "(re-fingerprinted), %d re-run now, %d left for later runs",
                 name, len(stale), refreshed, len(selected),
                 len(out) - len(selected))
    enrich_jds(selected)
    infer_terms_from_jds([job for job in selected if not job.terms], today,
                         quiet=True)
    # A JD that could not be fetched leaves the job unjudged on its body:
    # keep its stale record (retried next run) rather than deliver it.
    return [job for job in selected if not (job.jd_url and not job.description)]


def process_user(user_cfg: dict, candidates: list[Job], state: dict,
                 dry_run: bool, now: dt.datetime, send_now: bool = False,
                 enricher: _JobrightEnricher | None = None,
                 resolver=None, store: TrackerStore | None = None,
                 listed: dict[str, Job] | None = None,
                 held_canons: set[str] | None = None) -> None:
    """`listed` (this run's deduped jobs by key) enables the recheck of
    still-listed rejected jobs; without it only `candidates` are judged.
    held_canons: canonical URLs of rows deferred over the JD cap this run.
    An accepted twin of one (e.g. the same posting via an aggregator, with no
    JD) is held pending too, so both spellings are decided together on the
    run that has the JD instead of the twin racing ahead."""
    today = now.date()
    # Settings > Watch (hosted store) overlays the yaml: terms window,
    # per-season presets, priority companies, remote, digest time/recipients.
    if store is None:
        store = _prefs_store(user_cfg)
    prefs = store.get_watch_prefs(user_cfg["name"]) if store else None
    user_cfg = prefs_mod.apply_overlay(user_cfg, prefs)
    uf = UserFilter(user_cfg, ROOT, today=today)
    name = uf.name
    # Employers from the applications ledger count as priority when asked.
    tracker: dict[str, str] = {}
    if (user_cfg.get("priority") or {}).get("from_tracker"):
        tracker = prefs_mod.tracker_companies(name, DATA_ROOT)
        uf.add_priority(set(tracker))
    if uf.priority_names:
        log.info("user %s: %d priority compan%s (%d from the tracker)", name,
                 len(uf.priority_names),
                 "y" if len(uf.priority_names) == 1 else "ies", len(tracker))
        restamped = _restamp_priority(state, name, uf)
        if restamped:
            log.info("user %s: %d earlier match(es) now count as priority",
                     name, restamped)
    llm_cfg = user_cfg.get("llm", {})
    llm_key_env = api_key_env_for(llm_cfg)
    llm_available = uf.llm_enabled and bool(os.environ.get(llm_key_env))
    if uf.llm_enabled and not llm_available:
        log.warning("user %s: llm.enabled but %s missing -- falling back to "
                    "deterministic-only filtering", name, llm_key_env)
        uf.llm_enabled = False

    accepted: list[tuple[Job, list[str]]] = []
    llm_queue: list[Job] = []
    recheck_keys: set[str] = set()

    def _accept(job: Job, reasons: list[str]) -> None:
        if job.dedup_key in recheck_keys:
            reasons = [*reasons, RECHECK_REASON]
        accepted.append((job, reasons))
        recheck.clear(state, job.dedup_key, name)

    def _judge(job: Job) -> None:
        verdict = uf.evaluate(job, today=today)
        if verdict.status == "accept":
            _accept(_delivered(uf, job), verdict.reasons)
            st.clear_pending(state, job.dedup_key, name)
        elif verdict.status == "reject":
            recheck.record(state, uf, job, recheck.stage_of(verdict))
            st.clear_pending(state, job.dedup_key, name)
        else:  # ambiguous
            cached = _cached_facts(state, job, name)
            if _cache_covers(verdict.needs, cached):
                final, judged = _finalize(uf, job, cached)
                if final.status == "accept":
                    _accept(_delivered(uf, judged), final.reasons)
                else:
                    recheck.record(state, uf, judged,
                                   recheck.stage_of(final, after_llm=True))
                st.clear_pending(state, job.dedup_key, name)
            else:
                llm_queue.append(job)

    for job in candidates:
        _judge(job)

    # Rechecks run after this run's new/pending jobs: they get only the LLM
    # slots those left and are never parked as pending (a deferred recheck
    # keeps its stale fingerprint and is picked up again next run).
    # The yaml wants the LLM but this run cannot call it (key missing): skip
    # rechecks entirely. Without the model an unknown term reads as "keep"
    # (accepted) and a top-company rule hard-rejects; either verdict would
    # be committed (delivered, or re-hashed as rejected) and never revisited.
    llm_down = recheck.llm_configured(uf) and not uf.llm_enabled
    if llm_down and listed is not None:
        log.warning("user %s: llm configured but unavailable this run -- "
                    "rechecks skipped until it is back", name)
    if listed is not None and not llm_down:
        ledger_keys = {rec.get("key", "") for rec in ledger.load_ledger(
            ledger.ledger_path(DATA_ROOT)).get(name, {}).values()}
        owned = recheck.owned_keys(state, name, ledger_keys)
        llm_slots = (max(0, int(llm_cfg.get("max_jobs_per_run", 40))
                         - len(llm_queue)) if uf.llm_enabled else None)
        rechecks = _rechecks(uf, state, listed, candidates, today, owned,
                             llm_slots)
        recheck_keys.update(job.dedup_key for job in rechecks)
        for job in rechecks:
            _judge(job)

    # ---- LLM stage: one batched call, cost-guarded, verdicts cached
    if llm_queue:
        cap = int(llm_cfg.get("max_jobs_per_run", 40))
        batch, deferred = llm_queue[:cap], llm_queue[cap:]
        if deferred:
            log.info("user %s: cost guard deferred %d ambiguous job(s) to "
                     "next run", name, len(deferred))
        results: dict[str, dict] = {}
        if batch:
            try:
                results = classify(batch,
                                   llm_cfg.get("top_company_definition", ""),
                                   list(uf.terms_wanted), llm_cfg)
                log.info("user %s: llm classified %d/%d ambiguous job(s)",
                         name, len(results), len(batch))
            except Exception as exc:  # noqa: BLE001
                log.error("user %s: llm call failed (%s) -- deferring batch "
                          "to next run", name, exc)
        # Employer verdicts first: aggregate across the batch (an employer is
        # "top" if ANY of its postings was judged top -- brand variants like
        # Universal Creative / Universal Orlando Resort still normalize to
        # different keys, so the prompt also says to judge the brand family).
        # An already-cached employer is never overwritten: first verdict wins,
        # so an employer can't flip between runs.
        by_company: dict[str, tuple[str, bool]] = {}
        for job in batch:
            facts = results.get(job.dedup_key)
            if facts is None or "is_top_company" not in facts:
                continue
            norm = norm_company(job.company)
            prev = by_company.get(norm, (job.company, False))[1]
            by_company[norm] = (job.company, prev or facts["is_top_company"])
        for company, is_top in by_company.values():
            if st.company_top_get(state, company, name) is None:
                st.company_top_put(state, company, name, is_top, now.date())
        for job in batch:
            facts = results.get(job.dedup_key)
            if facts is None:
                if job.dedup_key not in recheck_keys:
                    st.set_pending(state, job.dedup_key, name)
                continue
            st.llm_cache_put(state, job.dedup_key, facts)
            merged_facts = _cached_facts(state, job, name)
            final, judged = _finalize(uf, job, merged_facts)
            if final.status == "accept":
                _accept(_delivered(uf, judged), final.reasons)
            else:
                recheck.record(state, uf, judged,
                               recheck.stage_of(final, after_llm=True))
            st.clear_pending(state, job.dedup_key, name)
        for job in deferred:
            if job.dedup_key not in recheck_keys:
                st.set_pending(state, job.dedup_key, name)

    # ---- Lazy jobright JD check: title-only sources can't reveal a grad-only/
    # unpaid/clearance requirement, so fetch the info page for jobs that made it
    # to accept and drop any that now eliminate on the fetched JD.
    accepted = _drop_eliminated(uf, accepted, enricher, today, state)
    accepted = _hold_over_budget(state, uf, accepted, today)

    # ---- Cross-source dedup, before resume build / notify so a suppressed dup
    # neither builds a resume nor reaches the email/dashboard. Resolve employer
    # urls FIRST so a jobright job carries the same canonical identity as its
    # ATS twin, then join on that url (deterministic), then fall back to the
    # fuzzy content signature for jobs whose url couldn't be canonicalized.
    terms_order = uf.terms_order
    _resolve_employer_urls(accepted, state, resolver)
    if held_canons:
        kept = []
        for job, reasons in accepted:
            if canonical_url(job.url) in held_canons:
                st.set_pending(state, job.dedup_key, name)
                log.info("user %s: %s held pending with its JD-deferred twin",
                         name, job.dedup_key)
            else:
                kept.append((job, reasons))
        accepted = kept
    accepted = _apply_twin_jds(uf, candidates, accepted, name, today)
    accepted = _drop_url_dupes(state, name, accepted, terms_order, today)
    accepted = _drop_content_dupes(state, name, accepted, terms_order, today)

    # ---- Auto resume build (commit/email modes): tailor a .docx per accepted
    # job into resumes/<user>/ so both delivery modes can find the file. Built
    # paths are keyed by dedup_key and stitched onto the match/outbox items
    # below. Off by default; fail-open so a build never drops a match.
    resume_paths = _build_resumes(user_cfg, accepted, name, dry_run)

    # ---- Notify: instant Discord and/or slot-batched email, per user config
    notify_cfg = user_cfg.get("notify", {})
    if accepted:
        n_re = sum(RECHECK_REASON in r for _j, r in accepted)
        recheck.add_delivered(state, name, today, n_re)
        log.info("user %s: %d new match(es) this run%s", name, len(accepted),
                 f" ({n_re} from rechecks)" if n_re else "")
    if user_cfg.get("dashboard"):
        for job, reasons in accepted:
            item = match_item(job, reasons, terms_order)
            if job.dedup_key in resume_paths:
                item["resume"] = resume_paths[job.dedup_key]
            st.matches_add(state, name,
                           {**item, "added": now.date().isoformat(),
                            "applied": False})
    if notify_cfg.get("discord_webhook_env"):
        # Rechecks go to the digest/dashboard only (batched), like the
        # priority email: a config change must not burst the instant channel.
        _notify_discord(user_cfg, [(j, r) for j, r in accepted
                                   if RECHECK_REASON not in r],
                        state, dry_run, now, terms_order)
    if notify_cfg.get("email"):
        _notify_email(user_cfg, accepted, state, dry_run, now, terms_order,
                      send_now, resume_paths)
    if not accepted and not notify_cfg.get("email"):
        log.info("user %s: no new matches", name)
    if user_cfg.get("dashboard"):
        _sync_dashboard(name, state, dry_run, now, terms_order, user_cfg,
                        store=store, resolver=resolver)
    if store is not None and not dry_run:
        # What this run resolved (yaml + prefs), for the settings page.
        store.put_watch_report(name, prefs_mod.watch_report(
            user_cfg, today, now, tracker, uf.legacy_rules,
            resolved=uf.priority_names))


MATCH_JD_CAP = 12    # watch-time JD acquisitions per run; backlog drains on cron
MATCH_JD_TRIES = 3   # attempts per match before giving up for good


def _matches_with_jds(store, state: dict, name: str,
                      user_cfg: dict | None, resolver=None) -> list[dict]:
    """The match snapshot to push, with full JD text attached (transient
    `jd` field, consumed by the store's pushMatches) for matches that don't
    have one yet -- so the jobDescription is in the database when the user
    first sees the row, not acquired lazily at build time.

    Acquisition state lives as a tiny flag on the match item in seen.json
    (`jd_state`: "ok"/"miss", `jd_tries`) -- never the text itself, which
    would balloon the state file. Only the Convex store consumes pushed
    matches, so the GitHub driver skips acquisition entirely."""
    items = st.matches_items(state, name)
    if isinstance(store, GitHubStore):
        return items
    from types import SimpleNamespace

    from .resume import jd_source
    acquire_jd = jd_source.acquire_jd

    llm_cfg = (user_cfg or {}).get("llm")
    budget = MATCH_JD_CAP
    out: list[dict] = []
    for item in items:
        needs = (item.get("jd_state") != "ok"
                 and int(item.get("jd_tries", 0)) < MATCH_JD_TRIES)
        if not needs or budget <= 0:
            out.append(item)
            continue
        budget -= 1
        key = item.get("key", "?")
        shim = SimpleNamespace(
            description=None, jd_url=None,
            url=item.get("url"), dedup_key=key,
            jobright_id=extract_jobright_id(item.get("url") or ""))
        # jobright matches: the employer's real posting URL. Delivery caches
        # it in state (apply_url_get); when absent and a session is on hand,
        # resolve it now (shares the session's per-run cap) and cache it the
        # same way _backfill_apply_urls does, so the url index converges too.
        employer_url = None
        if key.startswith("jr:"):
            employer_url = st.apply_url_get(state, key)
            if employer_url is None and resolver is not None:
                employer_url = resolver.resolve_apply_url(key[3:])
                if employer_url:
                    st.apply_url_put(state, key, employer_url)
                    canon = canonical_url(employer_url)
                    if canon:
                        st.url_index_put(state, canon, key)
        try:
            text = acquire_jd(shim, llm_cfg=llm_cfg, employer_url=employer_url)
        except Exception:  # noqa: BLE001 - acquisition never blocks the push
            text = None
        if text:
            item["jd_state"] = "ok"
            item.pop("jd_tries", None)
            pushed = dict(item)
            pushed["jd"] = text        # transient: pushMatches strips it
            out.append(pushed)
        else:
            item["jd_tries"] = int(item.get("jd_tries", 0)) + 1
            if item["jd_tries"] >= MATCH_JD_TRIES:
                item["jd_state"] = "miss"
            out.append(item)
    return out


def _sync_dashboard(name: str, state: dict, dry_run: bool, now: dt.datetime,
                    terms_order: list[str],
                    user_cfg: dict | None = None,
                    store: TrackerStore | None = None,
                    resolver=None) -> None:
    """Update the user's dashboard issue (needs the Actions-provided repo +
    token; quietly skipped on plain local runs).

    The read-back ticks come from the TrackerStore (same GitHub mechanism);
    when the store can't produce them, sync_user falls back to fetching the
    issue itself, which is how it lost/gone and closed-issue handling still
    works."""
    if dry_run:
        log.info("user %s: dry run, dashboard issue not updated (%d matches "
                 "in state)", name, len(st.matches_items(state, name)))
        return
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    token = os.environ.get("GITHUB_TOKEN", "")
    if not repo or not token:
        log.info("user %s: GITHUB_REPOSITORY/GITHUB_TOKEN not set -- "
                 "skipping dashboard update", name)
        return
    try:
        if store is None:
            store = make_store(DATA_ROOT, user_cfg or {"name": name})
        ticks = store.get_ticks(name)
        # interactive only when the store has a GitHub-issue dashboard (then
        # its repo/token match the Actions env); otherwise -- e.g. a convex
        # store with repo="" token="" -- the issue is still repainted as a
        # read-only digest using the Actions-provided repo/token, so a remote
        # store's cron run doesn't silently stop updating the dashboard.
        dashboard.sync_user(state, name, terms_order, now, repo, token,
                            ticks=ticks,
                            interactive=isinstance(store, GitHubStore),
                            store=store)
        # applied ticks just read back from the issue become permanent
        # ledger records (seen.json prunes at 120 days; the ledger never does)
        ledger.sync_file(state, name, ledger.ledger_path(DATA_ROOT), now.date())
        if not isinstance(store, GitHubStore):
            # Git-versioned backup of the permanent record: the store owns
            # human state, so mirror its (authoritative) ledger book into
            # state/applications.json for history and backup.
            book = store.get_ledger(name)
            if book:
                lpath = ledger.ledger_path(DATA_ROOT)
                saved = ledger.load_ledger(lpath)
                saved[name] = book
                ledger.save_ledger(saved, lpath)
        store.push_matches(name, _matches_with_jds(store, state, name,
                                                    user_cfg, resolver))
    except Exception:  # noqa: BLE001 - dashboard trouble never blocks delivery
        log.exception("user %s: dashboard update failed", name)


def _notify_discord(user_cfg: dict, accepted: list[tuple[Job, list[str]]],
                    state: dict, dry_run: bool, now: dt.datetime,
                    terms_order: list[str]) -> None:
    name = user_cfg["name"]
    if not accepted:
        return
    chunks = build_digest(accepted, terms_order, now)
    if dry_run:
        print(f"\n===== discord digest for {name} (dry run, "
              f"{len(accepted)} match(es)) =====")
        for chunk in chunks:
            print(chunk)
            print("----- chunk break -----")
        return
    webhook_url = os.environ.get(user_cfg["notify"]["discord_webhook_env"], "")
    ok = False
    if not webhook_url:
        log.error("user %s: webhook env %s not set -- deferring %d match(es)",
                  name, user_cfg["notify"]["discord_webhook_env"], len(accepted))
    else:
        ok = send_discord(webhook_url, chunks)
    for job, _ in accepted:
        if ok:
            st.mark_delivered(state, job.dedup_key, name, job.url)
            st.clear_pending(state, job.dedup_key, name)
        else:
            st.set_pending(state, job.dedup_key, name)
    log.info("user %s: discord %s %d match(es)", name,
             "delivered" if ok else "FAILED (will retry)", len(accepted))


def _send_tz(email_cfg: dict) -> dt.tzinfo:
    """Resolve the `timezone` for local send slots. Defaults to UTC; an unknown
    name falls back to UTC (logged) rather than crashing the send."""
    name = email_cfg.get("timezone")
    if not name:
        return dt.UTC
    try:
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, ModuleNotFoundError) as exc:
        log.warning("email: unusable timezone %r (%s) -- falling back to UTC",
                    name, exc)
        return dt.UTC


def _notify_email(user_cfg: dict, accepted: list[tuple[Job, list[str]]],
                  state: dict, dry_run: bool, now: dt.datetime,
                  terms_order: list[str], send_now: bool = False,
                  resume_paths: dict[str, str] | None = None) -> None:
    """Accumulate matches in the outbox; flush as one HTML digest at the
    first run after each configured UTC send slot. Silent when empty."""
    name = user_cfg["name"]
    email_cfg = user_cfg["notify"]["email"]
    resume_paths = resume_paths or {}
    for job, reasons in accepted:
        item = match_item(job, reasons, terms_order)
        if job.dedup_key in resume_paths:
            item["resume"] = resume_paths[job.dedup_key]
        st.outbox_add(state, name, item)
        st.clear_pending(state, job.dedup_key, name)  # outbox now owns delivery

    # Priority matches found THIS run go out now. Only this run's: a failed
    # send leaves them queued for the digest rather than re-alerting every
    # two hours, and turning the option on doesn't fire for matches already
    # waiting in the outbox from earlier runs.
    pri_cfg = user_cfg.get("priority") or {}
    if pri_cfg.get("email_immediately"):
        # Recheck acceptances wait for the digest: a config change can
        # recover many at once, and that must not become an alert burst.
        found_now = {job.dedup_key for job, reasons in accepted
                     if RECHECK_REASON not in reasons}
        alerts = [it for it in st.outbox_items(state, name)
                  if it.get("priority") and it["key"] in found_now]
        if alerts:
            _send_priority_alert(name, email_cfg, alerts, state, dry_run, now,
                                 terms_order)

    items = st.outbox_items(state, name)
    # `send_at_local` (hours in the configured `timezone`, DST-tracking) is
    # preferred; `send_at_utc` stays as a fixed-UTC fallback for older configs.
    send_hours = list(email_cfg.get("send_at_local")
                      or email_cfg.get("send_at_utc", [0, 12, 18]))
    tz = _send_tz(email_cfg)
    due = send_now or st.email_due(st.get_last_email(state, name), send_hours,
                                   now, tz)
    health = st.health_warning_lines(state)
    if not items:
        # A broken source must not hide behind "silent when empty": if a slot
        # passed with nothing to send, alert once per outage.
        if due and health and st.health_alert_needed(state, name):
            _send_health_alert(name, email_cfg, health, state, dry_run, now)
        else:
            log.info("user %s: email outbox empty%s", name,
                     " (send slot passed, staying silent)" if due else "")
        return
    if not due:
        log.info("user %s: %d match(es) in outbox, next email at the next "
                 "slot (hours %s, tz %s)", name, len(items), send_hours, tz)
        return

    subject, html_body, text_body = build_email(
        items, terms_order, now, health_warnings=health,
        subject_names=bool(pri_cfg.get("subject_names", True)))
    if dry_run:
        print(f"\n===== email for {name} (dry run) =====")
        print(f"Subject: {subject}\n\n{text_body}")
        return
    creds = _smtp_creds(name, email_cfg,
                        f"the digest; keeping {len(items)} item(s) in the "
                        "outbox (set them as Actions secrets wired into "
                        "watch.yml, or export locally)")
    if creds is None:
        return
    smtp_user, smtp_pass, to_addr = creds
    attachments = []
    for item in items:
        rel = item.get("resume")
        if not rel:
            continue
        path = DATA_ROOT / Path(rel)
        if path.exists():  # missing build skips silently, never blocks the send
            attachments.append(path)
    if send_email(smtp_user, smtp_pass, to_addr, subject, html_body, text_body,
                  attachments=attachments, user=name):
        for item in items:
            st.mark_delivered(state, item["key"], name, item.get("url"))
        st.outbox_clear(state, name)
        st.set_last_email(state, name, now)
        st.mark_health_alerted(state, name)
        log.info("user %s: emailed %d match(es) to %s", name, len(items), to_addr)
    else:
        log.error("user %s: email FAILED -- outbox kept for retry", name)


def _smtp_creds(name: str, email_cfg: dict,
                what: str) -> tuple[str, str, str] | None:
    """(smtp_user, smtp_pass, to_addr) from the env, or None (logged) when
    the channel is unconfigured."""
    smtp_user_env = email_cfg.get("smtp_user_env", "")
    smtp_pass_env = email_cfg.get("smtp_pass_env", "")
    smtp_user = os.environ.get(smtp_user_env, "")
    smtp_pass = os.environ.get(smtp_pass_env, "")
    if not smtp_user or not smtp_pass:
        missing = [n for n, v in ((smtp_user_env, smtp_user),
                                  (smtp_pass_env, smtp_pass)) if not v]
        log.error("user %s: email channel OFF -- %s not set; cannot send "
                  "%s", name, ", ".join(missing), what)
        return None
    return smtp_user, smtp_pass, email_cfg.get("to") or smtp_user


def _send_priority_alert(name: str, email_cfg: dict, alerts: list[dict],
                         state: dict, dry_run: bool, now: dt.datetime,
                         terms_order: list[str]) -> None:
    """Email the priority matches now. On success they leave the outbox
    (the digest must not repeat them) and are marked notified; on failure
    they stay queued and ride the next digest instead."""
    subject, html_body, text_body = build_priority_email(alerts, terms_order,
                                                         now)
    if dry_run:
        print(f"\n===== priority alert for {name} (dry run) =====")
        print(f"Subject: {subject}\n\n{text_body}")
        return
    creds = _smtp_creds(name, email_cfg, "the priority alert")
    if creds is None:
        return
    smtp_user, smtp_pass, to_addr = creds
    if send_email(smtp_user, smtp_pass, to_addr, subject, html_body, text_body,
                  user=name):
        for item in alerts:
            st.mark_delivered(state, item["key"], name, item.get("url"))
        st.outbox_remove(state, name, {it["key"] for it in alerts})
        log.info("user %s: priority alert emailed %d match(es) to %s", name,
                 len(alerts), to_addr)
    else:
        log.error("user %s: priority alert FAILED -- %d match(es) stay in "
                  "the outbox for the next digest", name, len(alerts))


def _send_health_alert(name: str, email_cfg: dict, health: list[str],
                       state: dict, dry_run: bool, now: dt.datetime) -> None:
    """One-off source-failure email. Doesn't consume the send slot (a match
    arriving later still goes out at this slot); mark_health_alerted keeps it
    to one alert per outage."""
    subject, html_body, text_body = build_health_email(health, now)
    if dry_run:
        print(f"\n===== health alert for {name} (dry run) =====")
        print(f"Subject: {subject}\n\n{text_body}")
        return
    creds = _smtp_creds(name, email_cfg, "the health alert")
    if creds is None:
        return
    smtp_user, smtp_pass, to_addr = creds
    if send_email(smtp_user, smtp_pass, to_addr, subject, html_body, text_body,
                  user=name):
        st.mark_health_alerted(state, name)
        log.info("user %s: health alert emailed (%d failing source(s))",
                 name, len(health))
    else:
        log.error("user %s: health alert email FAILED -- will retry next slot",
                  name)


def _explain_user(uf: UserFilter, job: Job, state: dict) -> list[str]:
    """Read-only decision trace for one (user, job). Reuses UserFilter.evaluate
    and the state getters -- no new decision logic, no writes. The first-pass
    verdict drives the trace; for an ambiguous job we also replay the final
    verdict with whatever LLM/company facts are already cached in state."""
    name = uf.name
    lines = [f"--- user: {name} ---"]

    # Role filter (which include/exclude keyword fired), reusing the same
    # case-folded substring logic evaluate() runs.
    title = role_text(job.title)
    fired_exclude = next((kw for kw in uf.exclude if kw in title), None)
    if fired_exclude:
        lines.append(f"role filter: REJECT (excluded keyword '{keyword_label(fired_exclude)}')")
    elif uf.include and not any(kw in title for kw in uf.include):
        lines.append("role filter: REJECT (no include keyword matched title)")
    else:
        hit = next((kw for kw in uf.include if kw in title), None)
        lines.append("role filter: pass"
                     + (f" (include keyword '{keyword_label(hit)}')" if hit else ""))
        if uf.strict_sources and uf.strict_include \
                and set(job.sources) & uf.strict_sources:
            shit = next((kw for kw in uf.strict_include if kw in title), None)
            if shit:
                lines.append(f"strict-source filter: pass (keyword '{keyword_label(shit)}')")
            else:
                lines.append("strict-source filter: REJECT "
                             "(no strict include keyword for strict source)")

    # Elimination reason (if any).
    elim = uf._eliminate_reason(job)
    lines.append(f"elimination: {elim}" if elim else "elimination: none")

    # Resolved term + cached LLM/company verdicts.
    cached = _cached_facts(state, job, name)
    term_src = ("explicit" if job.terms and job.term_confidence == "explicit"
                else "inferred" if job.terms else "unknown")
    if job.terms_from_jd:
        term_src += ", from the JD: accept-only"
    lines.append(f"term: {job.terms or '[]'} ({term_src})")
    if "term" in cached:
        lines.append(f"  cached LLM term: {cached['term']}")
    if "in_atlanta_metro" in cached:
        lines.append(f"  cached LLM atlanta_metro: {cached['in_atlanta_metro']}")
    top = st.company_top_get(state, job.company, name)
    lines.append(f"  cached company top-verdict: {top}"
                 if top is not None else "  cached company top-verdict: none")

    # First-pass verdict, then (if ambiguous) the final verdict with cached
    # facts merged in -- same path process_user takes, but reading only.
    verdict = uf.evaluate(job)
    lines.append(f"rule outcome: {verdict.status} "
                 f"({', '.join(verdict.reasons) or '-'})")
    final = verdict
    if verdict.status == "ambiguous":
        if _cache_covers(verdict.needs, cached):
            final, _ = _finalize(uf, job, cached)
            lines.append(f"final (with cached facts): {final.status} "
                         f"({', '.join(final.reasons) or '-'})")
        else:
            missing = [n for n in verdict.needs
                       if not _cache_covers([n], cached)]
            lines.append("final: AMBIGUOUS -- would ask the LLM for "
                         f"{', '.join(verdict.needs)} "
                         f"(missing from cache: {', '.join(missing)})")

    # Current delivery status from state.
    notified = st.was_notified(state, job.dedup_key, name)
    pending = name in pending_keys_for(state, job.dedup_key)
    lines.append(f"status: notified={notified} pending={pending}")

    # Final reason: the authoritative outcome string.
    if final.status == "accept":
        lines.append(f"FINAL: ACCEPT ({', '.join(final.reasons) or '-'})")
    elif final.status == "reject":
        lines.append(f"FINAL: REJECT ({', '.join(final.reasons) or '-'})")
    else:
        lines.append("FINAL: AMBIGUOUS (needs an LLM call this run)")
    return lines


def pending_keys_for(state: dict, key: str) -> set[str]:
    """Users this job is pending for (read-only convenience over state)."""
    return set(state["jobs"].get(key, {}).get("pending", []))


def explain(key: str, state: dict, today: dt.date, users: list[dict],
            user: str | None = None) -> list[str]:
    """Build a read-only decision trace for `key`. Runs the normal fetch+dedupe
    path (reusing fetch_all/dedupe/enrich_jds), then traces each user (or just
    --user). Writes nothing, sends nothing. Returns the lines to print."""
    sources = load_sources(ROOT / "sources.yaml")
    all_jobs = fetch_all(sources, state, today)
    merged = dedupe(all_jobs)
    by_key = {job.dedup_key: job for job in merged}

    out = [f"=== explain {key} ==="]
    job = by_key.get(key)
    if job is None:
        out.append("never ingested -- not among this run's deduped jobs.")
        out.append("Hint: grep the id in the subscribed source repos' raw "
                   "READMEs (and earlier same-day commits); a jobright row can "
                   "appear and vanish between runs.")
        return out

    # Enrich the JD so the elimination trace sees the same body a live run
    # would (jobright accepts fetch lazily; here we enrich up front, read-only).
    enrich_jds([job])
    infer_terms_from_jds([job], today)
    entry = state["jobs"].get(key, {})
    out.append(f"job: {job.company} -- {job.title}")
    out.append(f"locations: {job.locations or '[]'}  sources: {job.sources}")
    out.append(f"first_seen: {entry.get('first_seen', '(not in state)')}  "
               f"last_seen: {entry.get('last_seen', '-')}")

    chosen = [u for u in users if user is None or u["name"] == user]
    if user is not None and not chosen:
        out.append(f"(no user config named '{user}')")
        return out
    for user_cfg in chosen:
        out.extend(_explain_user(UserFilter(user_cfg, ROOT, today=today),
                                 job, state))
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="intern-baddie")
    parser.add_argument("--dry-run", action="store_true",
                        help="full pipeline, print digest, no webhook, no state write")
    parser.add_argument("--backfill", action="store_true",
                        help="on first run, notify everything instead of seed-marking")
    parser.add_argument("--seed", action="store_true",
                        help="mark everything currently listed as seen without "
                             "notifying (e.g. after adding a source you don't "
                             "want a one-time backlog email from)")
    parser.add_argument("--send-now", action="store_true",
                        help="flush the email outbox this run, ignoring the "
                             "configured send slots")
    parser.add_argument("--explain", metavar="KEY",
                        help="trace one job's decision (dedup key, e.g. "
                             "jr:<24-hex>) for each user; no notify, no "
                             "state write")
    parser.add_argument("--user", metavar="NAME",
                        help="with --explain, trace only this user")
    parser.add_argument("--state-file",
                        default=str(DATA_ROOT / "state" / "seen.json"))
    args = parser.parse_args(argv)

    # Local-only: pull STORE/CONVEX_* and GEMINI_API_KEY out of the gitignored
    # .env before the store / user configs are loaded. No-op in Actions (no
    # .env file), where the real secrets are exported env vars.
    load_dotenv()

    try:  # Windows consoles default to cp1252, which can't print the digest emoji
        # Not on the TextIO protocol (only TextIOWrapper); the AttributeError
        # catch is the runtime guard for a replaced/wrapped stdout.
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except (AttributeError, OSError):
        pass
    logging.basicConfig(level=logging.INFO,
                        format="%(levelname)s %(name)s: %(message)s")
    today = dt.date.today()
    now = dt.datetime.now(dt.UTC)
    state_path = Path(args.state_file)
    state = st.load_state(state_path)
    # One-time: seed content-dedup history from prior deliveries so jobs emailed
    # before this feature aren't re-sent when a duplicate key appears.
    content_dedup.seed_from_matches(state)
    # One-time: seed the canonical-url index from prior deliveries so an ATS
    # re-arrival of an already-emailed jobright job is joined and suppressed.
    st.seed_url_index(state)
    # One-time: migrate the index to canonical_url's ats: token dialect (and
    # backfill jr: apply_urls). Must run before the ingest-registration loop
    # below, so it never writes new-dialect tokens next to unmigrated ones.
    st.migrate_url_index(state)

    if args.explain:
        users = load_users(DATA_ROOT / "users")
        for line in explain(args.explain, state, today, users, args.user):
            print(line)
        return 0  # read-only: state NOT written, nothing notified

    first_run = not state["jobs"]

    sources = load_sources(ROOT / "sources.yaml")
    report = seeding.FetchReport()
    all_jobs = fetch_all(sources, state, today, report)
    if not all_jobs:
        log.error("every source failed or was empty -- aborting without "
                  "touching state")
        return 1
    merged = dedupe(all_jobs)
    log.info("fetched %d rows -> %d unique jobs", len(all_jobs), len(merged))

    # First sight of a source/board: its backlog is marked seen, not
    # evaluated (src/seeding.py). Computed before touch -- it reads last
    # run's state. A first run / --seed seeds everything anyway, and
    # --backfill on a first run evaluates everything, so neither applies it.
    to_seed = ({} if first_run or args.seed
               else seeding.first_sight(state, all_jobs, report))
    seeding.record_known(state, report)

    new_jobs = [job for job in merged
                if st.touch(state, job.dedup_key, job.sources, today)]
    seeding.mark_seeded(state, to_seed, today)
    new_jobs = [job for job in new_jobs if job.dedup_key not in to_seed]
    log.info("%d new job(s) since last run%s", len(new_jobs),
             f" ({len(to_seed)} more seeded on first sight)" if to_seed
             else "")

    # Register every job whose url is already an employer link (all ATS/Simplify
    # rows, plus vanshb03 jr:-keyed rows). Free -- no auth -- and first-wins, so
    # re-registering the same rows each run is a no-op. jobright urls -> None.
    for job in merged:
        canon = canonical_url(job.url)
        if canon:
            st.url_index_put(state, canon, job.dedup_key)

    if args.seed or (first_run and not args.backfill):
        log.info("%s: seeding state with %d jobs, no notifications%s",
                 "--seed" if args.seed else "first run", len(merged),
                 "" if args.seed else " (use --backfill to notify instead)")
        # Tagged like a first-sight seed, so nothing later (a recheck of
        # rejections) mistakes them for evaluated jobs.
        for job in new_jobs:
            state["jobs"][job.dedup_key]["seeded"] = today.isoformat()
        if not args.dry_run:
            st.save_state(state, state_path)
        return 0

    users = load_users(DATA_ROOT / "users")
    if not users:
        log.warning("no user configs in users/ -- nothing to notify")
    merged_by_key = {job.dedup_key: job for job in merged}

    # JD enrichment: only jobs that can still influence a decision this run
    # (brand new, or pending an LLM/notify retry for some user).
    relevant = {job.dedup_key for job in new_jobs}
    for user_cfg in users:
        relevant |= st.pending_keys(state, user_cfg["name"])
    relevant_jobs = [merged_by_key[k] for k in relevant if k in merged_by_key]
    jd_deferred: list[str] = []
    enrich_jds(relevant_jobs, state, jd_deferred)
    infer_terms_from_jds(relevant_jobs, today)
    jd_wait = set(jd_deferred)

    from .adapters.jobright_auth import JobrightSession
    resolver = JobrightSession.from_env()
    enricher = _JobrightEnricher(session=resolver)
    for user_cfg in users:
        name = user_cfg["name"]
        candidates = list(new_jobs)
        candidate_keys = {job.dedup_key for job in new_jobs}
        for key in st.pending_keys(state, name):
            if key in candidate_keys:
                continue
            pending_job = merged_by_key.get(key)
            if (pending_job is None and not st.was_notified(state, key, name)
                    and state["jobs"].get(key, {}).get("jd_deferred")):
                # Deferred over the JD cap and never decided: it left the feed
                # before its slot. Keep it pending so a relist (no longer
                # "new") is still evaluated; prune drops it in time.
                continue
            if pending_job is None or st.was_notified(state, key, name):
                st.clear_pending(state, key, name)  # vanished or already done
            else:
                candidates.append(pending_job)
        # Over the JD cap: not evaluated this run, kept pending (and flagged
        # jd_deferred) so the next run fetches its JD, oldest first, and
        # decides it then. A candidate decided this run loses the flag.
        held: set[str] = set()
        for job in candidates:
            if job.dedup_key in jd_wait:
                st.set_pending(state, job.dedup_key, name)
                state["jobs"].setdefault(job.dedup_key, {})["jd_deferred"] = True
                canon = canonical_url(job.url)
                if canon:
                    held.add(canon)
            else:
                state["jobs"].get(job.dedup_key, {}).pop("jd_deferred", None)
        candidates = [j for j in candidates if j.dedup_key not in jd_wait]
        try:
            process_user(user_cfg, candidates, state, args.dry_run, now,
                         send_now=args.send_now, enricher=enricher,
                         resolver=resolver, listed=merged_by_key,
                         held_canons=held)
        except Exception:  # noqa: BLE001 - one user never blocks the others
            log.exception("user %s: processing failed", name)
    enricher.close()
    if not args.dry_run:
        _backfill_apply_urls(state, resolver)
    if resolver is not None and resolver.auth_failed_msg:
        st.record_source_failure(state, "jobright-auth", resolver.auth_failed_msg,
                                 today, floor=st.HEALTH_ALERT_AFTER)
    elif resolver is not None and resolver.succeeded:
        st.record_source_success(state, "jobright-auth")
    if resolver is not None:
        resolver.close()

    st.prune(state, today)
    if args.dry_run:
        log.info("dry run: state NOT written")
    else:
        st.save_state(state, state_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
