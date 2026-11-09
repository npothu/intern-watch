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


# ---------------------------------------------- review fixes: provenance

def test_judged_date_is_per_user_and_never_another_users():
    state = st.empty_state()
    st.company_top_put(state, "SomeCo", "a", True, dt.date(2026, 7, 1))
    st.company_top_put(state, "SomeCo", "b", False, dt.date(2026, 7, 5))
    # the employer-wide date moved to B's write; A's own date did not
    assert state["companies"]["someco"]["judged"] == "2026-07-05"
    assert state["companies"]["someco"]["judged_by"] == {
        "a": "2026-07-01", "b": "2026-07-05"}
    assert st.company_judged_get(state, "SomeCo", "a") == "2026-07-01"
    assert st.company_judged_get(state, "SomeCo", "b") == "2026-07-05"
    assert st.company_judged_get(state, "SomeCo", "c") is None
    reasons = ["company:top_companies (LLM)"]
    fa = match_facts.build(_j(), reasons, user="a", state=state, today=TODAY)
    fb = match_facts.build(_j(), reasons, user="b", state=state, today=TODAY)
    assert fa["topCompany"] == {"verdict": True, "judgedAt": "2026-07-01",
                                "source": "llm"}
    assert fb["topCompany"] == {"verdict": False, "judgedAt": "2026-07-05",
                                "source": "llm"}


def test_legacy_entry_without_per_user_date_omits_llm_top_company():
    state = st.empty_state()
    state["companies"]["someco"] = {"top": {"example": True},
                                    "judged": "2026-06-12"}
    assert st.company_judged_get(state, "SomeCo", "example") is None
    f = _build(_j(), ["company:top_companies (LLM)"], state=state,
               llm_facts={"is_top_company": True})
    assert "topCompany" not in f
    # list matches are unaffected: they carry the accept date
    assert _build(_j(), ["company:top_companies"], state=state)[
        "topCompany"]["source"] == "list"


def test_legacy_job_level_llm_top_is_ignored():
    state = st.empty_state()
    st.touch(state, "url:https://x.com/1", ["ats-boards"], TODAY)
    state["jobs"]["url:https://x.com/1"]["llm_top"] = {"example": True}
    f = _build(_j(), ["always"], state=state,
               llm_facts={"is_top_company": True})
    assert "topCompany" not in f


# ------------------------------------------------- review fixes: builder

def test_priority_beats_term_unknown():
    f = _build(_j(terms=[]), ["term-unknown", "company:priority"])
    assert f["acceptedBy"] == "priority"
    assert f["acceptedRule"] == "company:priority"
    assert f["termSource"] == "unresolved"


def test_null_metro_verdict_omits_metro():
    f = _build(_j(), ["always"], llm_facts={"in_atlanta_metro": None})
    assert "metro" not in f


def test_absent_posted_at_and_multi_reason_rule():
    f = _build(_j(), ["location:remote", "company:top_companies"])
    assert "postedAt" not in f
    assert f["acceptedBy"] == "rule"
    assert f["acceptedRule"] == "location:remote, company:top_companies"


def test_for_push_legacy_source_only_when_unambiguous():
    state = st.empty_state()
    state["jobs"]["multi"] = {"sources": ["simplify", "ats-boards"]}  # unsorted
    st.touch(state, "sorted", ["simplify", "ats-boards"], TODAY)
    st.touch(state, "one", ["vanshb03"], TODAY)
    for k in ("multi", "sorted", "one"):
        st.matches_add(state, "example", _item(k))
    pushed = {i["key"]: i["facts"] for i in match_facts.for_push(
        state, st.matches_items(state, "example"))}
    assert pushed["multi"] == {"sources": ["simplify", "ats-boards"]}
    assert pushed["sorted"] == {"sources": ["ats-boards", "simplify"]}
    assert pushed["one"] == {"source": "vanshb03", "sources": ["vanshb03"]}


# ------------------------------------- review fixes: delivery + watch runs

def _two_jobs():
    return [_j(company="PriCo", url="https://x.com/p"),
            _j(company="Plain", url="https://x.com/q", source="simplify")]


