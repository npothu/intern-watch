"""ondemand CLI: short-key lookup reconstructs the Job and prints the path;
an unknown short key exits nonzero. Plus the workflow YAML is well-formed."""

from __future__ import annotations

from pathlib import Path

import yaml

from src import dashboard, state as st
from src.resume import build, ondemand
from src.resume.build import BuildResult

ROOT = Path(__file__).resolve().parents[1]


def _state_with_match(key: str, **extra) -> dict:
    state = st.empty_state()
    item = {"key": key, "company": "Stripe", "title": "SWE Intern",
            "location": "Remote", "url": "https://x.test/1"}
    item.update(extra)
    st.matches_add(state, "example", item)
    return state


def test_short_key_reconstructs_job_and_prints_path(monkeypatch, tmp_path, capsys):
    key = "jr:" + "a" * 24
    short = dashboard.short_key(key)
    state = _state_with_match(key, jobright_id="b" * 24,
                              jd_url="https://x.test/jd")

    monkeypatch.setattr(ondemand.st, "load_state", lambda _p: state)

    captured = {}

    def fake_build(job, user, *, out_dir, root, use_llm=True,
                   allow_scrape=True, client=None, jd_text=None):
        captured["job"] = job
        captured["user"] = user
        captured["out_dir"] = out_dir
        captured["jd_text"] = jd_text
        return BuildResult(out_path=Path("out") / "r.docx", report="",
                           pages=1.0, used_llm=False)

    monkeypatch.setattr(ondemand, "build_for_job", fake_build)

    rc = ondemand.main(["--user", "example", "--short", short])
    assert rc == 0
    out = capsys.readouterr().out
    assert "r.docx" in out
    assert captured["jd_text"] is None  # no --jd => acquisition path

    job = captured["job"]
    assert job.dedup_key == key
    assert job.company == "Stripe"
    assert job.source == "dashboard"
    assert job.jobright_id == "b" * 24
    assert job.jd_url == "https://x.test/jd"
    assert captured["out_dir"] == Path("out")


def test_pasted_jd_bypasses_acquisition(monkeypatch, tmp_path, capsys):
    key = "url:https://www.tesla.com/careers/job/1"
    short = dashboard.short_key(key)
    state = _state_with_match(key)
    monkeypatch.setattr(ondemand.st, "load_state", lambda _p: state)

    jd_file = tmp_path / "jd.txt"
    jd_file.write_text("  Real pasted JD body  \n", encoding="utf-8")

    seen = {}

    def fake_build(job, user, *, out_dir, root, use_llm=True,
                   allow_scrape=True, client=None, jd_text=None):
        seen["jd_text"] = jd_text
        return BuildResult(out_path=Path("out") / "r.docx", report="",
                           pages=1.0, used_llm=False)

    monkeypatch.setattr(ondemand, "build_for_job", fake_build)

    rc = ondemand.main(["--user", "example", "--short", short,
                        "--jd", str(jd_file)])
    assert rc == 0
    assert seen["jd_text"] == "Real pasted JD body"  # stripped, used verbatim


def test_empty_jd_file_falls_back_to_acquisition(monkeypatch, tmp_path):
    key = "url:https://x.test/2"
    short = dashboard.short_key(key)
    state = _state_with_match(key)
    monkeypatch.setattr(ondemand.st, "load_state", lambda _p: state)

    jd_file = tmp_path / "jd.txt"
    jd_file.write_text("   \n", encoding="utf-8")  # whitespace only => no paste

    seen = {}

    def fake_build(job, user, *, jd_text=None, **kw):
        seen["jd_text"] = jd_text
        return BuildResult(out_path=Path("out") / "r.docx", report="",
                           pages=1.0, used_llm=False)

    monkeypatch.setattr(ondemand, "build_for_job", fake_build)

    rc = ondemand.main(["--user", "example", "--short", short,
                        "--jd", str(jd_file)])
    assert rc == 0
    assert seen["jd_text"] is None  # empty paste => acquisition path


def test_unknown_short_key_exits_nonzero(monkeypatch, capsys):
    key = "jr:" + "a" * 24
    state = _state_with_match(key)
    monkeypatch.setattr(ondemand.st, "load_state", lambda _p: state)
    # build_for_job must never be reached for an unknown key.
    monkeypatch.setattr(ondemand, "build_for_job",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("should not build")))

    rc = ondemand.main(["--user", "example", "--short", "0" * 12])
    assert rc == 1
    assert "no match" in capsys.readouterr().err


def test_no_jd_exits_nonzero(monkeypatch, capsys):
    key = "jr:" + "c" * 24
    short = dashboard.short_key(key)
    state = _state_with_match(key)
    monkeypatch.setattr(ondemand.st, "load_state", lambda _p: state)
    monkeypatch.setattr(ondemand, "build_for_job", lambda *a, **k: None)

    rc = ondemand.main(["--user", "example", "--short", short])
    assert rc == 1
    assert "no JD found" in capsys.readouterr().err


def test_ondemand_workflow_yaml_parses():
    wf = ROOT / ".github" / "workflows" / "resume-ondemand.yml"
    data = yaml.safe_load(wf.read_text(encoding="utf-8"))
    # `on:` parses to True under YAML 1.1; assert via the truthy key instead.
    assert any(str(k) in ("on", "True") for k in data)
    assert data["permissions"] == {"issues": "write", "contents": "write",
                                   "actions": "read"}
    assert "build" in data["jobs"]
    assert "issue_comment" in str(data)
    # Delivers a release asset (.docx), not a zipped artifact.
    assert "release upload resumes" in str(data)
    assert "upload-artifact" not in str(data)