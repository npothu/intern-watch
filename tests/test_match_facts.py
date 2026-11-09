"""Display-only match facts (src/match_facts.py): the builder reads what the
pipeline already decided, delivery is stamped at send time, facts ride the
match item through save/load/prune, and the pushed snapshot carries them."""

import datetime as dt
from pathlib import Path

from src import main, match_facts
from src import state as st
from src.filters import UserFilter, jd_clearance_obtainable
from src.llm import api_key_env_for
from src.models import Job
from tests.fakestore import FakeStore
from tests.test_main_integration import _user_cfg

ROOT = Path(__file__).resolve().parents[1]
TODAY = dt.date(2026, 8, 26)
NOW = dt.datetime(2026, 8, 26, 12, 5, tzinfo=dt.UTC)


def _j(**kw):
    base = {"company": "SomeCo", "title": "Software Engineer Intern",
            "url": "https://x.com/1", "source": "ats-boards",
            "locations": ["Denver, CO"], "terms": ["Summer 2027"],
            "term_confidence": "explicit"}
    base.update(kw)
    job = Job(**base)
    job.dedup_key = f"url:{job.url}"
    return job


def _build(job, reasons, **kw):
    return match_facts.build(job, reasons, user="example",
                             state=kw.pop("state", st.empty_state()),
                             today=TODAY, **kw)


# ------------------------------------------------------------- the builder

def test_priority_accept():
    f = _build(_j(date_posted=dt.date(2026, 8, 20)), ["company:priority"])
    assert f == {"source": "ats-boards", "postedAt": "2026-08-20",
                 "termSource": "title", "acceptedBy": "priority",
                 "acceptedRule": "company:priority",
                 "topCompany": {"verdict": True, "judgedAt": "2026-08-26",
                                "source": "list"}}


def test_rule_metro_and_remote():
    f = _build(_j(), ["location:atlanta-metro"])
    assert f["metro"] == {"name": "Atlanta, GA", "verdict": True,
                          "source": "rules"}
    assert (f["acceptedBy"], f["acceptedRule"]) == ("rule",
                                                    "location:atlanta-metro")
    assert "metro" in _build(_j(), ["location:alpharetta"])
    # remote and legacy free-form location patterns are not a metro check
    assert "metro" not in _build(_j(), ["location:remote"])
    assert "metro" not in _build(_j(), ["location:new york"])
    assert "topCompany" not in _build(_j(), ["always"])


def test_llm_metro_and_top_company_verdicts():
    state = st.empty_state()
    st.company_top_put(state, "SomeCo", "example", False, dt.date(2026, 7, 1))
    f = _build(_j(), ["location:atlanta (LLM)"], state=state,
               llm_facts={"in_atlanta_metro": True, "is_top_company": False})
    assert f["metro"] == {"name": "Atlanta, GA", "verdict": True,
                          "source": "llm"}
    assert f["topCompany"] == {"verdict": False, "judgedAt": "2026-07-01",
                               "source": "llm"}
    # accepted by the LLM top verdict; the LLM's metro "no" still shows
    st.company_top_put(state, "OtherCo", "example", True, dt.date(2026, 7, 2))
    g = _build(_j(company="OtherCo"), ["company:top_companies (LLM)"],
               state=state,
               llm_facts={"in_atlanta_metro": False, "is_top_company": True})
    assert g["topCompany"]["source"] == "llm"
    assert g["metro"] == {"name": "Atlanta, GA", "verdict": False,
                          "source": "llm"}


def test_term_source():
    assert _build(_j(), ["always"])["termSource"] == "title"
    assert _build(_j(term_confidence="inferred"), ["always"],
                  llm_termed=True)["termSource"] == "llm"
    f = _build(_j(terms=[]), ["company:top_companies", "term-unknown"])
    assert f["termSource"] == "unresolved"
    assert f["acceptedBy"] == "unresolved-all-terms"
    assert f["acceptedRule"] == "company:top_companies"
    # "keep" policy with no LLM: no term known, so no termSource at all
    assert "termSource" not in _build(_j(terms=[]), ["always"])


def test_clearance_obtainable_needs_the_elimination_and_the_wording():
    jd = "Applicants must be able to obtain a Secret clearance."
    assert jd_clearance_obtainable(jd)
    assert not jd_clearance_obtainable("Active TS/SCI clearance required.")
    assert not jd_clearance_obtainable("No clearance talk here.")
    job = _j(description=jd)
    assert _build(job, ["always"],
                  elim_active_clearance=True)["clearanceObtainable"] is True
    assert "clearanceObtainable" not in _build(job, ["always"])


