"""Batch resume build from the dashboard 'Build selected resumes' trigger."""

import datetime as dt

import yaml

from src import dashboard as db, state as st
from src.resume import batch
from src.resume.build import BuildResult

TERMS = ["Fall 2026", "Summer 2027"]
NOW = dt.datetime(2026, 6, 12, 12, 0, tzinfo=dt.timezone.utc)


def _item(i, **kw):
    d = {"key": f"url:https://x.com/{i}", "company": f"Co{i}",
         "title": f"SWE Intern {i}", "location": "Atlanta, GA", "salary": None,
         "url": f"https://x.com/{i}", "tag": "", "term": "Fall 2026",
         "added": "2026-06-12", "applied": False}
    d.update(kw)
    return d


def _ticked_body(matches, build_shorts, *, trigger=True):
    """A dashboard body with the trigger and the given rows' build boxes ticked."""
    body = db.build_body(matches, TERMS, NOW)
    out = []
    for ln in body.splitlines():
        if trigger and "iw:build" in ln:
            ln = ln.replace("- [ ]", "- [x]", 1)
        if any(f"iwb:{s}" in ln for s in build_shorts):
            ln = ln.replace("- [ ]", "- [x]", 1)
        out.append(ln)
    return "\n".join(out)


# ---- pure parsing -------------------------------------------------------

def test_trigger_and_selection_parsing():
    matches = [_item(1), _item(2)]
    s1 = db.short_key(matches[0]["key"])
    body = _ticked_body(matches, {s1})
    assert db.build_trigger_checked(body) is True
    assert db.parse_build_selections(body) == {s1}
    # the applied checkboxes are untouched by build boxes
    assert db.parse_checkboxes(body)[0] == set()


def test_trigger_unchecked_by_default():
    body = db.build_body([_item(1)], TERMS, NOW)
    assert db.build_trigger_checked(body) is False
    assert db.parse_build_selections(body) == set()


def test_built_row_renders_checked_build_box():
    row = db._row(_item(1, resume="resumes/example/Co1.docx"), "owner/repo")
    assert "- [x] 📄 resume built" in row
    assert "[📄 resume](/owner/repo/blob/main/resumes/example/Co1.docx)" in row


# ---- selection filtering ------------------------------------------------

def test_selected_unbuilt_skips_already_built():
    state = st.empty_state()
    st.matches_add(state, "example", _item(1))
    st.matches_add(state, "example", _item(2, resume="resumes/example/Co2.docx"))
    s1 = db.short_key("url:https://x.com/1")
    s2 = db.short_key("url:https://x.com/2")
    body = _ticked_body(st.matches_items(state, "example"), {s1, s2})
    todo = batch._selected_unbuilt(state, "example", body)
    assert [short for _, short in todo] == [s1]   # Co2 already built -> skipped


# ---- full CLI run -------------------------------------------------------

def _setup_root(tmp_path, matches):
    (tmp_path / "users").mkdir()
    (tmp_path / "users" / "example.yaml").write_text(
        yaml.safe_dump({"name": "example", "terms_wanted": TERMS}),
        encoding="utf-8")
    (tmp_path / "state").mkdir()
    state = st.empty_state()
    for m in matches:
        st.matches_add(state, "example", m)
    st.save_state(state, tmp_path / "state" / "seen.json")
    return tmp_path / "state" / "seen.json"


def test_main_builds_selected_and_records_paths(tmp_path, monkeypatch):
    matches = [_item(1), _item(2), _item(3)]
    state_path = _setup_root(tmp_path, matches)
    s1 = db.short_key(matches[0]["key"])
    s3 = db.short_key(matches[2]["key"])
    body = _ticked_body(matches, {s1, s3})
    body_file = tmp_path / "body.md"
    body_file.write_text(body, encoding="utf-8")

    def fake_build(job, user, *, out_dir, root, **kw):
        out = out_dir / f"{job.company}.docx"
        out.write_text("docx", encoding="utf-8")
        return BuildResult(out_path=out, report="", pages=1.0, used_llm=False)

    monkeypatch.setattr(batch, "build_for_job", fake_build)
    summary = tmp_path / "comment.md"
    rc = batch.main(["--user", "example", "--root", str(tmp_path),
                     "--body", str(body_file), "--summary", str(summary)])
    assert rc == 0

    state = st.load_state(state_path)
    by_key = {i["key"]: i for i in st.matches_items(state, "example")}
    # the store keys the .docx by (user, short, filename); the fake build
    # writes <company>.docx, so GitHubStore places it at resumes/example/<short>/Co1.docx
    assert by_key[matches[0]["key"]]["resume"] == \
        f"resumes/example/{s1}/Co1.docx"
    assert by_key[matches[2]["key"]]["resume"] == \
        f"resumes/example/{s3}/Co3.docx"
    assert "resume" not in by_key[matches[1]["key"]]   # not selected
    assert "Built 2 resume(s)" in summary.read_text(encoding="utf-8")


def test_main_noop_when_trigger_unticked(tmp_path, monkeypatch):
    matches = [_item(1)]
    _setup_root(tmp_path, matches)
    s1 = db.short_key(matches[0]["key"])
    body = _ticked_body(matches, {s1}, trigger=False)   # rows ticked, trigger not
    body_file = tmp_path / "body.md"
    body_file.write_text(body, encoding="utf-8")

    called = []
    monkeypatch.setattr(batch, "build_for_job",
                        lambda *a, **k: called.append(1))
    rc = batch.main(["--user", "example", "--root", str(tmp_path),
                     "--body", str(body_file)])
    assert rc == 0 and not called   # trigger gates the whole run


def test_main_reports_jd_miss(tmp_path, monkeypatch):
    matches = [_item(1)]
    _setup_root(tmp_path, matches)
    s1 = db.short_key(matches[0]["key"])
    body_file = tmp_path / "body.md"
    body_file.write_text(_ticked_body(matches, {s1}), encoding="utf-8")

    monkeypatch.setattr(batch, "build_for_job", lambda *a, **k: None)  # no JD
    summary = tmp_path / "comment.md"
    rc = batch.main(["--user", "example", "--root", str(tmp_path),
                     "--body", str(body_file), "--summary", str(summary)])
    assert rc == 0
    assert "couldn't build" in summary.read_text(encoding="utf-8")