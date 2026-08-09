"""Accept-time auto-build wiring: process_user builds a resume per accepted
job (commit/email modes), records the path on the match/outbox items, and
fails open. Plus the dashboard's commit-mode resume link.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

from src import dashboard as db
from src import main
from src import state as st
from src.models import Job
from src.resume.build import BuildResult

NOW = dt.datetime(2026, 6, 12, 18, 0, tzinfo=dt.UTC)


# ----------------------------------------------------------- fixtures/helpers

def _accepting_cfg(**extra):
    cfg = {
        "name": "t",
        "role_filter": {"include_keywords": ["swe", "engineer"]},
        "terms_wanted": ["Fall 2026"],
        "unknown_term_policy": "keep",
        "rules": [{"when": {"term": ["Fall 2026"]},
                   "accept_if_any": [{"always": True}]}],
        "notify": {"email": {"send_at_utc": [18]}},
    }
    cfg.update(extra)
    return cfg


def _job(i: str) -> Job:
    key = f"jr:{i * 24}"
    # Distinct title per job so the content-dedup gate treats them as three
    # separate postings (this test exercises resume-build capping, not dedup).
    return Job(company="Stripe", title=f"SWE Intern {i}",
               url=f"https://x.test/{i}", dedup_key=key,
               terms=["Fall 2026"], term_confidence="explicit",
               source="jobright-eng")


def _stub_build(monkeypatch, calls):
    """Make build_for_job write a fake .docx under resumes/<user>/ and record
    each call, so the recorded relative path is real and the cap is observable."""
    def fake(job, user, *, out_dir, root, use_llm=True, allow_scrape=True,
             client=None):
        calls.append(job.dedup_key)
        out = Path(out_dir) / f"{db.short_key(job.dedup_key)}.docx"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text("x", encoding="utf-8")
        return BuildResult(out_path=out, report="", pages=1.0, used_llm=False)

    monkeypatch.setattr(main, "build_for_job", fake)
    return calls


# ----------------------------------------------------------- enabled => path set

def test_enabled_sets_resume_path_on_match(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "ROOT", tmp_path)
    calls = _stub_build(monkeypatch, [])
    cfg = _accepting_cfg(dashboard=True,
                         resume_build={"enabled": True, "modes": ["commit"],
                                       "use_llm": False})
    state = st.empty_state()
    main.process_user(cfg, [_job("a")], state, dry_run=False, now=NOW,
                      send_now=True)

    assert calls == [f"jr:{'a' * 24}"]
    items = st.matches_items(state, "t")
    assert len(items) == 1
    short = db.short_key(items[0]["key"])
    # the store keys the .docx by (user, short, filename); GitHubStore writes
    # it to resumes/t/<short>/<filename>.docx and returns that repo-relative path
    assert items[0]["resume"] == f"resumes/t/{short}/{short}.docx"
    # outbox (email path) carries the same key
    out = st.outbox_items(state, "t")
    assert out and out[0].get("resume") == items[0]["resume"]


def test_disabled_builds_nothing(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "ROOT", tmp_path)
    calls = _stub_build(monkeypatch, [])
    cfg = _accepting_cfg(dashboard=True)  # no resume_build block => off
    state = st.empty_state()
    main.process_user(cfg, [_job("b")], state, dry_run=False, now=NOW,
                      send_now=True)
    assert calls == []
    assert "resume" not in st.matches_items(state, "t")[0]


def test_dashboard_only_mode_does_not_build(monkeypatch, tmp_path):
    """`dashboard` is on-demand: accept-time builds only for commit/email."""
    monkeypatch.setattr(main, "ROOT", tmp_path)
    calls = _stub_build(monkeypatch, [])
    cfg = _accepting_cfg(dashboard=True,
                         resume_build={"enabled": True, "modes": ["dashboard"]})
    state = st.empty_state()
    main.process_user(cfg, [_job("c")], state, dry_run=False, now=NOW,
                      send_now=True)
    assert calls == []


def test_dry_run_builds_nothing(monkeypatch, tmp_path, caplog):
    import logging
    monkeypatch.setattr(main, "ROOT", tmp_path)
    calls = _stub_build(monkeypatch, [])
    cfg = _accepting_cfg(dashboard=True,
                         resume_build={"enabled": True, "modes": ["commit"]})
    state = st.empty_state()
    with caplog.at_level(logging.INFO):
        main.process_user(cfg, [_job("d")], state, dry_run=True, now=NOW,
                          send_now=True)
    assert calls == []
    assert "would build 1 resume" in caplog.text


def test_max_per_run_caps_builds(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "ROOT", tmp_path)
    calls = _stub_build(monkeypatch, [])
    cfg = _accepting_cfg(dashboard=True,
                         resume_build={"enabled": True, "modes": ["commit"],
                                       "max_per_run": 1, "use_llm": False})
    state = st.empty_state()
    jobs = [_job("a"), _job("b"), _job("c")]
    main.process_user(cfg, jobs, state, dry_run=False, now=NOW, send_now=True)
    assert len(calls) == 1  # capped
    # all three still delivered; only the first got a resume
    items = {i["key"]: i for i in st.matches_items(state, "t")}
    assert len(items) == 3
    with_resume = [i for i in items.values() if "resume" in i]
    assert len(with_resume) == 1


def test_build_failure_keeps_match(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "ROOT", tmp_path)

    def boom(*a, **k):
        raise RuntimeError("scrape exploded")

    monkeypatch.setattr(main, "build_for_job", boom)
    cfg = _accepting_cfg(dashboard=True,
                         resume_build={"enabled": True, "modes": ["commit"]})
    state = st.empty_state()
    main.process_user(cfg, [_job("e")], state, dry_run=False, now=NOW,
                      send_now=True)
    items = st.matches_items(state, "t")
    assert len(items) == 1                 # match not dropped
    assert "resume" not in items[0]        # resume stays unset


def test_jd_miss_returns_none_no_resume_key(monkeypatch, tmp_path):
    """build_for_job returning None (no JD) leaves the match without a link."""
    monkeypatch.setattr(main, "ROOT", tmp_path)
    monkeypatch.setattr(main, "build_for_job", lambda *a, **k: None)
    cfg = _accepting_cfg(dashboard=True,
                         resume_build={"enabled": True, "modes": ["email"]})
    state = st.empty_state()
    main.process_user(cfg, [_job("f")], state, dry_run=False, now=NOW,
                      send_now=True)
    assert "resume" not in st.outbox_items(state, "t")[0]


# ----------------------------------------------------------- dashboard link

def _row_item(**kw):
    d = {"key": "url:https://x.com/1", "company": "Co", "title": "SWE Intern",
         "location": "Atlanta, GA", "salary": None, "url": "https://x.com/1",
         "tag": "", "term": "Fall 2026", "added": "2026-06-12",
         "applied": False}
    d.update(kw)
    return d


def test_row_renders_resume_link():
    row = db._row(_row_item(resume="resumes/example/r.docx"),
                  "example/autojobfinder", "main")
    assert "[📄 resume](/example/autojobfinder/blob/main/resumes/example/r.docx)" \
        in row


def test_row_no_link_without_resume_key():
    row = db._row(_row_item(), "example/autojobfinder", "main")
    assert "blob/" not in row   # no resume artifact -> no link


def test_row_no_link_without_repo():
    # The build sub-bullet may say "resume built", but without a repo there's
    # still no blob link to the .docx.
    row = db._row(_row_item(resume="resumes/example/r.docx"), "", "main")
    assert "blob/" not in row


def test_build_body_uses_repo_branch():
    items = [_row_item(resume="resumes/example/r.docx")]
    body = db.build_body(items, ["Fall 2026"], NOW,
                         "example/autojobfinder", "dev")
    assert "/example/autojobfinder/blob/dev/resumes/example/r.docx" in body
