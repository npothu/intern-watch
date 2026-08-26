"""Priority companies and per-season presets, end to end: rule engine,
email ordering/subjects, the immediate alert, the prefs overlay through a
store, and config validation."""

import datetime as dt
from pathlib import Path

import pytest

from src import config_check as cc
from src import main
from src import state as st
from src.filters import UserFilter, preset_conds, rules_from_presets
from src.models import Job, SourceConfig
from src.notify import (
    build_digest,
    build_email,
    build_priority_email,
    match_item,
    priority_names,
)
from tests.fakestore import FakeStore
from tests.test_main_integration import (
    _freeze_clock,
    _job,
    _key,
    _user_cfg,
    _wire,
)

ROOT = Path(__file__).resolve().parents[1]
TODAY = dt.date(2026, 8, 26)
NOW = dt.datetime(2026, 8, 26, 12, 5, tzinfo=dt.UTC)
TERMS = ["Spring 2027", "Summer 2027", "Fall 2027"]


def _cfg(**over):
    cfg = {"name": "example",
           "role_filter": {"include_keywords": ["software"]},
           "terms": {"rolling": True, "lead_weeks": 3, "horizon_months": 14},
           "term_rules": {"Spring": "top_atl_remote", "Summer": "anything",
                          "Fall": "top_atl_remote"},
           "priority": {"companies": ["Microsoft", "Meta"]},
           "location": {"remote_counts": True}}
    cfg.update(over)
    return cfg


def _j(**kw):
    base = {"company": "SomeCo", "title": "Software Engineer Intern",
            "url": "https://x.com/1", "source": "s", "locations": ["Denver, CO"]}
    base.update(kw)
    return Job(**base)


# ------------------------------------------------------------ rule engine

def test_presets_expand_to_conditions():
    assert preset_conds("anything") == [{"priority": True}, {"always": True}]
    assert preset_conds("priority_only") == [{"priority": True}]
    full = preset_conds("top_atl_remote", {"remote_counts": True})
    assert full[0] == {"priority": True}
    assert "remote" in full[-1]["location_matches"]
    assert "remote" not in preset_conds(
        "top_atl_remote", {"remote_counts": False})[-1]["location_matches"]
    with pytest.raises(ValueError):
        preset_conds("bogus")


def test_rules_from_presets_one_rule_per_wanted_term():
    rules = rules_from_presets({"Summer": "anything"}, TERMS)
    assert [r["when"]["term"] for r in rules] == [[t] for t in TERMS]
    # a season without a preset falls back to the safe side: priority only
    assert rules[0]["accept_if_any"] == [{"priority": True}]
    assert rules[1]["accept_if_any"] == [{"priority": True}, {"always": True}]


def test_rolling_terms_and_presets_drive_the_verdict():
    uf = UserFilter(_cfg(), ROOT, today=TODAY)
    assert uf.terms_order == TERMS
    # Fall 2026 started already: not wanted, whatever the company.
    v = uf.evaluate(_j(company="Microsoft", terms=["Fall 2026"]), today=TODAY)
    assert v.status == "reject" and v.reasons == ["term-not-wanted"]
    # Spring is picky: an unknown company in Denver is ambiguous (LLM off ->
    # rejected), a Summer one is accepted outright.
    assert uf.evaluate(_j(terms=["Spring 2027"]), today=TODAY).status == "reject"
    assert uf.evaluate(_j(terms=["Summer 2027"]), today=TODAY).status == "accept"


def test_priority_company_accepted_for_any_wanted_term():
    uf = UserFilter(_cfg(), ROOT, today=TODAY)
    v = uf.evaluate(_j(company="Meta, Inc.", terms=["Spring 2027"]),
                    today=TODAY)
    assert v.status == "accept" and v.reasons == ["company:priority"]
    # aliases from the top-company list widen the typed name: Meta ~ Facebook
    v = uf.evaluate(_j(company="Facebook", terms=["Spring 2027"]), today=TODAY)
    assert v.reasons == ["company:priority"]
    assert uf.is_priority("Instagram") and not uf.is_priority("Google")
    # ...but only for wanted terms, and only when it isn't eliminated
    v = uf.evaluate(_j(company="Meta", terms=["Spring 2028"]), today=TODAY)
    assert v.status == "reject"
    v = uf.evaluate(_j(company="Meta", title="Software Intern (PhD)",
                       terms=["Spring 2027"]),
                    today=TODAY)
    assert v.status == "accept"  # grad_only elimination not enabled here


