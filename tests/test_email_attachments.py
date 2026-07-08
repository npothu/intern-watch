"""Phase 4 email mode: .docx resume attachments on the digest email."""

import datetime as dt
from pathlib import Path

from src import main
from src import state as st
from src.notify import build_message

NOW = dt.datetime(2026, 6, 11, 18, 0, tzinfo=dt.timezone.utc)
DOCX = ("application/vnd.openxmlformats-officedocument."
        "wordprocessingml.document")


def _docx(path: Path) -> Path:
    path.write_bytes(b"PK\x03\x04 fake docx")
    return path


def test_build_message_attaches_docx_parts(tmp_path: Path):
    a = _docx(tmp_path / "First_Last_Acme.docx")
    b = _docx(tmp_path / "First_Last_Beta.docx")
    msg = build_message("u@example.com", "to@example.com", "subj",
                        "<p>hi</p>", "hi", attachments=[a, b])
    parts = [p for p in msg.iter_attachments()]
    assert len(parts) == 2
    assert {p.get_filename() for p in parts} == {a.name, b.name}
    for p in parts:
        assert p.get_content_type() == DOCX


def test_build_message_skips_missing_files(tmp_path: Path):
    present = _docx(tmp_path / "First_Last_Acme.docx")
    missing = tmp_path / "gone.docx"
    msg = build_message("u@example.com", "to@example.com", "subj",
                        "<p>hi</p>", "hi", attachments=[present, missing])
    parts = list(msg.iter_attachments())
    assert len(parts) == 1
    assert parts[0].get_filename() == present.name


def test_build_message_no_attachments_arg():
    msg = build_message("u@example.com", "to@example.com", "subj",
                        "<p>hi</p>", "hi")
    assert list(msg.iter_attachments()) == []


def _email_cfg(monkeypatch):
    monkeypatch.setenv("SMTP_U", "u@example.com")
    monkeypatch.setenv("SMTP_P", "pass")
    return {"name": "example",
            "notify": {"email": {"smtp_user_env": "SMTP_U",
                                 "smtp_pass_env": "SMTP_P",
                                 "send_at_utc": [0, 12, 18]}}}


def _outbox_item(key: str, resume: str | None = None) -> dict:
    item = {"key": key, "company": "Acme", "title": "SWE Intern",
            "location": "Atlanta, GA", "salary": None,
            "url": "https://x.com", "tag": "", "term": "Fall 2026"}
    if resume is not None:
        item["resume"] = resume
    return item


def test_notify_email_passes_only_existing_resumes(monkeypatch, tmp_path):
    captured = {}
    monkeypatch.setattr(main, "send_email",
                        lambda *a, **kw: captured.update(kw) or True)
    # Point ROOT at a temp tree so the relative paths resolve there.
    monkeypatch.setattr(main, "ROOT", tmp_path)
    resumes = tmp_path / "resumes" / "example"
    resumes.mkdir(parents=True)
    _docx(resumes / "First_Last_Acme.docx")

    cfg = _email_cfg(monkeypatch)
    state = st.empty_state()
    # one item with an existing resume, one with a stale/missing path,
    # one with no resume key at all -> only the existing file is attached.
    st.outbox_add(state, "example",
                  _outbox_item("k1", "resumes/example/First_Last_Acme.docx"))
    st.outbox_add(state, "example",
                  _outbox_item("k2", "resumes/example/gone.docx"))
    st.outbox_add(state, "example", _outbox_item("k3"))

    main._notify_email(cfg, [], state, False, NOW, ["Fall 2026"], False)

    attached = captured.get("attachments")
    assert attached is not None
    assert [p.name for p in attached] == ["First_Last_Acme.docx"]
    assert all(isinstance(p, Path) for p in attached)