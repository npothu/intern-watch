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
from pathlib import Path

import httpx
import yaml

from . import content_dedup, dashboard, ledger
from . import prefs as prefs_mod
from . import state as st
from .adapters import make_adapter
from .dedupe import dedupe
from .envfile import load_dotenv
from .filters import UserFilter, Verdict, load_users
from .llm import api_key_env_for, classify
from .models import Job, SourceConfig
from .normalize import canonical_url, extract_jobright_id, norm_company
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

log = logging.getLogger("intern-watch")


def load_sources(path: Path) -> list[SourceConfig]:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    return [SourceConfig(**s) for s in raw["sources"]]


def fetch_all(sources: list[SourceConfig], state: dict, today: dt.date) -> list[Job]:
    headers = {"User-Agent": "intern-watch (job alert bot)"}
    if os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    all_jobs: list[Job] = []
    prev_counts = state["_meta"]["source_rows"]
    with httpx.Client(headers=headers) as client:
        for cfg in sources:
            try:
                jobs = make_adapter(cfg).fetch(client, today)
            except Exception as exc:  # noqa: BLE001 - one source never kills the run
                fails = st.record_source_failure(state, cfg.name, str(exc), today)
                log.warning("source %s failed (%s) -- skipping, run continues "
                            "(%d consecutive)", cfg.name, exc, fails)
                continue
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
    return all_jobs


JD_FETCH_CAP = 80  # per run; a --backfill burst must not hammer Greenhouse


def enrich_jds(jobs: list[Job]) -> int:
    """Fetch the JD for jobs carrying a per-job content URL (Greenhouse --
    Lever/Ashby descriptions arrive inline with the board listing). One small
    GET per job, new/pending jobs only by construction of the caller's list.
    Failures leave description None; the filters just see less."""
    from .adapters import smartrecruiters_api as sr
    from .adapters.ats_boards import JD_MAX_CHARS
    from .normalize import strip_html

    targets = [j for j in jobs if j.jd_url and not j.description]
    if not targets:
        return 0
    if len(targets) > JD_FETCH_CAP:
        log.info("jd enrichment capped at %d of %d jobs (rest next run)",
                 JD_FETCH_CAP, len(targets))
        targets = targets[:JD_FETCH_CAP]
    fetched = 0
    headers = {"User-Agent": "intern-watch (job alert bot)"}
    with httpx.Client(headers=headers, timeout=20.0) as client:
        for job in targets:
            if not job.jd_url:          # targets are jd_url-bearing by
                continue                # construction; keep it locally true
            try:
                resp = client.get(job.jd_url)
                resp.raise_for_status()
                payload = resp.json()
                # Greenhouse returns {content: "<html>"}; SmartRecruiters
                # detail nests the body under jobAd.sections.
                if "jobAd" in payload:
                    body = sr.jd_text(payload)
                else:
                    body = strip_html(payload.get("content") or "") or None
                job.description = (body or "")[:JD_MAX_CHARS] or None
                fetched += 1
            except Exception as exc:  # noqa: BLE001 - JD is best-effort extra signal
                log.warning("jd fetch failed for %s (%s)", job.dedup_key, exc)
    log.info("fetched %d/%d greenhouse JD(s)", fetched, len(targets))
    return fetched


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
        self.attempted: set[str] = set()

    def _ensure_client(self) -> httpx.Client:
        if self.client is None:
            self.client = httpx.Client(timeout=20.0, follow_redirects=True)
        return self.client

    def keeps(self, job: Job) -> bool:
        """True if `job` should still be notified. Fetches the jobright JD on
        demand and re-applies the user's elimination rules to it."""
        from .adapters.jobright_page import fetch_description

        # already has a JD, or isn't jobright-fetchable: nothing to add
        if job.description or not job.jobright_id:
            return True
        if job.dedup_key in self.attempted:  # cached miss this run
            return True
        if self.fetched >= JD_FETCH_CAP:
            log.info("jobright JD enrichment capped at %d this run -- "
                     "keeping %s unchecked", JD_FETCH_CAP, job.dedup_key)
            return True
        self.attempted.add(job.dedup_key)
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
            self.fetched += 1
        except Exception as exc:  # noqa: BLE001 - a jobright change must never
            log.warning("jobright JD fetch failed for %s (%s) -- keeping job",
                        job.dedup_key, exc)  # suppress real matches
        return True

    def close(self) -> None:
        if self.client is not None:
            self.client.close()