def test_priority_only_preset_rejects_everyone_else():
    uf = UserFilter(_cfg(term_rules={"Summer": "priority_only"}), ROOT,
                    today=TODAY)
    assert uf.evaluate(_j(terms=["Summer 2027"]), today=TODAY).status == "reject"
    assert uf.evaluate(_j(company="Microsoft", terms=["Summer 2027"]),
                       today=TODAY).status == "accept"


def test_priority_applies_to_legacy_rules_too():
    cfg = {"name": "x", "role_filter": {"include_keywords": ["software"]},
           "terms_wanted": ["Spring 2027"],
           "rules": [{"when": {"term": ["Spring 2027"]},
                      "accept_if_any": [{"company_in_file":
                                         "data/atlanta_companies.txt"}]}],
           "priority": {"companies": ["Amazon"]}}
    uf = UserFilter(cfg, ROOT, today=TODAY)
    assert uf.legacy_rules
    assert uf.rules[0]["accept_if_any"][0] == {"priority": True}
    assert uf.evaluate(_j(company="AWS", terms=["Spring 2027"]),
                       today=TODAY).reasons == ["company:priority"]
    assert uf.evaluate(_j(company="Zillow", terms=["Spring 2027"]),
                       today=TODAY).status == "reject"
    uf.add_priority({"zillow"})  # what main.py does with tracker employers
    assert uf.evaluate(_j(company="Zillow, Inc.", terms=["Spring 2027"]),
                       today=TODAY).reasons == ["company:priority"]


def test_unknown_term_priority_is_accepted_under_every_term():
    uf = UserFilter(_cfg(), ROOT, today=TODAY)
    v = uf.evaluate(_j(company="Microsoft", terms=[]), today=TODAY,
                    llm_facts={"term": None})
    assert v.status == "accept" and "company:priority" in v.reasons


# ------------------------------------------------------------------ notify

def _m(i, term, reasons, company=None):
    return (Job(company=company or f"Co{i}", title=f"SWE Intern {i}",
                terms=[term], url=f"https://x.com/{i}", source="s",
                locations=["Atlanta, GA"]), reasons)


def test_tag_and_item_priority_field():
    job, reasons = _m(1, "Spring 2027", ["company:priority"], "Meta")
    item = match_item(job, reasons, TERMS)
    assert item["tag"] == "[PRIORITY]" and item["priority"] is True
    plain = match_item(*_m(2, "Spring 2027", ["company:top_companies"]), TERMS)
    assert "priority" not in plain


def test_digest_and_email_order_priority_then_top_then_rest():
    matches = [_m(1, "Spring 2027", ["location:remote"], "Zed"),
               _m(2, "Spring 2027", ["company:top_companies"], "Yak"),
               _m(3, "Spring 2027", ["company:priority"], "Xor"),
               _m(4, "Spring 2027", ["company:top_companies (LLM)"], "Aardvark")]
    text = "\n".join(build_digest(matches, TERMS, NOW))
    assert text.index("[PRIORITY] Xor") < text.index("[TOP*] Aardvark") \
        < text.index("[TOP] Yak") < text.index("[REMOTE] Zed")
    items = [match_item(j, r, TERMS) for j, r in matches]
    subject, html, body = build_email(items, TERMS, NOW)
    assert body.index("Xor") < body.index("Aardvark") < body.index("Yak") \
        < body.index("Zed")
    assert subject == "intern-watch: 4 new · Xor (Spring 2027: 4)"
    assert build_email(items, TERMS, NOW, subject_names=False)[0] == \
        "intern-watch: 4 new (Spring 2027: 4)"


def test_priority_names_caps_at_three():
    items = [{"company": c, "priority": True} for c in "ABCDE"] \
        + [{"company": "A", "priority": True}, {"company": "Z"}]
    assert priority_names(items) == "A, B, C +2"
    assert priority_names([{"company": "Z"}]) == ""


