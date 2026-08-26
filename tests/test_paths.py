"""Code-checkout and instance-data path ownership tests."""

from pathlib import Path
from shutil import copy2

import pytest

from src import main, paths
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


def test_data_root_falls_back_to_the_code_checkout_dotenv(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("INTERN_WATCH_DATA_DIR", raising=False)
    fake_root = tmp_path / "code"
    fake_root.mkdir()
    data = tmp_path / "data"
    (fake_root / ".env").write_text(
        f"GEMINI_API_KEY=x\nINTERN_WATCH_DATA_DIR=\"{data}\"\n", encoding="utf-8")
    monkeypatch.setattr(paths, "ROOT", fake_root)

    assert data_root() == data.resolve()

    monkeypatch.setenv("INTERN_WATCH_DATA_DIR", str(tmp_path / "env-wins"))
    assert data_root() == (tmp_path / "env-wins").resolve()
