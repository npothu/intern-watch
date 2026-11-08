import json

from scripts.rename_state_user import main


def _write(tmp_path, seen, apps):
    (tmp_path / "state").mkdir()
    (tmp_path / "state" / "seen.json").write_text(json.dumps(seen))
    (tmp_path / "state" / "applications.json").write_text(json.dumps(apps))


def _read(tmp_path):
    return (json.loads((tmp_path / "state" / "seen.json").read_text()),
            json.loads((tmp_path / "state" / "applications.json").read_text()))


def _seen(*users):
    return {
        "_meta": {"dashboard_issue": {u: i for i, u in enumerate(users, 1)},
                  "crossdedup_done": list(users)},
        "matches": {u: {} for u in users}, "content": {u: {} for u in users},
        "outbox": {u: [] for u in users}, "last_email": {u: "t" for u in users},
        "companies": {"acme": {"top": {u: True for u in users}}},
        "jobs": {"k1": {"notified_for": list(users), "llm_top": {u: 1 for u in users}}},
    }


def test_renames_every_user_keyed_place(tmp_path):
    _write(tmp_path, _seen("example"), {"example": {"aaaaaaaaaaaa": {}}})
    assert main(["--data-dir", str(tmp_path), "--from", "example", "--to", "nathan", "--write"]) == 0
    seen, apps = _read(tmp_path)
    assert "example" not in json.dumps([seen, apps])
    assert apps == {"nathan": {"aaaaaaaaaaaa": {}}}
    assert seen["_meta"]["dashboard_issue"] == {"nathan": 1}
    assert seen["jobs"]["k1"]["notified_for"] == ["nathan"]
    assert seen["companies"]["acme"]["top"] == {"nathan": True}


def test_dry_run_writes_nothing(tmp_path):
    _write(tmp_path, _seen("example"), {"example": {}})
    before = _read(tmp_path)
    assert main(["--data-dir", str(tmp_path), "--from", "example", "--to", "nathan"]) == 0
    assert _read(tmp_path) == before


def test_refuses_when_target_exists_then_works_after_moving_it_aside(tmp_path):
    _write(tmp_path, _seen("example", "nathan"), {"example": {"a": {}}, "nathan": {"b": {}}})
    assert main(["--data-dir", str(tmp_path), "--from", "example", "--to", "nathan", "--write"]) == 2
    assert main(["--data-dir", str(tmp_path), "--from", "nathan", "--to", "nathan_legacy", "--write"]) == 0
    assert main(["--data-dir", str(tmp_path), "--from", "example", "--to", "nathan", "--write"]) == 0
    seen, apps = _read(tmp_path)
    assert apps == {"nathan": {"a": {}}, "nathan_legacy": {"b": {}}}
    assert seen["jobs"]["k1"]["notified_for"] == ["nathan", "nathan_legacy"]