def _drop_eliminated(uf: UserFilter, accepted: list[tuple[Job, list[str]]],
                     enricher: _JobrightEnricher | None,
                     today: dt.date | None = None) -> list[tuple[Job, list[str]]]:
    """Second-chance elimination: for jobright accepts with no JD yet, fetch
    the info page and re-run the rule engine; drop (logging the reason) any job
    that now eliminates on its fetched description."""
    if enricher is None:
        return accepted
    kept: list[tuple[Job, list[str]]] = []
    for job, reasons in accepted:
        # Only jobright accepts need the page fetch; for those, re-run this
        # user's elimination against the JD (freshly fetched or cached from an
        # earlier user this run -- per-user rules can differ).
        if job.jobright_id:
            enricher.keeps(job)
            if job.description and (reason := uf._eliminate_reason(job, today)):
                log.info("user %s: dropped %s after jobright JD fetch (%s)",
                         uf.name, job.dedup_key, reason)
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
    fuzzy content gate. Survivor within a batch: has-term > non-jobright >
    arrival order. Fails open -- keeps the job when nothing joins."""
    survivors: dict[str, Job] = {}
    ordered = list(enumerate(accepted))

    def rank(item: tuple[int, tuple[Job, list[str]]]) -> tuple[bool, bool, int]:
        idx, (job, _r) = item
        return (bool(job.terms), not job.jobright_id, -idx)

    kept: list[tuple[Job, list[str]]] = []
    for _idx, (job, reasons) in sorted(ordered, key=rank, reverse=True):
        canon = canonical_url(job.url)
        if canon is None:
            kept.append((job, reasons))
            continue
        # Within-batch: fold a later same-canon job into the batch survivor.
        winner = survivors.get(canon)
        if winner is not None:
            winner.sources = sorted(set(winner.sources) | set(job.sources))
            st.mark_notified(state, job.dedup_key, name)
            st.mark_dup_of(state, job.dedup_key, winner.dedup_key)
            log.info("user %s: url-dupe suppressed %s == %s (canon %s) "
                     "[layer=url-index-batch]", name, job.dedup_key,
                     winner.dedup_key, canon)
            continue
        # Cross-run: a prior delivery this user already owns wins.
        prior = st.url_index_get(state, canon)
        if (prior is not None and prior != job.dedup_key
                and _owned_by_user(state, name, prior)):
            st.touch(state, prior, job.sources, today)
            st.mark_notified(state, job.dedup_key, name)
            st.mark_dup_of(state, job.dedup_key, prior)
            log.info("user %s: url-dupe suppressed %s == %s (canon %s) "
                     "[layer=url-index]", name, job.dedup_key, prior, canon)
            continue
        survivors[canon] = job
        st.url_index_put(state, canon, job.dedup_key)
        kept.append((job, reasons))
    # Restore arrival order for stable downstream behavior.
    kept.sort(key=lambda jr: accepted.index(jr))
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


def _finalize(uf: UserFilter, job: Job, facts: dict) -> Verdict:
    """Re-run the rule engine with LLM facts. Writes an LLM-supplied term onto
    the job first (term is objective and shared across users)."""
    if not job.terms and facts.get("term"):
        job.terms, job.term_confidence = [facts["term"]], "inferred"
    return uf.evaluate(job, llm_facts=facts)


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


def process_user(user_cfg: dict, candidates: list[Job], state: dict,
                 dry_run: bool, now: dt.datetime, send_now: bool = False,
                 enricher: _JobrightEnricher | None = None,
                 resolver=None, store: TrackerStore | None = None) -> None:
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

    for job in candidates:
        verdict = uf.evaluate(job, today=today)
        if verdict.status == "accept":
            accepted.append((job, verdict.reasons))
            st.clear_pending(state, job.dedup_key, name)
        elif verdict.status == "reject":
            st.clear_pending(state, job.dedup_key, name)
        else:  # ambiguous
            cached = _cached_facts(state, job, name)
            if _cache_covers(verdict.needs, cached):
                final = _finalize(uf, job, cached)
                if final.status == "accept":
                    accepted.append((job, final.reasons))
                st.clear_pending(state, job.dedup_key, name)
            else:
                llm_queue.append(job)

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
                st.set_pending(state, job.dedup_key, name)
                continue
            st.llm_cache_put(state, job.dedup_key, facts)
            merged_facts = _cached_facts(state, job, name)
            final = _finalize(uf, job, merged_facts)
            if final.status == "accept":
                accepted.append((job, final.reasons))
            st.clear_pending(state, job.dedup_key, name)
        for job in deferred:
            st.set_pending(state, job.dedup_key, name)

    # ---- Lazy jobright JD check: title-only sources can't reveal a grad-only/
    # unpaid/clearance requirement, so fetch the info page for jobs that made it
    # to accept and drop any that now eliminate on the fetched JD.
    accepted = _drop_eliminated(uf, accepted, enricher, today)

    # ---- Cross-source dedup, before resume build / notify so a suppressed dup
    # neither builds a resume nor reaches the email/dashboard. Resolve employer
    # urls FIRST so a jobright job carries the same canonical identity as its
    # ATS twin, then join on that url (deterministic), then fall back to the
    # fuzzy content signature for jobs whose url couldn't be canonicalized.
    terms_order = uf.terms_order
    _resolve_employer_urls(accepted, state, resolver)
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
        log.info("user %s: %d new match(es) this run", name, len(accepted))
    if user_cfg.get("dashboard"):
        for job, reasons in accepted:
            item = match_item(job, reasons, terms_order)
            if job.dedup_key in resume_paths:
                item["resume"] = resume_paths[job.dedup_key]
            st.matches_add(state, name,
                           {**item, "added": now.date().isoformat(),
                            "applied": False})
    if notify_cfg.get("discord_webhook_env"):
        _notify_discord(user_cfg, accepted, state, dry_run, now, terms_order)
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
            st.mark_notified(state, job.dedup_key, name)
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
        found_now = {job.dedup_key for job, _ in accepted}
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
            st.mark_notified(state, item["key"], name)
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
            st.mark_notified(state, item["key"], name)
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
    title = job.title.casefold()
    fired_exclude = next((kw for kw in uf.exclude if kw in title), None)
    if fired_exclude:
        lines.append(f"role filter: REJECT (excluded keyword '{fired_exclude}')")
    elif uf.include and not any(kw in title for kw in uf.include):
        lines.append("role filter: REJECT (no include keyword matched title)")
    else:
        hit = next((kw for kw in uf.include if kw in title), None)
        lines.append("role filter: pass"
                     + (f" (include keyword '{hit}')" if hit else ""))
        if uf.strict_sources and uf.strict_include \
                and set(job.sources) & uf.strict_sources:
            shit = next((kw for kw in uf.strict_include if kw in title), None)
            if shit:
                lines.append(f"strict-source filter: pass (keyword '{shit}')")
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
            final = _finalize(uf, job, cached)
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
    parser = argparse.ArgumentParser(prog="intern-watch")
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
    all_jobs = fetch_all(sources, state, today)
    if not all_jobs:
        log.error("every source failed or was empty -- aborting without "
                  "touching state")
        return 1
    merged = dedupe(all_jobs)
    log.info("fetched %d rows -> %d unique jobs", len(all_jobs), len(merged))

    new_jobs = [job for job in merged
                if st.touch(state, job.dedup_key, job.sources, today)]
    log.info("%d new job(s) since last run", len(new_jobs))

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
    enrich_jds([merged_by_key[k] for k in relevant if k in merged_by_key])

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
            if pending_job is None or st.was_notified(state, key, name):
                st.clear_pending(state, key, name)  # vanished or already done
            else:
                candidates.append(pending_job)
        try:
            process_user(user_cfg, candidates, state, args.dry_run, now,
                         send_now=args.send_now, enricher=enricher,
                         resolver=resolver)
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
