"""Recheck of rejected jobs when their rejecting config changes
(src/recheck.py), plus the padded role-keyword matching it recovers."""

import datetime as dt
from pathlib import Path

import pytest

from src import main, recheck
from src import state as st
from src.filters import UserFilter, role_keyword, role_text
from src.models import Job

ROOT = Path(__file__).resolve().parents[1]
TODAY = dt.date(2026, 6, 12)
NOW = dt.datetime(2026, 6, 12, 12, 5, tzinfo=dt.UTC)


def _cfg(**over):
    cfg = {
        "name": "example",
        "eliminate": {"grad_only": True, "countries_allowed": ["United States"]},
        "role_filter": {"include_keywords": ["software", " ai "],
                        "exclude_keywords": [" hr "]},
        "terms_wanted": ["Summer 2027"],
        "unknown_term_policy": "drop",
        "rules": [{"when": {"term": ["Summer 2027"]},
                   "accept_if_any": [{"always": True}]}],
        "priority": {"companies": ["PriCo"], "email_immediately": True},
        "notify": {"email": {"smtp_user_env": "SMTP_U", "smtp_pass_env": "SMTP_P",
                             "send_at_utc": [0]}},
    }
    cfg.update(over)
    return cfg


def _job(i, title="Software Engineer Intern", company=None, **kw):
    job = Job(company=company or f"Co{i}", title=title,
              url=f"https://x.example/jobs/{i}", source="s",
              terms=["Summer 2027"], term_confidence="explicit",
              locations=["Atlanta, GA"], **kw)
    job.dedup_key = f"url:{job.url}"
    return job


def _state(*jobs, first_seen=TODAY - dt.timedelta(days=5), history=True):
    state = st.empty_state()
    if history:   # the user has been receiving digests on this instance
        state["last_email"]["example"] = "2026-06-01T12:00:00+00:00"
    st.touch(state, "url:https://x.example/oldest", ["s"],
             TODAY - dt.timedelta(days=60))   # the first run's seed day
    for job in jobs:
        st.touch(state, job.dedup_key, job.sources, first_seen)
    if history:
        # an evaluated day delivers something (a quiet day reads as a seed)
        st.touch(state, "url:https://x.example/delivered", ["s"], first_seen)
        st.mark_notified(state, "url:https://x.example/delivered", "example")
    return state


def _run(cfg, state, listed, candidates=(), monkeypatch=None):
    main.process_user(cfg, list(candidates), state, dry_run=False, now=NOW,
                      listed={j.dedup_key: j for j in listed})


@pytest.fixture(autouse=True)
def _no_email(monkeypatch):
    sent = []
    monkeypatch.setattr(main, "send_email",
                        lambda *a, **k: sent.append(a[3]) or True)
    monkeypatch.delenv("SMTP_U", raising=False)
    return sent


# ---------------------------------------------------------- keyword matching

@pytest.mark.parametrize("title", [
    "AI Intern", "Seam Intern - Embodied AI", "Neurology (AI) Intern",
    "AI/ML Engineering Intern", "Intern, AI"])
def test_padded_keyword_matches_at_edges_and_punctuation(title):
    assert role_keyword(" ai ") in role_text(title)


@pytest.mark.parametrize("title", ["Maintenance Intern", "Retail Intern",
                                   "Daily Ops Intern"])
def test_padded_keyword_still_word_bounded(title):
    assert role_keyword(" ai ") not in role_text(title)


def test_bare_keywords_stay_substrings():
    assert role_keyword("ml") in role_text("HTML Developer Intern")
    assert role_keyword("product manag") in role_text("Product Management Intern")
    # the documented gotcha survives: "data science" is not in "Data Scientist"
    assert role_keyword("data science") not in role_text("Data Scientist Intern")
    assert role_keyword("front-end") in role_text("Front-End Engineer Intern")
    assert role_keyword("r&d") in role_text("R&D Software Intern")


@pytest.mark.parametrize("kw,title", [
    ("new grad", "New-Grad Software Engineer Intern"),
    ("research engineer", "Research-Engineer Intern"),
    ("electrical engineer", "Electrical-Engineer Intern"),
    ("supply chain", "Supply-Chain Engineer Intern"),
    ("back end", "Back-End Engineer Intern")])
def test_unpadded_phrases_keep_raw_matching(kw, title):
    # Only edge-spaced keywords get word-boundary matching; a plain phrase
    # must not start matching hyphenated titles (exclude lists would widen).
    assert role_keyword(kw) not in role_text(title)


def test_exclude_reason_reads_as_written():
    uf = UserFilter(_cfg(), ROOT, today=TODAY)
    v = uf.evaluate(_job(1, "HR Software Intern"), today=TODAY)
    assert v.reasons == ["excluded-keyword: hr "]


