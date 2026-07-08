"""Source-health alerting: failure counters, digest warnings, one-shot email."""

import datetime as dt

from src import main, state as st
from src.notify import build_email, build_health_email

TODAY = dt.date(2026, 6, 12)
NOW = dt.datetime(2026, 6, 12, 12, 5, tzinfo=dt.timezone.utc)


def test_failure_counting_threshold_and_recovery(tmp_path):
    state = st.load_state(tmp_path / "seen.json")
    assert st.record_source_failure(state, "s1", "boom", TODAY) == 1
    for n in range(2, st.HEALTH_ALERT_AFTER):
        assert st.record_source_failure(state, "s1", "boom again", TODAY) == n
    assert st.unhealthy_sources(state) == {}      # below threshold
    assert st.record_source_failure(
        state, "s1", "still down", TODAY) == st.HEALTH_ALERT_AFTER
    assert set(st.unhealthy_sources(state)) == {"s1"}

    lines = st.health_warning_lines(state)
    assert len(lines) == 1
    assert f"{st.HEALTH_ALERT_AFTER} consecutive" in lines[0]
    assert "still down" in lines[0]              # latest error wins
    assert "2026-06-12" in lines[0]              # first_failure date

    # survives a save/load roundtrip
    st.save_state(state, tmp_path / "seen.json")
    assert st.health_warning_lines(st.load_state(tmp_path / "seen.json")) == lines

    st.record_source_success(state, "s1")
    assert st.health_warning_lines(state) == []


def test_alert_once_per_outage_per_user():
    state = st.empty_state()
    for _ in range(st.HEALTH_ALERT_AFTER):
        st.record_source_failure(state, "s1", "x", TODAY)
    assert st.health_alert_needed(state, "example")
    st.mark_health_alerted(state, "example")
    assert not st.health_alert_needed(state, "example")
    assert st.health_alert_needed(state, "otheruser")   # per-user

    # recovery resets the outage; a new one alerts again
    st.record_source_success(state, "s1")
    for _ in range(st.HEALTH_ALERT_AFTER):
        st.record_source_failure(state, "s1", "x", TODAY)
    assert st.health_alert_needed(state, "example")


def test_digest_email_includes_health_section():
    items = [{"key": "k1", "company": "Acme", "title": "SWE Intern",
              "location": "Atlanta, GA", "salary": None, "url": "https://x.com",
              "tag": "", "term": "Fall 2026"}]
    warning = "source 'simplify' has failed 3 consecutive runs"
    _, html, text = build_email(items, ["Fall 2026"], NOW,
                                health_warnings=[warning])
    assert "Source health" in text and warning in text
    assert "Source health" in html and "simplify" in html
    # and without warnings the section is absent
    _, html2, text2 = build_email(items, ["Fall 2026"], NOW)
    assert "Source health" not in text2 and "Source health" not in html2


def test_standalone_health_email_body():
    subject, html, text = build_health_email(["w-one", "w-two"], NOW)
    assert "2 sources failing" in subject
    assert "w-one" in text and "w-two" in text
    assert "w-one" in html and "w-two" in html


def test_fetch_all_records_health(monkeypatch, today):
    from src.models import Job, SourceConfig

    class DeadAdapter:
        def __init__(self, cfg): pass
        def fetch(self, client, today): raise RuntimeError("dead")

    class OkAdapter:
        def __init__(self, cfg): pass
        def fetch(self, client, today):
            return [Job(company="Acme", title="SWE Intern",
                        url="https://x.com/1", source="ok-src")]

    adapters = {"dead-src": DeadAdapter, "ok-src": OkAdapter}
    monkeypatch.setattr(main, "make_adapter",
                        lambda cfg: adapters[cfg.name](cfg))
    sources = [SourceConfig(name="dead-src", adapter="a"),
               SourceConfig(name="ok-src", adapter="a")]
    state = st.empty_state()
    # dead-src was previously failing twice; ok-src too (it should recover)
    for _ in range(2):
        st.record_source_failure(state, "dead-src", "x", today)
        st.record_source_failure(state, "ok-src", "x", today)

    jobs = main.fetch_all(sources, state, today)
    assert len(jobs) == 1
    health = state["_meta"]["source_health"]
    assert health["dead-src"]["consecutive_failures"] == 3
    assert "ok-src" not in health


def test_zero_rows_counts_as_failure(monkeypatch, today):
    from src.models import SourceConfig

    class EmptyAdapter:
        def __init__(self, cfg): pass
        def fetch(self, client, today): return []

    monkeypatch.setattr(main, "make_adapter", lambda cfg: EmptyAdapter(cfg))
    state = st.empty_state()
    state["_meta"]["source_rows"]["was-full"] = 50   # used to parse rows
    main.fetch_all([SourceConfig(name="was-full", adapter="a")], state, today)
    entry = state["_meta"]["source_health"]["was-full"]
    assert entry["consecutive_failures"] == 1
    assert "parsed 0 rows (was 50)" in entry["last_error"]


def _email_cfg(monkeypatch):
    monkeypatch.setenv("SMTP_U", "u@example.com")
    monkeypatch.setenv("SMTP_P", "pass")
    return {"name": "example",
            "notify": {"email": {"smtp_user_env": "SMTP_U",
                                 "smtp_pass_env": "SMTP_P",
                                 "send_at_utc": [0, 12, 18]}}}


def test_health_alert_sent_once_when_outbox_empty(monkeypatch):
    sent = []
    monkeypatch.setattr(main, "send_email",
                        lambda *args, **kw: sent.append(args) or True)
    cfg = _email_cfg(monkeypatch)
    state = st.empty_state()
    for _ in range(st.HEALTH_ALERT_AFTER):
        st.record_source_failure(state, "s1", "x", TODAY)

    # slot due (no email ever sent), outbox empty -> standalone alert
    main._notify_email(cfg, [], state, False, NOW, [], False)
    assert len(sent) == 1
    assert "failing" in sent[0][3]               # subject
    # the alert does not consume the send slot
    assert st.get_last_email(state, "example") is None

    # next slot, still broken: already alerted, stays silent
    main._notify_email(cfg, [], state, False, NOW, [], False)
    assert len(sent) == 1


def test_digest_send_marks_health_alerted(monkeypatch):
    sent = []
    monkeypatch.setattr(main, "send_email",
                        lambda *args, **kw: sent.append(args) or True)
    cfg = _email_cfg(monkeypatch)
    state = st.empty_state()
    for _ in range(st.HEALTH_ALERT_AFTER):
        st.record_source_failure(state, "s1", "x", TODAY)
    st.outbox_add(state, "example",
                  {"key": "k1", "company": "Acme", "title": "SWE Intern",
                   "location": "Atlanta, GA", "salary": None,
                   "url": "https://x.com", "tag": "", "term": "Fall 2026"})

    main._notify_email(cfg, [], state, False, NOW, ["Fall 2026"], False)
    assert len(sent) == 1
    assert "Source health" in sent[0][5]         # text body carries warning
    assert not st.health_alert_needed(state, "example")