def _priority_cfg():
    cfg = _user_cfg()
    cfg["dashboard"] = True
    cfg["priority"] = {"companies": ["PriCo"], "email_immediately": True}
    return cfg


def _touched(jobs):
    state = st.empty_state()
    for j in jobs:
        st.touch(state, j.dedup_key, j.sources, TODAY)
    return state


def _delivery(state, user="example"):
    return {i["key"]: (i.get("facts") or {}).get("delivery")
            for i in st.matches_items(state, user)}


def test_failed_priority_alert_then_digest_ends_as_digest(monkeypatch,
                                                          tmp_path):
    _wire_push(monkeypatch, tmp_path)
    calls: list[str] = []

    def send(u, p, to, subject, *a, **k):
        calls.append(subject)
        return len(calls) > 1          # the priority alert (first) fails
    monkeypatch.setattr(main, "send_email", send)
    jobs = _two_jobs()
    state = _touched(jobs)
    main.process_user(_priority_cfg(), jobs, state, dry_run=False, now=NOW,
                      store=FakeStore())
    assert len(calls) == 2
    stamped = "2026-08-26T12:05:00Z"
    assert _delivery(state) == {
        "url:https://x.com/p": {"mode": "digest", "at": stamped},
        "url:https://x.com/q": {"mode": "digest", "at": stamped}}


def test_failed_digest_leaves_delivery_unstamped(monkeypatch, tmp_path):
    _wire_push(monkeypatch, tmp_path)
    monkeypatch.setattr(main, "send_email", lambda *a, **k: False)
    jobs = _two_jobs()
    state = _touched(jobs)
    store = FakeStore()
    main.process_user(_priority_cfg(), jobs, state, dry_run=False, now=NOW,
                      store=store)
    assert _delivery(state) == dict.fromkeys(
        ["url:https://x.com/p", "url:https://x.com/q"])
    assert all("delivery" not in i["facts"] for i in store.matches["example"])


def test_dry_run_stamps_nothing_and_records_no_run(monkeypatch, tmp_path):
    sent = _wire_push(monkeypatch, tmp_path)
    jobs = _two_jobs()
    state = _touched(jobs)
    store = FakeStore()
    main.process_user(_priority_cfg(), jobs, state, dry_run=True, now=NOW,
                      store=store)
    assert sent == []
    assert all(v is None for v in _delivery(state).values())
    assert store.watch_runs == []
    assert "example" not in store.matches


def test_dashboard_off_records_no_run(monkeypatch, tmp_path):
    _wire_push(monkeypatch, tmp_path)
    cfg = _priority_cfg()
    cfg["dashboard"] = False
    jobs = _two_jobs()
    store = FakeStore()
    main.process_user(cfg, jobs, _touched(jobs), dry_run=False, now=NOW,
                      store=store)
    assert store.watch_runs == []
    assert store.watch_reports           # the report is not gated on it


class _RunFails(FakeStore):
    def put_watch_run(self, user, run):
        raise RuntimeError("convex down")


def test_watch_run_failure_does_not_fail_the_run(monkeypatch, tmp_path):
    _wire_push(monkeypatch, tmp_path)
    jobs = _two_jobs()
    state = _touched(jobs)
    store = _RunFails()
    main.process_user(_priority_cfg(), jobs, state, dry_run=False, now=NOW,
                      store=store)
    # everything before and after still happened; state is intact to save
    assert len(store.matches["example"]) == 2
    assert all(v is not None for v in _delivery(state).values())
    path = tmp_path / "seen.json"
    st.save_state(state, path)
    assert len(st.matches_items(st.load_state(path), "example")) == 2


def test_convex_put_watch_run_swallows_api_errors(monkeypatch):
    from src import store as store_mod

    def boom(self, *a, **k):
        raise store_mod.ApiError("down")
    monkeypatch.setattr(store_mod.ConvexStore, "_post", boom)
    s = store_mod.ConvexStore.__new__(store_mod.ConvexStore)
    s.secret = "x"
    s.put_watch_run("example", {"at": 1, "newMatches": 0})   # no raise