def test_priority_email_subjects():
    one = [match_item(*_m(1, "Spring 2027", ["company:priority"], "Meta"), TERMS)]
    subject, html, text = build_priority_email(one, TERMS, NOW)
    assert subject == "intern-watch: Meta - SWE Intern 1 (Spring 2027)"
    assert "will not repeat" in text and "https://x.com/1" in html
    two = one + [match_item(*_m(2, "Summer 2027", ["company:priority"],
                                "Microsoft"), TERMS)]
    assert build_priority_email(two, TERMS, NOW)[0] == \
        "intern-watch: 2 priority matches · Meta, Microsoft"


# ------------------------------------------------- orchestrator: alert flow

def _priority_user(**pri):
    cfg = _user_cfg(terms=["Summer 2027"])
    cfg["priority"] = {"companies": ["Company1"], "email_immediately": True,
                       **pri}
    return cfg


def _sources(*jobs):
    class Adapter:
        def __init__(self, cfg): pass
        def fetch(self, client, today): return list(jobs)
    return [SourceConfig(name="ok-src", adapter="a")], {"ok-src": Adapter}


def _recorder(monkeypatch, fail_subject_prefix=None):
    sent: list[str] = []

    def send(smtp_user, pw, to, subject, html, text, **kw):
        sent.append(subject)
        return not (fail_subject_prefix and subject.startswith(fail_subject_prefix))
    monkeypatch.setattr(main, "send_email", send)
    return sent


def test_priority_match_is_emailed_on_the_run_that_found_it(monkeypatch, tmp_path):
    sources, adapters = _sources(_job(1), _job(2))
    _wire(monkeypatch, sources, adapters, [_priority_user()])
    sent = _recorder(monkeypatch)
    # 03:05 UTC: no send slot (0/12/18) has passed since the seeded email,
    # so the digest is NOT due -- only the alert may go out.
    now = dt.datetime(2026, 6, 12, 3, 5, tzinfo=dt.UTC)
    _freeze_clock(monkeypatch, now=now)
    state_file = tmp_path / "seen.json"
    pre = st.empty_state()
    st.touch(pre, "jr:preexisting", ["ok-src"], now.date())
    st.set_last_email(pre, "example", now - dt.timedelta(hours=2))
    st.save_state(pre, state_file)

    assert main.main(["--state-file", str(state_file)]) == 0
    state = st.load_state(state_file)
    assert sent == ["intern-watch: Company1 - Software Engineer Intern (Summer 2027)"]
    assert st.was_notified(state, _key(1), "example")
    assert not st.was_notified(state, _key(2), "example")
    assert [i["key"] for i in st.outbox_items(state, "example")] == [_key(2)]


def test_failed_alert_keeps_the_match_for_the_digest(monkeypatch, tmp_path):
    sources, adapters = _sources(_job(1), _job(2))
    _wire(monkeypatch, sources, adapters, [_priority_user()])
    sent = _recorder(monkeypatch, fail_subject_prefix="intern-watch: Company1")
    _freeze_clock(monkeypatch)  # 12:05 UTC: the digest slot is due
    state_file = tmp_path / "seen.json"
    pre = st.empty_state()
    st.touch(pre, "jr:preexisting", ["ok-src"], dt.date(2026, 6, 12))
    st.save_state(pre, state_file)

    assert main.main(["--state-file", str(state_file)]) == 0
    state = st.load_state(state_file)
    assert sent[0].startswith("intern-watch: Company1")
    assert sent[1] == "intern-watch: 2 new · Company1 (Summer 2027: 2)"
    assert st.was_notified(state, _key(1), "example")
    assert not st.outbox_items(state, "example")


def test_alert_off_names_priority_in_the_digest_subject(monkeypatch, tmp_path):
    sources, adapters = _sources(_job(1), _job(2))
    _wire(monkeypatch, sources, adapters,
          [_priority_user(email_immediately=False)])
    sent = _recorder(monkeypatch)
    _freeze_clock(monkeypatch)
    state_file = tmp_path / "seen.json"
    pre = st.empty_state()
    st.touch(pre, "jr:preexisting", ["ok-src"], dt.date(2026, 6, 12))
    st.save_state(pre, state_file)
    assert main.main(["--state-file", str(state_file)]) == 0
    assert sent == ["intern-watch: 2 new · Company1 (Summer 2027: 2)"]


