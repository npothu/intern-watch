"""config_check schema + secret-wiring validator: hermetic fixtures only."""

from __future__ import annotations

from pathlib import Path

import yaml

from src import config_check as cc

ROOT = Path(__file__).resolve().parents[1]


# ---- hermetic fixture builders ----------------------------------------

def _valid_user() -> dict:
    return {
        "name": "tester",
        "notify": {
            "email": {
                "smtp_user_env": "GMAIL_ADDRESS",
                "smtp_pass_env": "GMAIL_APP_PASSWORD",
            },
        },
        "unknown_term_policy": "llm",
        "rules": [
            {"when": {"term": ["Fall 2026"]},
             "accept_if_any": [{"company_in_file": "data/top_companies.txt"}]},
        ],
        "llm": {"provider": "gemini", "api_key_env": "GEMINI_API_KEY"},
        "resume_build": {"enabled": True, "modes": ["commit", "email"]},
    }


def _write_watch(path: Path, env_names: list[str]) -> None:
    env_block = "\n".join(
        f"          {n}: ${{{{ secrets.{n} }}}}" for n in env_names)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "name: watch\n"
        "jobs:\n"
        "  watch:\n"
        "    runs-on: ubuntu-latest\n"
        "    steps:\n"
        "      - run: python -m src.main\n"
        "        env:\n"
        f"{env_block}\n",
        encoding="utf-8",
    )


def _make_repo(tmp_path: Path, user: dict, *,
               wired: list[str] | None = None,
               make_data: bool = True) -> Path:
    """Build a fake repo (users/ + data/ + watch.yml) and return its root."""
    root = tmp_path
    (root / "users").mkdir(parents=True, exist_ok=True)
    (root / "users" / "tester.yaml").write_text(
        yaml.safe_dump(user), encoding="utf-8")
    if make_data:
        (root / "data").mkdir(parents=True, exist_ok=True)
        (root / "data" / "top_companies.txt").write_text("Acme\n",
                                                         encoding="utf-8")
    if wired is None:
        wired = ["GMAIL_ADDRESS", "GMAIL_APP_PASSWORD", "GEMINI_API_KEY"]
    _write_watch(root / ".github" / "workflows" / "watch.yml", wired)
    return root


def _run(root: Path):
    return cc.check_configs(
        root / "users", root / ".github" / "workflows" / "watch.yml",
        root=root)


# ---- the four required cases ------------------------------------------

def test_valid_config_passes(tmp_path):
    root = _make_repo(tmp_path, _valid_user())
    reports, ok = _run(root)
    assert ok, [r.render() for r in reports]
    assert reports[0].errors == []


def test_bad_enum_fails(tmp_path):
    user = _valid_user()
    user["llm"]["provider"] = "openai"          # not in {gemini, anthropic}
    user["unknown_term_policy"] = "guess"       # not in {llm, drop, keep}
    user["resume_build"]["modes"] = ["commit", "pdf"]  # pdf not allowed
    root = _make_repo(tmp_path, user)
    reports, ok = _run(root)
    assert not ok
    blob = reports[0].render()
    assert "llm.provider" in blob
    assert "unknown_term_policy" in blob
    assert "resume_build.modes" in blob


def test_missing_env_wiring_fails(tmp_path):
    user = _valid_user()
    # Wire everything EXCEPT GEMINI_API_KEY into watch.yml.
    root = _make_repo(tmp_path, user,
                      wired=["GMAIL_ADDRESS", "GMAIL_APP_PASSWORD"])
    reports, ok = _run(root)
    assert not ok
    blob = reports[0].render()
    assert "GEMINI_API_KEY" in blob
    # The fix-it line must be the exact wiring snippet.
    assert "GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}" in blob


def test_missing_data_file_fails(tmp_path):
    root = _make_repo(tmp_path, _valid_user(), make_data=False)
    reports, ok = _run(root)
    assert not ok
    assert "top_companies.txt" in reports[0].render()


# ---- a couple of targeted unit checks --------------------------------

def test_invalid_env_name_reported(tmp_path):
    user = _valid_user()
    user["notify"]["email"]["smtp_user_env"] = "gmail-address"  # bad identifier
    root = _make_repo(tmp_path, user)
    reports, ok = _run(root)
    assert not ok
    assert "valid env var name" in reports[0].render()


def test_unknown_top_level_key_warns_not_fails(tmp_path):
    user = _valid_user()
    user["typoo_key"] = 1
    root = _make_repo(tmp_path, user)
    reports, ok = _run(root)
    assert ok  # warning only
    assert any("typoo_key" in w for w in reports[0].warnings)


def test_discord_webhook_env_is_wiring_checked(tmp_path):
    user = _valid_user()
    user["notify"]["discord_webhook_env"] = "DISCORD_WEBHOOK_TESTER"
    root = _make_repo(tmp_path, user)  # not in wired list
    reports, ok = _run(root)
    assert not ok
    assert "DISCORD_WEBHOOK_TESTER: ${{ secrets.DISCORD_WEBHOOK_TESTER }}" \
        in reports[0].render()


def test_apply_subsystem_yaml_is_skipped(tmp_path):
    """users/*_apply.yaml and *_logins*.yaml belong to src/apply, not the
    watcher, so the validator must skip them (different schema, no `name`)."""
    root = _make_repo(tmp_path, _valid_user())
    (root / "users" / "someone_apply.yaml").write_text(
        yaml.safe_dump({"default": {"first_name": "A"}}), encoding="utf-8")
    (root / "users" / "someone_logins.example.yaml").write_text(
        yaml.safe_dump({"accounts": []}), encoding="utf-8")
    reports, ok = _run(root)
    assert ok, [r.render() for r in reports]
    assert {r.label for r in reports} == {"tester.yaml"}


def test_main_against_real_repo_passes():
    """The shipped users/example.yaml + watch.yml must validate clean."""
    assert cc.main([str(ROOT)]) == 0
