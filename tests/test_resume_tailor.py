"""LLM tailoring: guardrails and graceful fallback (provider is mocked)."""

import json

from src.resume import jd, select, tailor
from src.resume.bank import load_bank

BANK = load_bank("tests/fixtures/resume_bank.json")
CFG = {"provider": "anthropic", "model": "m", "api_key_env": "FAKE_KEY"}


def _plan(fixtures):
    profile = jd.analyze(
        (fixtures / "jd_ml_intern.txt").read_text(encoding="utf-8"))
    return select.build_plan(BANK, profile), profile


def _mock_provider(monkeypatch, responder):
    monkeypatch.setenv("FAKE_KEY", "k")
    monkeypatch.setitem(tailor._PROVIDERS, "anthropic",
                        lambda model, system, user, key: responder(user))


def test_valid_rewrites_applied(fixtures, monkeypatch):
    plan, _ = _plan(fixtures)
    target = plan.projects[0]

    def responder(user_msg):
        return json.dumps([{
            "name": target.name,
            "bullets": [f"Rewritten: {b[:80]}" for b in target.bullets],
        }])

    _mock_provider(monkeypatch, responder)
    tailor.tailor(plan, "some jd", CFG)
    assert all(b.startswith("Rewritten:") for b in target.bullets)
    assert target.llm_rewritten


def test_over_length_rewrite_keeps_original(fixtures, monkeypatch):
    plan, _ = _plan(fixtures)
    target = plan.projects[0]
    original = list(target.bullets)

    def responder(user_msg):
        return json.dumps([{
            "name": target.name,
            "bullets": ["X" * 2000] + original[1:],
        }])

    _mock_provider(monkeypatch, responder)
    tailor.tailor(plan, "some jd", CFG)
    assert target.bullets[0] == original[0]
    assert any("over-length" in n for n in plan.notes)


def test_wrong_bullet_count_rejected(fixtures, monkeypatch):
    plan, _ = _plan(fixtures)
    target = plan.projects[0]
    original = list(target.bullets)
    _mock_provider(monkeypatch, lambda u: json.dumps(
        [{"name": target.name, "bullets": ["just one"]}]))
    tailor.tailor(plan, "some jd", CFG)
    assert target.bullets == original
    assert any("bad rewrite shape" in n for n in plan.notes)


def test_unknown_project_ignored(fixtures, monkeypatch):
    plan, _ = _plan(fixtures)
    before = [list(p.bullets) for p in plan.projects]
    _mock_provider(monkeypatch, lambda u: json.dumps(
        [{"name": "Totally Invented Project", "bullets": ["fake"]}]))
    tailor.tailor(plan, "some jd", CFG)
    assert [list(p.bullets) for p in plan.projects] == before


def test_garbage_response_falls_back(fixtures, monkeypatch):
    plan, _ = _plan(fixtures)
    before = [list(p.bullets) for p in plan.projects]
    _mock_provider(monkeypatch, lambda u: "I'm sorry, I can't do that.")
    tailor.tailor(plan, "some jd", CFG)
    assert [list(p.bullets) for p in plan.projects] == before
    assert any("call failed" in n for n in plan.notes)


def test_missing_api_key_skips(fixtures, monkeypatch):
    plan, _ = _plan(fixtures)
    monkeypatch.delenv("NOT_SET_KEY", raising=False)
    before = [list(p.bullets) for p in plan.projects]
    tailor.tailor(plan, "some jd",
                  {"provider": "anthropic", "api_key_env": "NOT_SET_KEY"})
    assert [list(p.bullets) for p in plan.projects] == before
    assert any("NOT_SET_KEY not set" in n for n in plan.notes)


def test_prompt_carries_caps_and_jd(fixtures, monkeypatch):
    plan, _ = _plan(fixtures)
    seen = {}

    def responder(user_msg):
        seen["msg"] = user_msg
        return "[]"

    _mock_provider(monkeypatch, responder)
    tailor.tailor(plan, "UNIQUE_JD_MARKER", CFG)
    assert "UNIQUE_JD_MARKER" in seen["msg"]
    assert "max_chars" in seen["msg"]
    assert any("no rewrite returned" in n for n in plan.notes)