# ----------------------------------------------- store prefs overlay + report

def test_store_prefs_overlay_and_report(monkeypatch, tmp_path):
    sent = _recorder(monkeypatch)
    monkeypatch.setenv("SMTP_U", "u@example.com")
    monkeypatch.setenv("SMTP_P", "pass")
    monkeypatch.setattr(main, "DATA_ROOT", tmp_path)
    cfg = _user_cfg(terms=["Summer 2027"])
    store = FakeStore()
    # The page saved: rolling terms, Summer picky, Company2 is priority.
    store.watch_prefs["example"] = {
        "terms": {"leadWeeks": 3, "horizonMonths": 14},
        "rules": {"Summer": "priority_only"},
        "priority": {"companies": ["Company2"], "emailImmediately": False},
    }
    state = st.empty_state()
    jobs = [_job(1), _job(2)]
    for j in jobs:
        j.dedup_key = f"url:{j.url}"
    main.process_user(cfg, jobs, state, dry_run=False, now=NOW, store=store)

    # NOW is 12:05 UTC: the digest slot is due, so the one accepted match
    # (Company2, priority) went out; Company1 fell to priority_only.
    assert sent == ["intern-watch: 1 new · Company2 (Summer 2027: 1)"]
    assert st.was_notified(state, "url:https://x.com/2", "example")
    assert not st.was_notified(state, "url:https://x.com/1", "example")
    user, report = store.watch_reports[-1]
    assert user == "example"
    assert report["rules"] == {"legacy": False, "Spring": "priority_only",
                               "Summer": "priority_only", "Fall": "priority_only"}
    assert [r["term"] for r in report["terms"]["rows"] if r["wanted"]] == TERMS
    assert report["priority"]["companies"] == ["Company2"]


def test_dry_run_pushes_no_report(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "DATA_ROOT", tmp_path)
    store = FakeStore()
    main.process_user(_user_cfg(), [], st.empty_state(), dry_run=True,
                      now=NOW, store=store)
    assert store.watch_reports == []


# ------------------------------------------------------------ config_check

def _check(user):
    return cc.validate_user(user, "t", root=ROOT, wired_env={"GMAIL_ADDRESS",
                                                             "GMAIL_APP_PASSWORD"})


def test_config_check_accepts_the_new_blocks():
    rep = _check({"name": "t", **_cfg()})
    assert rep.ok, rep.render()


@pytest.mark.parametrize("bad, needle", [
    ({"terms": {"lead_weeks": "3"}}, "terms.lead_weeks"),
    ({"terms": {"include": ["Fall"]}}, "terms.include"),
    ({"term_rules": {"Autumn": "anything"}}, "season 'Autumn'"),
    ({"term_rules": {"Fall": "picky"}}, "term_rules.Fall"),
    ({"priority": {"companies": "Meta"}}, "priority.companies"),
    ({"priority": {"from_tracker": "yes"}}, "priority.from_tracker"),
    ({"location": {"remote_counts": 1}}, "location.remote_counts"),
])
def test_config_check_rejects_malformed_blocks(bad, needle):
    rep = _check({"name": "t", **bad})
    assert not rep.ok
    assert needle in rep.render()


def test_config_check_warns_when_both_forms_present():
    rep = _check({"name": "t", "terms": {"rolling": True},
                  "terms_wanted": ["Fall 2026"],
                  "term_rules": {"Fall": "anything"},
                  "rules": [{"accept_if_any": [{"always": True}]}]})
    assert rep.ok
    assert "terms_wanted is ignored" in rep.render()
    assert "rules is ignored" in rep.render()


# ------------------------------------------- alerts are for this run only

