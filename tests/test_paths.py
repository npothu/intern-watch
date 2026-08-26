"""Code-checkout and instance-data path ownership tests."""

from pathlib import Path
from shutil import copy2

import pytest

from src import main
from src.filters import load_users
from src.paths import ROOT, data_root


@pytest.mark.parametrize("value", [None, "", "   "])
def test_data_root_defaults_to_code_checkout(monkeypatch, value) -> None:
    if value is None:
        monkeypatch.delenv("INTERN_WATCH_DATA_DIR", raising=False)
    else:
        monkeypatch.setenv("INTERN_WATCH_DATA_DIR", value)

    assert data_root() == ROOT


def test_data_root_resolves_environment_path(monkeypatch, tmp_path: Path) -> None:
    raw = tmp_path / "instance" / ".." / "data"
    monkeypatch.setenv("INTERN_WATCH_DATA_DIR", str(raw))

    assert data_root() == raw.resolve()


def test_main_loads_users_from_data_root_and_sources_from_code_root(
        monkeypatch, tmp_path: Path) -> None:
    users_dir = tmp_path / "users"
    users_dir.mkdir()
    copy2(ROOT / "users" / "example.yaml", users_dir / "example.yaml")
    monkeypatch.setattr(main, "DATA_ROOT", tmp_path)

    users = load_users(main.DATA_ROOT / "users")
    sources = main.load_sources(main.ROOT / "sources.yaml")

    assert [user["name"] for user in users] == ["example"]
    assert sources
    assert not (tmp_path / "sources.yaml").exists()