def test_builder_matches_the_real_rule_engine_reasons():
    cfg = {"name": "example", "role_filter": {"include_keywords": ["software"]},
           "terms_wanted": ["Summer 2027"],
           "term_rules": {"Summer": "top_atl_remote"},
           "priority": {"companies": ["Acme"]}}
    uf = UserFilter(cfg, ROOT, today=TODAY)
    v = uf.evaluate(_j(locations=["Alpharetta, GA"]), today=TODAY)
    assert v.status == "accept"
    assert _build(_j(), v.reasons)["metro"]["source"] == "rules"
    v = uf.evaluate(_j(company="Acme"), today=TODAY)
    assert _build(_j(), v.reasons)["acceptedBy"] == "priority"


# --------------------------------------------------- state: delivery, I/O

def _item(key, **kw):
    return {"key": key, "company": "C", "title": "t", "location": "l",
            "url": "u", "tag": "", "term": "Summer 2027",
            "added": "2026-08-26", **kw}


def test_delivery_first_send_wins_and_skips_other_keys():
    state = st.empty_state()
    st.matches_add(state, "example", _item("a", facts={"source": "s"}))
    st.matches_add(state, "example", _item("b"))
    n = st.matches_set_delivery(state, "example", {"a"}, "immediate", NOW)
    assert n == 1
    st.matches_set_delivery(state, "example", {"a", "b"}, "digest",
                            NOW + dt.timedelta(hours=6))
    a, b = st.matches_items(state, "example")
    assert a["facts"] == {"source": "s", "delivery": {
        "mode": "immediate", "at": "2026-08-26T12:05:00Z"}}
    assert b["facts"]["delivery"] == {"mode": "digest",
                                      "at": "2026-08-26T18:05:00Z"}


def test_facts_round_trip_and_prune_with_their_match(tmp_path):
    state = st.empty_state()
    st.touch(state, "a", ["simplify", "ats-boards"], TODAY)
    st.matches_add(state, "example", _item("a", facts={
        "source": "simplify", "acceptedBy": "rule",
        "delivery": {"mode": "digest", "at": "2026-08-26T12:05:00Z"}}))
    st.matches_add(state, "example", _item("old", added="2026-01-01",
                                           facts={"source": "x"}))
    path = tmp_path / "seen.json"
    st.save_state(state, path)
    loaded = st.load_state(path)
    assert st.matches_items(loaded, "example") == st.matches_items(state,
                                                                   "example")
    st.prune(loaded, TODAY)
    assert [i["key"] for i in st.matches_items(loaded, "example")] == ["a"]
    # sources are not duplicated onto the match item in state
    assert "sources" not in st.matches_items(loaded, "example")[0]["facts"]


def test_for_push_derives_sources_without_touching_state():
    state = st.empty_state()
    st.touch(state, "a", ["simplify", "ats-boards"], TODAY)
    st.touch(state, "legacy", ["jobright-swe"], TODAY)
    st.matches_add(state, "example", _item("a", facts={"source": "simplify"}))
    st.matches_add(state, "example", _item("legacy"))      # pre-facts item
    st.matches_add(state, "example", _item("gone"))        # no job entry
    pushed = match_facts.for_push(state, st.matches_items(state, "example"))
    assert pushed[0]["facts"] == {"source": "simplify",
                                  "sources": ["ats-boards", "simplify"]}
    assert pushed[1]["facts"] == {"source": "jobright-swe",
                                  "sources": ["jobright-swe"]}
    assert "facts" not in pushed[2]
    stored = st.matches_items(state, "example")
    assert stored[0]["facts"] == {"source": "simplify"}
    assert "facts" not in stored[1]


# ------------------------------------------------------ process_user wiring

def _wire_push(monkeypatch, tmp_path):
    """Let _sync_dashboard reach store.push_matches without the network."""
    monkeypatch.setattr(main, "DATA_ROOT", tmp_path)
    monkeypatch.setenv("GITHUB_REPOSITORY", "o/r")
    monkeypatch.setenv("GITHUB_TOKEN", "t")
    monkeypatch.setenv("SMTP_U", "u@example.com")
    monkeypatch.setenv("SMTP_P", "pass")
    monkeypatch.setenv("GITHUB_EVENT_NAME", "schedule")
    monkeypatch.setattr(main.dashboard, "sync_user", lambda *a, **k: None)
    monkeypatch.setattr(main.ledger, "sync_file", lambda *a, **k: None)
    from src.resume import jd_source
    monkeypatch.setattr(jd_source, "acquire_jd", lambda *a, **k: None)
    sent: list[str] = []
    monkeypatch.setattr(main, "send_email",
                        lambda u, p, to, subject, *a, **k: sent.append(subject)
                        or True)
    return sent