def test_discord_only_delivery_stays_absent(monkeypatch, tmp_path):
    _wire_push(monkeypatch, tmp_path)
    monkeypatch.setenv("HOOK", "https://discord.invalid/x")
    monkeypatch.setattr(main, "send_discord", lambda *a, **k: True)
    cfg = _user_cfg()
    cfg["dashboard"] = True
    cfg["notify"] = {"discord_webhook_env": "HOOK"}
    jobs = _two_jobs()
    state = _touched(jobs)
    store = FakeStore()
    main.process_user(cfg, jobs, state, dry_run=False, now=NOW, store=store)
    assert all(user_notified == ["example"] for user_notified in
               (state["jobs"][j.dedup_key]["notified_for"] for j in jobs))
    assert all("delivery" not in i["facts"] for i in store.matches["example"])


# ------------------------------------------ review fixes: across users

def _llm_cfg(name, monkeypatch):
    cfg = _user_cfg(name=name)
    cfg["dashboard"] = True
    cfg["unknown_term_policy"] = "llm"
    cfg["rules"] = [{"when": {"term": ["Summer 2027"]},
                     "accept_if_any": [{"company_in_file":
                                        "data/top_companies.txt"}]}]
    cfg["llm"] = {"enabled": True,
                  "tasks": ["term_inference", "top_company_judgment"]}
    monkeypatch.setenv(api_key_env_for(cfg["llm"]), "k")
    return cfg


def test_cross_user_top_company_dates_and_fact_isolation(monkeypatch,
                                                         tmp_path):
    _wire_push(monkeypatch, tmp_path)
    monkeypatch.setattr(main, "classify", lambda batch, *a, **k: {
        j.dedup_key: {"term": "Summer 2027", "is_top_company": True,
                      "in_atlanta_metro": None} for j in batch})
    a_cfg, b_cfg = (_llm_cfg("a", monkeypatch), _llm_cfg("b", monkeypatch))
    b_cfg["priority"] = {"companies": ["Obscure Startup"]}
    day1, day2 = NOW, NOW + dt.timedelta(days=4)
    state = st.empty_state()
    termed: set[str] = set()
    j1 = _j(company="Obscure Startup", terms=[], term_confidence="unknown",
            url="https://x.com/one")
    st.touch(state, j1.dedup_key, j1.sources, TODAY)
    a_store, b_store = FakeStore(), FakeStore()
    main.process_user(a_cfg, [j1], state, dry_run=False, now=day1,
                      store=a_store, llm_termed=termed)
    # B sees the same Job object later in the same run (term already written
    # onto it by A's LLM step): same termSource, own acceptance, own facts
    main.process_user(b_cfg, [j1], state, dry_run=False, now=day1,
                      store=b_store, llm_termed=termed)
    fa = a_store.matches["a"][0]["facts"]
    fb = b_store.matches["b"][0]["facts"]
    assert fa["termSource"] == fb["termSource"] == "llm"
    assert fa["acceptedBy"] == "rule" and fb["acceptedBy"] == "priority"
    assert fb["topCompany"]["source"] == "list"
    assert st.matches_items(state, "a")[0]["facts"] is not \
        st.matches_items(state, "b")[0]["facts"]
    # B's own LLM verdict on the employer comes days later...
    b_cfg.pop("priority")
    j2 = _j(company="Obscure Startup", terms=[], term_confidence="unknown",
            url="https://x.com/two",
            title="Platform Software Engineer Intern")   # not a content dup
    st.touch(state, j2.dedup_key, j2.sources, day2.date())
    main.process_user(b_cfg, [j2], state, dry_run=False, now=day2,
                      store=b_store, llm_termed=set())
    assert state["companies"]["obscure startup"]["judged"] == "2026-08-30"
    # ...and A's next match from that employer still reports A's date
    j3 = _j(company="Obscure Startup", url="https://x.com/three",
            title="Backend Software Engineer Intern")   # not a content dup
    st.touch(state, j3.dedup_key, j3.sources, day2.date())
    main.process_user(a_cfg, [j3], state, dry_run=False, now=day2,
                      store=a_store, llm_termed=set())
    a_items = {i["key"]: i["facts"] for i in a_store.matches["a"]}
    assert a_items[j3.dedup_key]["topCompany"] == {
        "verdict": True, "judgedAt": "2026-08-26", "source": "llm"}
    b_items = {i["key"]: i["facts"] for i in b_store.matches["b"]}
    assert b_items[j2.dedup_key]["topCompany"]["judgedAt"] == "2026-08-30"