def test_punctuated_keywords_keep_the_old_raw_match():
    # Only plain keywords are normalized; ".net" must not turn into " net"
    # and start matching "Network".
    assert role_keyword(".net") not in role_text("Network Engineer Intern")
    assert role_keyword(".net") in role_text("ASP.NET Developer Intern")
    assert role_keyword("full-stack") not in role_text("Full Stack Intern")
    assert role_keyword("full-stack") in role_text("Full-Stack Intern")


def test_exclude_padding_mirrors_include():
    uf = UserFilter(_cfg(), ROOT, today=TODAY)
    assert uf.evaluate(_job(1, "HR Software Intern"), today=TODAY).status == "reject"
    assert uf.evaluate(_job(2, "AI Intern"), today=TODAY).status == "accept"


# ---------------------------------------------------------- fingerprints

def test_stage_of_maps_reasons():
    from src.filters import Verdict
    assert recheck.stage_of(Verdict("reject", ["no-role-keyword"])) == "role"
    assert recheck.stage_of(Verdict("reject", ["eliminated:grad-only-title"])) == "elim"
    assert recheck.stage_of(Verdict("reject", ["term-not-wanted"])) == "term"
    assert recheck.stage_of(Verdict("reject", ["rules-not-met"])) == "rules"
    assert recheck.stage_of(Verdict("reject", ["rules-not-met"]), after_llm=True) == "llm"
    assert recheck.stage_of(Verdict("reject", ["eliminated:x"]), after_llm=True) == "elim"
    assert recheck.stage_of(Verdict("reject", ["term-not-wanted"]),
                            after_llm=True) == "term"


def test_fingerprints_track_only_their_stage():
    state = st.empty_state()
    a, b = _job(1, company="A"), _job(2, company="B")
    base = UserFilter(_cfg(), ROOT, today=TODAY)
    phd = UserFilter(_cfg(eliminate={"grad_only": "phd",
                                     "countries_allowed": ["United States"]}),
                     ROOT, today=TODAY)
    fp = recheck.fingerprint
    assert fp(base, "elim", a, state) != fp(phd, "elim", a, state)
    assert fp(base, "role", a, state) == fp(phd, "role", a, state)
    # a new priority company only touches that employer's rules fingerprint
    more = UserFilter(_cfg(priority={"companies": ["PriCo", "A"]}), ROOT,
                      today=TODAY)
    assert fp(base, "rules", a, state) != fp(more, "rules", a, state)
    assert fp(base, "rules", b, state) == fp(more, "rules", b, state)
    # term: only jobs whose own term enters/leaves the wanted set move
    fall = _job(3, company="C")
    fall.terms = ["Fall 2027"]
    wider = UserFilter(_cfg(terms_wanted=["Summer 2027", "Fall 2027"]), ROOT,
                       today=TODAY)
    assert fp(base, "term", fall, state) != fp(wider, "term", fall, state)
    assert fp(base, "term", a, state) == fp(wider, "term", a, state)
    # llm: the cached employer verdict is part of it (delete = re-judge)
    before = fp(base, "llm", a, state)
    st.company_top_put(state, "A", "example", False, TODAY)
    assert fp(base, "llm", a, state) != before


# ---------------------------------------------------------- end to end

def test_grad_only_loosened_recovers_rejection_tagged_recheck(_no_email):
    job = _job(1, "Software Engineer Intern (Masters)")
    state = _state(job)
    _run(_cfg(), state, [], candidates=[job])           # rejected, recorded
    assert recheck.get(state, job.dedup_key, "example")[0] == "elim"
    assert st.outbox_items(state, "example") == []

    _run(_cfg(), state, [job])                          # unchanged: no recheck
    assert st.outbox_items(state, "example") == []

    loosened = _cfg(eliminate={"grad_only": "phd",
                               "countries_allowed": ["United States"]})
    _run(loosened, state, [job])
    box = st.outbox_items(state, "example")
    assert [i["key"] for i in box] == [job.dedup_key]
    assert box[0]["recheck"] and "[RECHECK]" in box[0]["tag"]
    assert recheck.get(state, job.dedup_key, "example") is None

    _run(loosened, state, [job])                        # never twice
    assert len(st.outbox_items(state, "example")) == 1


def test_recheck_priority_match_waits_for_digest(_no_email, monkeypatch):
    monkeypatch.setenv("SMTP_U", "u@example.com")
    monkeypatch.setenv("SMTP_P", "p")
    cfg = _cfg(notify={"email": {"smtp_user_env": "SMTP_U",
                                 "smtp_pass_env": "SMTP_P", "send_at_utc": []}})
    job = _job(1, "Software Engineer Intern (Masters)", company="PriCo")
    state = _state(job)
    _run(cfg, state, [], candidates=[job])
    cfg["eliminate"] = {"grad_only": "phd"}
    _run(cfg, state, [job])
    assert _no_email == []                       # no immediate priority alert
    box = st.outbox_items(state, "example")
    assert box[0]["priority"] and box[0]["recheck"]
    assert box[0]["tag"] == "[PRIORITY] [RECHECK]"