def test_priority_alert_and_digest_stamp_delivery_before_the_push(
        monkeypatch, tmp_path):
    sent = _wire_push(monkeypatch, tmp_path)
    cfg = _user_cfg()
    cfg["dashboard"] = True
    cfg["priority"] = {"companies": ["PriCo"], "email_immediately": True}
    jobs = [_j(company="PriCo", url="https://x.com/p"),
            _j(company="Plain", url="https://x.com/q", source="simplify")]
    state = st.empty_state()
    for j in jobs:
        st.touch(state, j.dedup_key, j.sources, TODAY)
    store = FakeStore()
    # 12:05 UTC: the 12:00 digest slot is due on the same run as the alert.
    main.process_user(cfg, jobs, state, dry_run=False, now=NOW, store=store)
    assert len(sent) == 2
    pushed = {i["key"]: i for i in store.matches["example"]}
    pri = pushed["url:https://x.com/p"]["facts"]
    plain = pushed["url:https://x.com/q"]["facts"]
    assert pri["delivery"] == {"mode": "immediate", "at": "2026-08-26T12:05:00Z"}
    assert pri["acceptedBy"] == "priority"
    assert pri["sources"] == ["ats-boards"]
    assert plain["delivery"] == {"mode": "digest", "at": "2026-08-26T12:05:00Z"}
    assert plain["source"] == "simplify"
    # one sparkline point per run per user
    assert store.watch_runs == [("example", {
        "at": int(NOW.timestamp() * 1000), "newMatches": 2, "scanned": 2,
        "source": "schedule"})]


def test_undelivered_match_is_pushed_without_delivery(monkeypatch, tmp_path):
    _wire_push(monkeypatch, tmp_path)
    cfg = _user_cfg()
    cfg["dashboard"] = True
    state = st.empty_state()
    st.set_last_email(state, "example", NOW)   # slot already used
    job = _j(url="https://x.com/z")
    store = FakeStore()
    main.process_user(cfg, [job], state, dry_run=False, now=NOW, store=store)
    facts = store.matches["example"][0]["facts"]
    assert "delivery" not in facts and facts["acceptedBy"] == "rule"
    # the next run's digest stamps it and the push carries it
    later = NOW + dt.timedelta(hours=6)
    main.process_user(cfg, [], state, dry_run=False, now=later, store=store)
    assert store.matches["example"][0]["facts"]["delivery"]["mode"] == "digest"


def test_llm_supplied_term_and_cached_employer_verdict(monkeypatch, tmp_path):
    _wire_push(monkeypatch, tmp_path)
    cfg = _user_cfg()
    cfg["dashboard"] = True
    cfg["unknown_term_policy"] = "llm"
    cfg["rules"] = [{"when": {"term": ["Summer 2027"]},
                     "accept_if_any": [{"company_in_file":
                                        "data/top_companies.txt"}]}]
    cfg["llm"] = {"enabled": True,
                  "tasks": ["term_inference", "top_company_judgment"]}
    monkeypatch.setenv(api_key_env_for(cfg["llm"]), "k")
    job = _j(company="Obscure Startup", terms=[], term_confidence="unknown",
             url="https://x.com/llm")
    monkeypatch.setattr(main, "classify", lambda batch, *a, **k: {
        j.dedup_key: {"term": "Summer 2027", "is_top_company": True,
                      "in_atlanta_metro": None} for j in batch})
    state = st.empty_state()
    store = FakeStore()
    termed: set[str] = set()
    main.process_user(cfg, [job], state, dry_run=False, now=NOW, store=store,
                      llm_termed=termed)
    assert termed == {job.dedup_key}
    facts = store.matches["example"][0]["facts"]
    assert facts["termSource"] == "llm"
    assert facts["topCompany"] == {"verdict": True, "judgedAt": "2026-08-26",
                                   "source": "llm"}
    assert facts["acceptedRule"] == "company:top_companies (LLM)"