def test_clearance_obtainable_through_process_user(monkeypatch, tmp_path):
    _wire_push(monkeypatch, tmp_path)
    jd = "Applicants must be able to obtain a Secret clearance."
    job = _j(url="https://x.com/clr", description=jd)
    state = _touched([job])
    on = _user_cfg(name="on")              # eliminate.active_clearance: True
    off = _user_cfg(name="off")
    off["eliminate"] = {**off["eliminate"], "active_clearance": False}
    for cfg in (on, off):
        cfg["dashboard"] = True
    stores = {"on": FakeStore(), "off": FakeStore()}
    for cfg in (on, off):
        main.process_user(cfg, [job], state, dry_run=False, now=NOW,
                          store=stores[cfg["name"]])
    assert stores["on"].matches["on"][0]["facts"]["clearanceObtainable"] \
        is True
    assert "clearanceObtainable" not in \
        stores["off"].matches["off"][0]["facts"]


# ------------------------------- merge with main: JD terms and rechecks

def test_jd_body_term_has_no_term_source():
    # A term read from the JD body is neither the source row's nor the LLM's.
    assert "termSource" not in _build(_j(terms_from_jd=True), ["always"])
    # URL-slug terms are source data
    assert _build(_j(terms_inferred=True), ["always"])["termSource"] == "title"
    assert _build(_j(terms_from_jd=True), ["always"],
                  llm_termed=True)["termSource"] == "llm"


def test_recheck_marker_is_not_the_accepting_rule():
    f = _build(_j(), ["location:remote", main.RECHECK_REASON])
    assert f["acceptedBy"] == "rule"
    assert f["acceptedRule"] == "location:remote"


def test_llm_term_on_one_users_copy_is_llm_only_for_that_user(monkeypatch,
                                                              tmp_path):
    # JD says Fall 2027. The summer user does not want it, so the LLM is
    # asked and says Summer (replaced on that user's own copy); the fall user
    # accepts on the JD term. Whichever runs first, only the summer user's
    # facts say the term came from the LLM.
    _wire_push(monkeypatch, tmp_path)

    def cfg_for(name, term):
        cfg = _user_cfg(name=name, terms=[term])
        cfg["dashboard"] = True
        cfg["rules"] = [{"when": {"term": [term]},
                         "accept_if_any": [{"always": True}]}]
        cfg["unknown_term_policy"] = "llm"
        cfg["llm"] = {"enabled": True, "tasks": ["term_inference"]}
        return cfg
    cfgs = {"summer": cfg_for("summer", "Summer 2027"),
            "fall": cfg_for("fall", "Fall 2027")}
    monkeypatch.setenv(api_key_env_for(cfgs["summer"]["llm"]), "k")
    monkeypatch.setattr(main, "classify", lambda batch, *a, **k: {
        j.dedup_key: {"term": "Summer 2027"} for j in batch})
    for order in (("summer", "fall"), ("fall", "summer")):
        job = _j(terms=["Fall 2027"], term_confidence="inferred",
                 terms_from_jd=True, terms_inferred=True,
                 url=f"https://x.com/{order[0]}")
        state = st.empty_state()
        termed: set[str] = set()
        stores = {n: FakeStore() for n in order}
        for n in order:
            main.process_user(cfgs[n], [job], state, dry_run=False, now=NOW,
                              store=stores[n], llm_termed=termed)
        assert termed == set(), order    # nothing written onto the shared job
        summer = stores["summer"].matches["summer"][0]["facts"]
        fall = stores["fall"].matches["fall"][0]["facts"]
        assert summer["termSource"] == "llm", order
        assert "termSource" not in fall, order
