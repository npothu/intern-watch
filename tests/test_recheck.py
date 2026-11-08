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


def _state(*jobs, first_seen=TODAY - dt.timedelta(days=5)):
    state = st.empty_state()
    st.touch(state, "url:https://x.example/oldest", ["s"],
             TODAY - dt.timedelta(days=60))   # the first run's seed day
    for job in jobs:
        st.touch(state, job.dedup_key, job.sources, first_seen)
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
    n = recheck.bootstrap(state, "example", listed, set(), TODAY)
    assert n == 1
    assert state["jobs"][evaluated.dedup_key]["rj"]["example"] == "legacy:"
    assert "rj" not in state["jobs"][from_seed_day.dedup_key]
    assert "rj" not in state["jobs"][gone.dedup_key]
    assert recheck.bootstrap(state, "example", listed, set(), TODAY) == 0


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
    assert recheck.get(state, job.dedup_key, "example")[0] == "llm"
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

        def keeps(self, j):
            return True

    phd = _cfg(eliminate={"grad_only": "phd"})
    main.process_user(phd, [], state, dry_run=False, now=NOW,
                      enricher=CappedEnricher(),
                      listed={job.dedup_key: job})
    assert st.outbox_items(state, "example") == []
    assert recheck.get(state, job.dedup_key, "example") == ("legacy", "")