def test_still_rejected_is_refingerprinted_not_delivered():
    job = _job(1, "Software Engineer Intern (PhD)")
    state = _state(job)
    _run(_cfg(), state, [], candidates=[job])
    old = state["jobs"][job.dedup_key]["rj"]["example"]
    phd = _cfg(eliminate={"grad_only": "phd"})
    _run(phd, state, [job])                      # PhD-only: still eliminated
    assert st.outbox_items(state, "example") == []
    assert state["jobs"][job.dedup_key]["rj"]["example"] != old


def test_not_listed_seeded_or_notified_never_rechecked():
    a, b, c = (_job(i, "Software Engineer Intern (Masters)") for i in (1, 2, 3))
    state = _state(a, b, c)
    _run(_cfg(), state, [], candidates=[a, b, c])
    state["jobs"][b.dedup_key]["seeded"] = TODAY.isoformat()
    st.mark_notified(state, c.dedup_key, "example")
    _run(_cfg(eliminate={"grad_only": "phd"}), state, [b, c])   # a not listed
    assert st.outbox_items(state, "example") == []


def test_ai_keyword_fix_recovers_role_rejection_via_version(monkeypatch):
    job = _job(1, "Embodied AI Intern")
    state = _state(job)
    # recorded under the old matcher: pretend an older ROLE_MATCH_VERSION
    monkeypatch.setattr(recheck, "ROLE_MATCH_VERSION", 1)
    recheck.record(state, UserFilter(_cfg(), ROOT, today=TODAY), job, "role")
    monkeypatch.setattr(recheck, "ROLE_MATCH_VERSION", 2)
    _run(_cfg(), state, [job])
    assert [i["key"] for i in st.outbox_items(state, "example")] == [job.dedup_key]


def test_bootstrap_marks_evaluated_still_listed_once():
    evaluated = _job(1, "Software Engineer Intern (Masters)")
    from_seed_day = _job(2, "Software Engineer Intern (Masters)")
    gone = _job(3, "Software Engineer Intern (Masters)")
    state = _state(evaluated, gone)
    st.touch(state, from_seed_day.dedup_key, ["s"], TODAY - dt.timedelta(days=60))
    dupe = _job(4, "Software Engineer Intern (Masters)")
    st.touch(state, dupe.dedup_key, ["s"], TODAY - dt.timedelta(days=5))
    st.content_mark(state, "example", "sig", dupe.dedup_key, TODAY)
    listed = {j.dedup_key: j for j in (evaluated, from_seed_day, dupe)}
    n = recheck.bootstrap(state, "example", listed, set(), TODAY,
                          recheck.owned_keys(state, "example"))
    assert n == 1
    assert state["jobs"][evaluated.dedup_key]["rj"]["example"] == "legacy:"
    assert "rj" not in state["jobs"][from_seed_day.dedup_key]
    assert "rj" not in state["jobs"][gone.dedup_key]
    assert recheck.bootstrap(state, "example", listed, set(), TODAY,
                             recheck.owned_keys(state, "example")) == 0


def test_bootstrap_then_current_config_delivers(_no_email):
    job = _job(1, "Software Engineer Intern (Masters)")
    state = _state(job)                                  # legacy: no rj
    _run(_cfg(eliminate={"grad_only": "phd"}), state, [job])
    assert [i["key"] for i in st.outbox_items(state, "example")] == [job.dedup_key]


def test_recheck_cap_spreads_over_runs(monkeypatch):
    monkeypatch.setattr(recheck, "RECHECK_CAP", 2)
    jobs = [_job(i, "Software Engineer Intern (Masters)") for i in range(5)]
    state = _state(*jobs)
    _run(_cfg(), state, [], candidates=jobs)
    phd = _cfg(eliminate={"grad_only": "phd"})
    _run(phd, state, jobs)
    assert len(st.outbox_items(state, "example")) == 2
    _run(phd, state, jobs)
    _run(phd, state, jobs)
    assert len(st.outbox_items(state, "example")) == 5


def test_daily_delivery_budget(monkeypatch):
    monkeypatch.setattr(recheck, "RECHECK_DAILY_DELIVERIES", 2)
    jobs = [_job(i, "Software Engineer Intern (Masters)") for i in range(5)]
    state = _state(*jobs)
    _run(_cfg(), state, [], candidates=jobs)
    phd = _cfg(eliminate={"grad_only": "phd"})
    _run(phd, state, jobs)
    assert len(st.outbox_items(state, "example")) == 2   # hard cap
    _run(phd, state, jobs)          # budget spent: nothing more today
    assert len(st.outbox_items(state, "example")) == 2
    assert recheck.delivered_today(state, "example", TODAY) == 2
    held = [j for j in jobs if recheck.get(state, j.dedup_key, "example")]
    assert len(held) == 3           # still queued (stale), not lost
    assert recheck.delivered_today(state, "example",
                                   TODAY + dt.timedelta(days=1)) == 0