def test_failed_alert_is_not_retried_on_the_next_run(monkeypatch, tmp_path):
    sources, adapters = _sources(_job(1))
    _wire(monkeypatch, sources, adapters, [_priority_user()])
    sent = _recorder(monkeypatch, fail_subject_prefix="intern-watch: Company1")
    state_file = tmp_path / "seen.json"
    pre = st.empty_state()
    pre_now = dt.datetime(2026, 6, 12, 1, 5, tzinfo=dt.UTC)
    st.touch(pre, "jr:preexisting", ["ok-src"], pre_now.date())
    st.set_last_email(pre, "example", pre_now)  # 00:00 slot already served
    st.save_state(pre, state_file)

    _freeze_clock(monkeypatch, now=dt.datetime(2026, 6, 12, 3, 5, tzinfo=dt.UTC))
    assert main.main(["--state-file", str(state_file)]) == 0
    assert len(sent) == 1                      # the alert, which failed
    state = st.load_state(state_file)
    assert [i["key"] for i in st.outbox_items(state, "example")] == [_key(1)]

    # Two hours later the job is not new any more: no second alert, the
    # match simply waits for the digest.
    _freeze_clock(monkeypatch, now=dt.datetime(2026, 6, 12, 5, 5, tzinfo=dt.UTC))
    assert main.main(["--state-file", str(state_file)]) == 0
    assert len(sent) == 1
    assert [i["key"] for i in st.outbox_items(state, "example")] == [_key(1)]


def test_turning_alerts_on_does_not_fire_for_queued_matches(monkeypatch, tmp_path):
    sources, adapters = _sources(_job(1))
    cfg = _priority_user()
    _wire(monkeypatch, sources, adapters, [cfg])
    sent = _recorder(monkeypatch)
    state_file = tmp_path / "seen.json"
    pre = st.empty_state()
    pre_now = dt.datetime(2026, 6, 12, 1, 5, tzinfo=dt.UTC)
    st.touch(pre, "jr:preexisting", ["ok-src"], pre_now.date())
    st.touch(pre, _key(1), ["ok-src"], pre_now.date())  # seen earlier...
    st.outbox_add(pre, "example", {"key": _key(1), "company": "Company1",
                                   "title": "t", "location": "l", "url": "u",
                                   "tag": "[PRIORITY]", "term": "Summer 2027",
                                   "priority": True})  # ...and queued
    st.set_last_email(pre, "example", pre_now)
    st.save_state(pre, state_file)
    _freeze_clock(monkeypatch, now=dt.datetime(2026, 6, 12, 3, 5, tzinfo=dt.UTC))
    assert main.main(["--state-file", str(state_file)]) == 0
    assert sent == []


# ------------------------------------------------------------- dashboard

def test_dashboard_orders_priority_then_top_then_rest():
    from src.dashboard import build_body
    items = [
        {"key": "k1", "company": "Zed", "title": "t", "location": "l",
         "url": "https://x/1", "tag": "", "term": "Spring 2027", "added": "2026-08-26"},
        {"key": "k2", "company": "Yak", "title": "t", "location": "l",
         "url": "https://x/2", "tag": "[TOP]", "term": "Spring 2027", "added": "2026-08-20"},
        {"key": "k3", "company": "Xor", "title": "t", "location": "l",
         "url": "https://x/3", "tag": "[PRIORITY]", "term": "Spring 2027",
         "added": "2026-08-01", "priority": True},
        {"key": "k4", "company": "Aardvark", "title": "t", "location": "l",
         "url": "https://x/4", "tag": "", "term": "Spring 2027", "added": "2026-08-26"},
    ]
    body = build_body(items, TERMS, NOW)
    assert body.index("Xor") < body.index("Yak") < body.index("Aardvark") \
        < body.index("Zed")


def test_report_resolves_every_season():
    from src import prefs
    rep = prefs.watch_report(_cfg(term_rules={"Summer": "anything"}), TODAY, NOW,
                             {}, legacy_rules=False)
    assert rep["rules"] == {"legacy": False, "Spring": "priority_only",
                            "Summer": "anything", "Fall": "priority_only"}


def test_elimination_still_beats_priority():
    uf = UserFilter(_cfg(eliminate={"grad_only": True}), ROOT, today=TODAY)
    v = uf.evaluate(_j(company="Microsoft", title="Software Intern (PhD)",
                       terms=["Summer 2027"]), today=TODAY)
    assert v.status == "reject" and v.reasons == ["eliminated:grad-only-title"]
