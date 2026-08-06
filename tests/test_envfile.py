"""Tests for the shared src.envfile loader used by local entrypoints."""
from __future__ import annotations

import os

from src.apply.profile import load_dotenv as profile_load_dotenv
from src.envfile import load_dotenv


def test_loads_key_value_from_dotenv(tmp_path, monkeypatch) -> None:
    env = tmp_path / ".env"
    env.write_text('STORE=convex\nCONVEX_SECRET = "s3cr3t"\n', encoding="utf-8")
    monkeypatch.delenv("STORE", raising=False)
    monkeypatch.delenv("CONVEX_SECRET", raising=False)

    load_dotenv(env)

    assert os.environ["STORE"] == "convex"
    # surrounding whitespace and quotes are stripped
    assert os.environ["CONVEX_SECRET"] == "s3cr3t"


def test_ignores_comments_and_blank_lines(tmp_path, monkeypatch) -> None:
    env = tmp_path / ".env"
    env.write_text("\n# a comment\n\nGEMINI_API_KEY=abc\n", encoding="utf-8")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)

    load_dotenv(env)

    assert os.environ["GEMINI_API_KEY"] == "abc"


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
    monkeypatch.delenv("STORE", raising=False)

    load_dotenv()

    assert os.environ["STORE"] == "convex"


def test_apply_profile_reexports_load_dotenv() -> None:
    # existing callers do `from .profile import load_dotenv`; keep that working
    assert profile_load_dotenv is load_dotenv