def test_llm_rechecks_queue_behind_new_jobs_and_never_go_pending(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    cfg = _cfg(unknown_term_policy="llm",
               llm={"enabled": True, "provider": "gemini",
                    "tasks": ["term_inference"], "max_jobs_per_run": 1})
    old = _job(1)
    old.terms, old.term_confidence = [], "unknown"
    new = _job(2)
    new.terms, new.term_confidence = [], "unknown"
    state = _state(old)
    state["jobs"][old.dedup_key]["rj"] = {"example": "legacy:"}
    st.touch(state, new.dedup_key, ["s"], TODAY)
    seen = []

    def fake_classify(batch, *a):
        seen.append([j.dedup_key for j in batch])
        return {j.dedup_key: {"term": "Summer 2027"} for j in batch}

    monkeypatch.setattr(main, "classify", fake_classify)
    _run(cfg, state, [old, new], candidates=[new])
    assert seen == [[new.dedup_key]]                 # the new job got the slot
    assert st.pending_keys(state, "example") == set()
    assert recheck.get(state, old.dedup_key, "example") == ("legacy", "")
    _run(cfg, state, [old, new])
    assert seen[-1] == [old.dedup_key]


def test_llm_inferred_term_fingerprint_is_stable_across_runs(monkeypatch):
    # The LLM's term lands on this run's Job; next run's fresh Job has none.
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    cfg = _cfg(unknown_term_policy="llm",
               llm={"enabled": True, "provider": "gemini",
                    "tasks": ["term_inference"]})
    job = _job(1)
    job.terms, job.term_confidence = [], "unknown"
    state = _state(job)
    monkeypatch.setattr(main, "classify", lambda batch, *a: {
        j.dedup_key: {"term": "Fall 2031"} for j in batch})
    _run(cfg, state, [], candidates=[job])
    assert recheck.get(state, job.dedup_key, "example")[0] == "term"
    fresh = _job(1)
    fresh.terms, fresh.term_confidence = [], "unknown"
    uf = UserFilter(cfg, ROOT, today=TODAY)
    assert recheck.stale(state, uf, {fresh.dedup_key: fresh}, set()) == []


def test_jd_capped_recheck_stays_queued(monkeypatch):
    job = _job(1, "Software Engineer Intern (Masters)",
               jobright_id="a" * 24)
    state = _state(job)
    _run(_cfg(), state, [], candidates=[job])

    class CappedEnricher:
        attempted: set = set()

        def keeps(self, j, recheck=False):
            return True

    phd = _cfg(eliminate={"grad_only": "phd"})
    main.process_user(phd, [], state, dry_run=False, now=NOW,
                      enricher=CappedEnricher(),
                      listed={job.dedup_key: job})
    assert st.outbox_items(state, "example") == []
    assert recheck.get(state, job.dedup_key, "example") == ("legacy", "")


def test_failed_jd_fetch_holds_recheck(monkeypatch):
    job = _job(1, "Software Engineer Intern (Masters)",
               jobright_id="b" * 24)
    state = _state(job)
    _run(_cfg(), state, [], candidates=[job])

    class FailingEnricher:
        attempted = {job.dedup_key}       # tried, fetch raised

        def keeps(self, j, recheck=False):
            return True

    main.process_user(_cfg(eliminate={"grad_only": "phd"}), [], state,
                      dry_run=False, now=NOW, enricher=FailingEnricher(),
                      listed={job.dedup_key: job})
    assert st.outbox_items(state, "example") == []
    assert recheck.get(state, job.dedup_key, "example") == ("legacy", "")


def test_failed_greenhouse_jd_keeps_stale_record(monkeypatch):
    job = _job(1, "Software Engineer Intern (Masters)",
               jd_url="https://boards-api.example/jobs/1")
    state = _state(job)
    _run(_cfg(), state, [], candidates=[job])
    before = recheck.get(state, job.dedup_key, "example")
    monkeypatch.setattr(main, "enrich_jds", lambda jobs: 0)   # fetch failed
    _run(_cfg(eliminate={"grad_only": "phd"}), state, [job])
    assert st.outbox_items(state, "example") == []
    assert recheck.get(state, job.dedup_key, "example") == before


def test_bootstrap_keeps_marking_later_runs_and_fixes_seed_day():
    a = _job(1, "Software Engineer Intern (Masters)")
    b = _job(2, "Software Engineer Intern (Masters)")
    state = _state(a, b)
    state["jobs"]["shell"] = {"apply_url": "x"}           # no first_seen
    assert recheck.bootstrap(state, "example", {a.dedup_key: a}, set(),
                             TODAY, recheck.owned_keys(state, "example")) == 1
    rec = state["_meta"]["recheck_bootstrap"]["example"]
    assert rec["seed_day"] == (TODAY - dt.timedelta(days=60)).isoformat()
    # b was off its list on the bootstrap run; it is marked when it returns
    assert recheck.bootstrap(state, "example", {b.dedup_key: b}, set(),
                             TODAY + dt.timedelta(days=1),
                             recheck.owned_keys(state, "example")) == 1
    # a job first seen after the bootstrap date was judged by this code
    c = _job(3, "Software Engineer Intern (Masters)")
    st.touch(state, c.dedup_key, ["s"], TODAY + dt.timedelta(days=2))
    assert recheck.bootstrap(state, "example", {c.dedup_key: c}, set(),
                             TODAY + dt.timedelta(days=2),
                             recheck.owned_keys(state, "example")) == 0


# ---------------------------------------------------------- per-user limits

@pytest.mark.parametrize("block,expected", [
    (None, (40, 50)),                                     # defaults
    ({}, (40, 50)),
    ({"daily_limit": 10, "per_run": 700}, (10, 700)),     # override
    ({"daily_limit": None}, (None, 50)),                  # null: no limit
    ({"daily_limit": 0}, (0, 50)),                        # 0: paused
    ({"daily_limit": "lots", "per_run": -1}, (40, 50)),   # malformed: default
    ({"daily_limit": True, "per_run": 3.5}, (40, 50)),
    ({"daily_limit": False}, (40, 50)),    # yaml no/off/false: not "unlimited"
    ({"daily_limit": 0.0}, (40, 50)),
    ({"daily_limit": 5000, "per_run": 5000}, (40, 50)),  # over the bound
    ({"per_run": 0}, (40, 0)),                            # pause
    ("garbage", (40, 50)),
])
def test_limits_from_config(block, expected):
    cfg = {"name": "x"} if block is None else {"name": "x", "recheck": block}
    assert recheck.limits(cfg) == expected


def test_limits_survive_the_prefs_overlay():
    from src import prefs
    cfg = _cfg(recheck={"daily_limit": None, "per_run": 700})
    over = prefs.apply_overlay(cfg, {
        "terms": {"leadWeeks": 2}, "rules": {"Summer": "anything"},
        "priority": {"companies": ["X"], "emailImmediately": False}})
    assert recheck.limits(over) == (None, 700)
    uf = UserFilter(over, ROOT, today=TODAY)
    assert recheck.limits(uf.cfg) == (None, 700)


def test_no_daily_limit_delivers_whole_backlog():
    jobs = [_job(i, "Software Engineer Intern (Masters)") for i in range(5)]
    state = _state(*jobs)
    _run(_cfg(), state, [], candidates=jobs)
    loose = _cfg(eliminate={"grad_only": "phd"},
                 recheck={"daily_limit": None, "per_run": 700})
    state["_meta"]["recheck_daily"] = {"example": [TODAY.isoformat(), 999]}
    _run(loose, state, jobs)
    assert len(st.outbox_items(state, "example")) == 5


def test_per_run_and_daily_limit_overrides():
    jobs = [_job(i, "Software Engineer Intern (Masters)") for i in range(5)]
    state = _state(*jobs)
    _run(_cfg(), state, [], candidates=jobs)
    cfg = _cfg(eliminate={"grad_only": "phd"},
               recheck={"daily_limit": 3, "per_run": 2})
    _run(cfg, state, jobs)
    assert len(st.outbox_items(state, "example")) == 2     # per_run
    _run(cfg, state, jobs)
    assert len(st.outbox_items(state, "example")) == 3     # daily_limit
    _run(cfg, state, jobs)
    assert len(st.outbox_items(state, "example")) == 3


def test_llm_capped_recheck_stays_stale_not_rejected(monkeypatch):
    # A recheck the LLM cap pushes out keeps its stale record (re-run later),
    # is not pending, and is not re-fingerprinted as rejected.
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    cfg = _cfg(unknown_term_policy="llm",
               llm={"enabled": True, "provider": "gemini",
                    "tasks": ["term_inference"], "max_jobs_per_run": 1},
               recheck={"daily_limit": None, "per_run": 700})
    jobs = [_job(i) for i in range(3)]
    for j in jobs:
        j.terms, j.term_confidence = [], "unknown"
    state = _state(*jobs)
    for j in jobs:
        state["jobs"][j.dedup_key]["rj"] = {"example": "legacy:"}
    monkeypatch.setattr(main, "classify", lambda batch, *a: {})  # call fails
    _run(cfg, state, jobs)
    for j in jobs:
        assert recheck.get(state, j.dedup_key, "example") == ("legacy", "")
    assert st.pending_keys(state, "example") == set()


def test_llm_configured_but_keyless_run_skips_rechecks(monkeypatch):
    # Without the key, an unknown term would read as "keep" and be delivered,
    # and a top-company rule would hard-reject and be re-hashed for good.
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    cfg = _cfg(unknown_term_policy="llm",
               llm={"enabled": True, "provider": "gemini",
                    "tasks": ["term_inference"]},
               recheck={"daily_limit": None, "per_run": 700})
    job = _job(1)
    job.terms, job.term_confidence = [], "unknown"
    state = _state(job)
    state["jobs"][job.dedup_key]["rj"] = {"example": "legacy:"}
    _run(cfg, state, [job])
    assert st.outbox_items(state, "example") == []
    assert recheck.get(state, job.dedup_key, "example") == ("legacy", "")


def test_turning_the_llm_on_rechecks_rules_rejects():
    state = st.empty_state()
    job = _job(1, company="Obscure")
    off = UserFilter(_cfg(llm={"enabled": False}), ROOT, today=TODAY)
    on = UserFilter(_cfg(llm={"enabled": True,
                              "tasks": ["top_company_judgment"]}),
                    ROOT, today=TODAY)
    assert (recheck.fingerprint(off, "rules", job, state)
            != recheck.fingerprint(on, "rules", job, state))


def test_jd_inferred_term_fingerprint_is_stable_across_runs():
    # infer_terms_from_jds only runs on new/pending jobs: the next run's
    # fresh Job has no term, and must still match its record.
    uf = UserFilter(_cfg(), ROOT, today=TODAY)
    job = _job(1)
    job.terms, job.term_confidence = ["Summer 2031"], "inferred"
    job.terms_from_jd = True
    state = _state(job)
    v = uf.evaluate(job, today=TODAY)
    assert recheck.stage_of(v) == "term"   # an unwanted JD term is accept-only
    recheck.record(state, uf, job, recheck.stage_of(v))
    fresh = _job(1)
    fresh.terms, fresh.term_confidence = [], "unknown"
    assert recheck.stale(state, uf, {fresh.dedup_key: fresh}, set()) == []
    # once that term is wanted, the record goes stale and the recheck judges
    # the job on the kept JD term
    wider = UserFilter(_cfg(terms_wanted=["Summer 2027", "Summer 2031"]),
                       ROOT, today=TODAY)
    assert recheck.stale(state, wider, {fresh.dedup_key: fresh}, set()) == [fresh]


# ---------------------------------------------------------- bootstrap evidence

def test_bootstrap_skips_quiet_seed_days_and_operator_skip_days():
    # A pre-#97 `--seed` run: a day whose rows nothing ever evaluated (no
    # delivery, no LLM fact) reads as a seed; an operator-listed day too.
    evaluated = _job(1, "Software Engineer Intern (Masters)")
    state = _state(evaluated)                       # day D1, delivered sibling
    seed_day = TODAY - dt.timedelta(days=3)
    seeded = [_job(i, "Software Engineer Intern (Masters)")
              for i in range(100, 100 + recheck.QUIET_DAY_MIN_KEYS)]   # bulk
    for j in seeded:
        st.touch(state, j.dedup_key, ["s"], seed_day)
    mixed_day = TODAY - dt.timedelta(days=2)
    mixed = _job(20, "Software Engineer Intern (Masters)")
    st.touch(state, mixed.dedup_key, ["s"], mixed_day)
    st.touch(state, "url:https://x.example/other", ["s"], mixed_day)
    st.mark_notified(state, "url:https://x.example/other", "example")
    state["_meta"]["recheck_skip_days"] = [mixed_day.isoformat()]
    listed = {j.dedup_key: j for j in (evaluated, *seeded, mixed)}
    assert recheck.bootstrap(state, "example", listed, set(), TODAY,
                             recheck.owned_keys(state, "example")) == 1
    assert "rj" in state["jobs"][evaluated.dedup_key]
    assert all("rj" not in state["jobs"][j.dedup_key] for j in (*seeded, mixed))
    assert (seed_day.isoformat()
            in state["_meta"]["recheck_bootstrap"]["example"]["skip_days"])


def test_new_user_without_history_bootstraps_nothing():
    job = _job(1, "Software Engineer Intern (Masters)")
    state = _state(job, history=False)
    st.touch(state, "url:https://x.example/d", ["s"], TODAY - dt.timedelta(days=5))
    st.mark_notified(state, "url:https://x.example/d", "someone-else")
    _run(_cfg(eliminate={"grad_only": "phd"}), state, [job])
    assert st.outbox_items(state, "example") == []
    assert "rj" not in state["jobs"][job.dedup_key]
    assert state["_meta"]["recheck_bootstrap"]["example"]["since"] == ""


def test_ledger_and_content_keys_are_owned(monkeypatch):
    a = _job(1, "Software Engineer Intern (Masters)")
    b = _job(2, "Software Engineer Intern (Masters)")
    state = _state(a, b)
    for j in (a, b):
        state["jobs"][j.dedup_key]["rj"] = {"example": "legacy:"}
    st.content_mark(state, "example", "sig", b.dedup_key, TODAY)
    monkeypatch.setattr(main.ledger, "load_ledger", lambda path: {
        "example": {"abc": {"key": a.dedup_key}}})
    _run(_cfg(eliminate={"grad_only": "phd"}), state, [a, b])
    assert st.outbox_items(state, "example") == []


# ---------------------------------------------------------- inferred terms

def test_url_slug_term_survives_the_next_run(monkeypatch):
    # Run 1 infers Fall 2027 from the URL slug (body in hand) and rejects
    # it; run 2's fresh Job has no body, hence no term: same fingerprint,
    # no LLM call.
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    calls = []
    monkeypatch.setattr(main, "classify",
                        lambda batch, *a: calls.append(batch) or {})
    cfg = _cfg(unknown_term_policy="llm",
               llm={"enabled": True, "provider": "gemini",
                    "tasks": ["term_inference"]})
    url = "https://jobs.lever.co/acme/software-engineer-intern-fall-2027"
    job = Job(company="Acme", title="Software Engineer Intern", url=url,
              source="s", description="We build things.")
    job.dedup_key = f"url:{url}"
    state = _state(job)
    main.infer_terms_from_jds([job], TODAY)
    _run(cfg, state, [], candidates=[job])
    assert recheck.get(state, job.dedup_key, "example")[0] == "term"
    fresh = Job(company="Acme", title="Software Engineer Intern", url=url,
                source="s")
    fresh.dedup_key = job.dedup_key
    _run(cfg, state, [fresh])
    assert calls == []
    assert recheck.stale(state, UserFilter(cfg, ROOT, today=TODAY),
                         {fresh.dedup_key: fresh}, set()) == []


def test_inline_jd_term_beats_cached_llm_term():
    # The JD says Fall 2027 (rule: top companies only); the cached LLM term
    # says Summer (anything). The recheck must judge the JD term.
    cfg = _cfg(terms_wanted=["Summer 2027", "Fall 2027"],
               rules=[{"when": {"term": ["Summer 2027"]},
                       "accept_if_any": [{"always": True}]},
                      {"when": {"term": ["Fall 2027"]},
                       "accept_if_any": [{"company_in_file":
                                          "data/top_companies.txt"}]}])
    job = _job(1, company="Obscure Co")
    job.terms, job.term_confidence = [], "unknown"
    job.description = "Join us for our Fall 2027 internship program."
    state = _state(job)
    state["jobs"][job.dedup_key]["llm"] = {"term": "Summer 2027"}
    state["jobs"][job.dedup_key]["rj"] = {"example": "legacy:"}
    _run(cfg, state, [job])
    assert st.outbox_items(state, "example") == []


def test_unwanted_jd_term_hashes_as_unknown():
    # #92: a JD term outside the wanted set is judged as an unknown term, so
    # the unknown-term policy is what its fingerprint must cover.
    state = st.empty_state()
    job = _job(1)
    job.terms, job.term_confidence = ["Winter 2027"], "inferred"
    job.terms_from_jd = True
    drop = UserFilter(_cfg(unknown_term_policy="drop"), ROOT, today=TODAY)
    keep = UserFilter(_cfg(unknown_term_policy="keep"), ROOT, today=TODAY)
    assert (recheck.fingerprint(drop, "term", job, state)
            != recheck.fingerprint(keep, "term", job, state))


def test_explicit_term_clears_kept_inferred_term():
    uf = UserFilter(_cfg(), ROOT, today=TODAY)
    job = _job(1)
    job.terms, job.terms_inferred = ["Fall 2031"], True
    state = _state(job)
    recheck.record(state, uf, job, "term")
    assert state["jobs"][job.dedup_key]["inferred_terms"]["terms"] == ["Fall 2031"]
    explicit = _job(1)
    explicit.terms = ["Winter 2031"]
    recheck.record(state, uf, explicit, "term")
    assert "inferred_terms" not in state["jobs"][job.dedup_key]


# ---------------------------------------------------------- selection

def test_llm_needing_rechecks_do_not_block_deterministic_ones(monkeypatch):
    # New job takes the only LLM slot; two newer LLM-needing rechecks wait;
    # the deterministic accept behind them still gets its seat.
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    monkeypatch.setattr(main, "classify", lambda batch, *a: {
        j.dedup_key: {"term": "Summer 2027"} for j in batch})
    cfg = _cfg(unknown_term_policy="llm",
               llm={"enabled": True, "provider": "gemini",
                    "tasks": ["term_inference"], "max_jobs_per_run": 1},
               eliminate={"grad_only": "phd"},
               recheck={"daily_limit": None, "per_run": 2})
    det = _job(1, "Software Engineer Intern (Masters)")
    state = _state(det, first_seen=TODAY - dt.timedelta(days=9))
    unk = []
    for i in (2, 3):
        j = _job(i)
        j.terms, j.term_confidence = [], "unknown"
        st.touch(state, j.dedup_key, ["s"], TODAY - dt.timedelta(days=4))
        unk.append(j)
    new = _job(9)
    new.terms, new.term_confidence = [], "unknown"
    st.touch(state, new.dedup_key, ["s"], TODAY)
    for j in (det, *unk):
        state["jobs"][j.dedup_key]["rj"] = {"example": "legacy:"}
    _run(cfg, state, [det, *unk, new], candidates=[new])
    keys = {i["key"] for i in st.outbox_items(state, "example")}
    assert det.dedup_key in keys and new.dedup_key in keys
    assert all(recheck.get(state, j.dedup_key, "example") == ("legacy", "")
               for j in unk)


def test_one_llm_seat_per_employer_missing_a_verdict(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    seen = []
    monkeypatch.setattr(main, "classify", lambda batch, *a: seen.extend(
        j.dedup_key for j in batch) or {})
    cfg = _cfg(llm={"enabled": True, "provider": "gemini",
                    "tasks": ["top_company_judgment"]},
               rules=[{"when": {"term": ["Summer 2027"]},
                       "accept_if_any": [{"company_in_file":
                                          "data/top_companies.txt"}]}],
               recheck={"daily_limit": None, "per_run": 700})
    jobs = [_job(i, company="Unjudged Corp") for i in range(3)]
    state = _state(*jobs)
    for j in jobs:
        state["jobs"][j.dedup_key]["rj"] = {"example": "legacy:"}
    _run(cfg, state, jobs)
    assert len(seen) == 1


def test_daily_limit_zero_pauses_deliveries():
    jobs = [_job(i, "Software Engineer Intern (Masters)") for i in range(3)]
    state = _state(*jobs)
    _run(_cfg(), state, [], candidates=jobs)
    _run(_cfg(eliminate={"grad_only": "phd"},
              recheck={"daily_limit": 0, "per_run": 700}), state, jobs)
    assert st.outbox_items(state, "example") == []


def test_discord_never_gets_rechecks(monkeypatch):
    sent = []
    monkeypatch.setattr(main, "_notify_discord",
                        lambda cfg, accepted, *a: sent.extend(accepted))
    job = _job(1, "Software Engineer Intern (Masters)")
    state = _state(job)
    _run(_cfg(), state, [], candidates=[job])
    cfg = _cfg(eliminate={"grad_only": "phd"})
    cfg["notify"]["discord_webhook_env"] = "HOOK"
    _run(cfg, state, [job])
    assert sent == []
    assert [i["key"] for i in st.outbox_items(state, "example")] == [job.dedup_key]


# ---------------------------------------------------------- final nits

def test_quiet_days_skip_today_and_small_days():
    state = st.empty_state()
    bulk = TODAY - dt.timedelta(days=9)
    small = TODAY - dt.timedelta(days=5)
    for i in range(recheck.QUIET_DAY_MIN_KEYS):
        st.touch(state, f"url:https://b.example/{i}", ["s"], bulk)
    for i in range(3):                       # a small all-rejected day
        st.touch(state, f"url:https://s.example/{i}", ["s"], small)
    for i in range(30):                      # today: judged, not yet sent
        st.touch(state, f"url:https://t.example/{i}", ["s"], TODAY)
    assert recheck._quiet_days(state, TODAY) == [bulk.isoformat()]


class _FailingSession:
    def __init__(self):
        self.calls = 0

    def fetch_job_result(self, jid):
        self.calls += 1
        raise TimeoutError("jobright down")


def test_enricher_counts_attempts_and_stops_rechecks_after_failures(monkeypatch):
    from src.adapters import jobright_page
    monkeypatch.setattr(jobright_page, "fetch_description",
                        lambda client, jid: (_ for _ in ()).throw(
                            TimeoutError("down")))
    session = _FailingSession()
    enricher = main._JobrightEnricher(session=session)
    jobs = [_job(i, jobright_id=f"{i:024x}") for i in range(10)]
    for j in jobs:
        enricher.keeps(j, recheck=True)
    assert session.calls == main.RECHECK_JD_MAX_FAILURES   # then it stops
    assert enricher.recheck_fetched == main.RECHECK_JD_MAX_FAILURES
    # new-job screening keeps its own budget, and failures count there too
    for j in [_job(i + 100, jobright_id=f"{i + 100:024x}") for i in range(3)]:
        enricher.keeps(j)
    assert enricher.fetched == 3 and session.calls == 6


def test_recheck_held_with_a_jd_deferred_twin_stays_a_recheck(_no_email):
    from src.normalize import canonical_url
    agg = _job(7, "Software Engineer Intern (Masters)")
    state = _state(agg)
    _run(_cfg(), state, [], candidates=[agg])            # rejected, recorded
    assert recheck.get(state, agg.dedup_key, "example")[0] == "elim"

    loosened = _cfg(eliminate={"grad_only": "phd",
                               "countries_allowed": ["United States"]})
    # Recheck-eligible, but its ATS twin is deferred by the JD cap this run.
    main.process_user(loosened, [], state, dry_run=False, now=NOW,
                      listed={agg.dedup_key: agg},
                      held_canons={canonical_url(agg.url)})
    assert st.outbox_items(state, "example") == []
    # Still a recheck (stale fingerprint), never an ordinary pending job.
    assert agg.dedup_key not in st.pending_keys(state, "example")
    assert recheck.get(state, agg.dedup_key, "example") is not None

    # Next run, no hold: it is selected as a recheck again and delivered as one.
    _run(loosened, state, [agg])
    box = st.outbox_items(state, "example")
    assert [i["key"] for i in box] == [agg.dedup_key]
    assert box[0]["recheck"]
    assert agg.dedup_key not in st.pending_keys(state, "example")
