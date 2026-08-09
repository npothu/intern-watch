"""Tests for the shared src.envfile loader used by local entrypoints."""
from __future__ import annotations

import os

from src.apply.profile import load_dotenv as profile_load_dotenv
from src.envfile import load_dotenv


def _clear(monkeypatch, key):
    """Force `key` absent for the body, like monkeypatch.delenv, but record
    the previous value so teardown restores it -- delenv does not undo a
    `setdefault` made after the deletion, which leaked STORE/CONVEX_* into
    every later seam-touching test (the watcher's resume build reads STORE).
    """
    old = os.environ.get(key, _MISSING)
    monkeypatch.delenv(key, raising=False)
    return old


_MISSING = object()


def _restore(key, old):
    if old is _MISSING:
        os.environ.pop(key, None)
    else:
        os.environ[key] = old


def test_loads_key_value_from_dotenv(tmp_path, monkeypatch) -> None:
    env = tmp_path / ".env"
    env.write_text('STORE=convex\nCONVEX_SECRET = "s3cr3t"\n', encoding="utf-8")
    store_old = _clear(monkeypatch, "STORE")
    secret_old = _clear(monkeypatch, "CONVEX_SECRET")

    try:
        load_dotenv(env)

        assert os.environ["STORE"] == "convex"
        # surrounding whitespace and quotes are stripped
        assert os.environ["CONVEX_SECRET"] == "s3cr3t"
    finally:
        _restore("STORE", store_old)
        _restore("CONVEX_SECRET", secret_old)


def test_ignores_comments_and_blank_lines(tmp_path, monkeypatch) -> None:
    env = tmp_path / ".env"
    env.write_text("\n# a comment\n\nGEMINI_API_KEY=abc\n", encoding="utf-8")
    gem_old = _clear(monkeypatch, "GEMINI_API_KEY")

    try:
        load_dotenv(env)

        assert os.environ["GEMINI_API_KEY"] == "abc"
    finally:
        _restore("GEMINI_API_KEY", gem_old)


def test_does_not_override_existing_env(tmp_path, monkeypatch) -> None:
    env = tmp_path / ".env"
    env.write_text("GEMINI_API_KEY=from.file\n", encoding="utf-8")
    monkeypatch.setenv("GEMINI_API_KEY", "from.env")

    load_dotenv(env)

    # the exported env var wins over the .env value
    assert os.environ["GEMINI_API_KEY"] == "from.env"


def test_missing_file_is_noop(tmp_path) -> None:
    load_dotenv(tmp_path / "nope.env")  # must not raise


def test_default_root_is_repo_dotenv(tmp_path, monkeypatch) -> None:
    # the no-arg call resolves parents[1] of the module file == <repo>/src/../.env
    import src.envfile as envfile

    fake = tmp_path / "src" / "envfile.py"
    fake.parent.mkdir(parents=True, exist_ok=True)
    fake.touch()
    monkeypatch.setattr(envfile, "__file__", str(fake))
    (tmp_path / ".env").write_text("STORE=convex\n", encoding="utf-8")
    store_old = _clear(monkeypatch, "STORE")

    try:
        load_dotenv()

        assert os.environ["STORE"] == "convex"
    finally:
        _restore("STORE", store_old)


def test_apply_profile_reexports_load_dotenv() -> None:
    # existing callers do `from .profile import load_dotenv`; keep that working
    assert profile_load_dotenv is load_dotenv
