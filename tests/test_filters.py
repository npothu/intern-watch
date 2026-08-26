"""Rule engine tested against the real users/example.yaml + data lists."""

import copy
import datetime as dt
from datetime import date, timedelta
from pathlib import Path

import pytest
import yaml

from src.filters import UserFilter, in_atlanta_metro
from src.models import Job

FIXTURE_DATE = dt.date(2026, 6, 11)
ROOT = Path(__file__).parent.parent


@pytest.fixture
def uf() -> UserFilter:
    cfg = yaml.safe_load((ROOT / "users" / "example.yaml").read_text(encoding="utf-8"))
    return UserFilter(cfg, ROOT, today=FIXTURE_DATE)


def _job(**kw):
    base = {"company": "SomeCo", "title": "Software Engineer Intern",
            "url": "https://x.com/1", "source": "jobright-swe"}
    base.update(kw)
    return Job(**base)


def test_top_company_fall_accepted(uf):
    v = uf.evaluate(_job(company="Stripe", terms=["Fall 2026"],
                         locations=["New York, NY"]))
    assert v.status == "accept"
    assert any(r.startswith("company:top_companies") for r in v.reasons)


def test_alias_matches(uf):
    v = uf.evaluate(_job(company="AWS", terms=["Spring 2027"], locations=["Seattle, WA"]))
    assert v.status == "accept"


def test_atlanta_location_fall_accepted(uf):
    v = uf.evaluate(_job(company="Tiny Startup", terms=["Fall 2026"],
                         locations=["Alpharetta, GA"]))
    assert v.status == "accept"


def test_atlanta_company_file_accepted(uf):
    v = uf.evaluate(_job(company="Calendly", terms=["Fall 2026"], locations=["Hybrid"]))
    assert v.status == "accept"
    assert any(r.startswith("company:atlanta_companies") for r in v.reasons)


def test_remote_fall_accepted(uf):
    v = uf.evaluate(_job(company="Tiny Startup", terms=["Fall 2026"],
                         locations=["United States"], work_model="Remote"))
    assert v.status == "accept"
    assert "location:remote" in v.reasons


def test_summer_2027_always_accepted(uf):
    v = uf.evaluate(_job(company="Totally Unknown LLC", terms=["Summer 2027"],
                         locations=["Boise, ID"]))
    assert v.status == "accept"


def test_nontop_nonatl_fall_is_ambiguous(uf):
    v = uf.evaluate(_job(company="Mystery Corp", terms=["Fall 2026"],
                         locations=["Denver, CO"]))
    assert v.status == "ambiguous"
    assert set(v.needs) == {"top_company", "atlanta_metro"}


def test_llm_facts_flip_to_accept(uf):
    job = _job(company="Mystery Corp", terms=["Fall 2026"], locations=["Denver, CO"])
    v = uf.evaluate(job, llm_facts={"is_top_company": True, "in_atlanta_metro": False})
    assert v.status == "accept"
    assert "company:top_companies (LLM)" in v.reasons


def test_llm_facts_negative_rejects(uf):
    job = _job(company="Mystery Corp", terms=["Fall 2026"], locations=["Denver, CO"])
    v = uf.evaluate(job, llm_facts={"is_top_company": False, "in_atlanta_metro": False})
    assert v.status == "reject"


def test_unknown_term_goes_to_llm(uf):
    v = uf.evaluate(_job(company="Stripe", terms=[]))
    assert v.status == "ambiguous"
    assert "term" in v.needs


def test_unknown_term_unresolved_top_company_accepted(uf):
    # Term unknown even to the LLM, but the job qualifies under EVERY wanted
    # term (top company) -- wanted whatever its term turns out to be.
    job = _job(company="Stripe", terms=[], locations=["San Jose, CA"])
    v = uf.evaluate(job, llm_facts={"term": None})
    assert v.status == "accept"
    assert "term-unknown" in v.reasons


def test_unknown_term_unresolved_nonqualifying_rejected(uf):
    # Unresolved term + would only be accepted under the Summer-2027
    # accept-always rule -> rejected (might be a Fall/Spring job that fails
    # the top/Atlanta/remote gate).
    job = _job(company="Mystery Corp", terms=[], locations=["Denver, CO"])
    v = uf.evaluate(job, llm_facts={"term": None, "is_top_company": False,
                                    "in_atlanta_metro": False})
    assert v.status == "reject"
    assert "term-unresolved" in v.reasons


def test_wrong_term_rejected(uf):
    v = uf.evaluate(_job(company="Stripe", terms=["Summer 2026"]))
    assert v.status == "reject"
    assert "term-not-wanted" in v.reasons


def test_role_keywords(uf):
    assert uf.evaluate(_job(title="Mechanical Engineer Intern - Fall 2026",
                            terms=["Fall 2026"])).status == "reject"
    assert uf.evaluate(_job(title="Registered Nurse Intern",
                            terms=["Summer 2027"])).status == "reject"
    assert uf.evaluate(_job(company="Stripe", title="Product Management Intern Fall 2026",
                            terms=["Fall 2026"])).status == "accept"


def _stale_uf(max_age_days: int) -> UserFilter:
    cfg = yaml.safe_load((ROOT / "users" / "example.yaml").read_text(encoding="utf-8"))
    cfg = copy.deepcopy(cfg)
    cfg["eliminate"]["max_age_days"] = max_age_days
    return UserFilter(cfg, ROOT, today=FIXTURE_DATE)


def test_max_age_days_unset_no_change(uf):
    # The real config leaves max_age_days commented out -> off; an old posting
    # is treated exactly as a fresh one (here: a Summer-2027 accept-always job).
    today = date(2026, 6, 18)
    old = _job(company="Totally Unknown LLC", terms=["Summer 2027"],
               locations=["Boise, ID"], date_posted=today - timedelta(days=400))
    assert uf.evaluate(old, today=today).status == "accept"


def test_max_age_days_keeps_fresh_posting():
    uf = _stale_uf(30)
    today = date(2026, 6, 18)
    fresh = _job(company="Totally Unknown LLC", terms=["Summer 2027"],
                 locations=["Boise, ID"], date_posted=today - timedelta(days=5))
    assert uf.evaluate(fresh, today=today).status == "accept"


def test_max_age_days_eliminates_old_posting():
    uf = _stale_uf(30)
    today = date(2026, 6, 18)
    old = _job(company="Stripe", terms=["Summer 2027"], locations=["Boise, ID"],
               date_posted=today - timedelta(days=45))
    v = uf.evaluate(old, today=today)
    assert v.status == "reject"
    assert "eliminated:stale" in v.reasons


def test_max_age_days_keeps_unknown_date():
    # date_posted None -> conservative keep, never stale-eliminated.
    uf = _stale_uf(30)
    today = date(2026, 6, 18)
    job = _job(company="Totally Unknown LLC", terms=["Summer 2027"],
               locations=["Boise, ID"], date_posted=None)
    assert uf.evaluate(job, today=today).status == "accept"


@pytest.mark.parametrize("company", ["Dice", "dice", "Dice Inc"])
def test_aggregator_board_company_rejected(uf, company):
    v = uf.evaluate(_job(company=company, terms=["Summer 2027"], locations=["Boise, ID"]))
    assert v.status == "reject"
    assert "eliminated:aggregator-board" in v.reasons


def test_non_aggregator_company_not_rejected(uf):
    v = uf.evaluate(_job(company="Palantir Technologies", terms=["Summer 2027"],
                         locations=["Boise, ID"]))
    assert v.status == "accept"
    assert "eliminated:aggregator-board" not in v.reasons


@pytest.mark.parametrize("loc,expected", [
    ("Atlanta, GA", True),
    ("Alpharetta, GA", True),
    ("Sandy Springs", True),
    ("Marietta, Georgia", True),
    ("Decatur, GA", True),
    ("Decatur, IL", False),
    ("Roswell, GA", True),
    ("Roswell, NM", False),
    # outside the ~35-mile metro
    ("Athens, GA", False),
    ("Macon, GA", False),
    ("Chattanooga, TN", False),
    ("Duluth, MN", False),
    ("College Park, MD", False),
    ("New York, NY", False),
    ("Remote", False),
])
def test_in_atlanta_metro(loc, expected):
    assert in_atlanta_metro(loc) is expected


def test_load_users_skips_auto_apply_configs(tmp_path):
    """Apply answer-books / login yamls carry a `name:` too -- without the
    watcher-config filter they mint a phantom watcher user (seen live after
    PR #16 merged: 'user Alex J. Example: no new matches' every run)."""
    from src.filters import load_users

    (tmp_path / "example.yaml").write_text(
        "name: example\ninclude_keywords: [intern]\n", encoding="utf-8")
    for bad in ("me_apply.yaml", "me_apply.example.yaml",
                "me_logins.yaml", "me_logins.example.yaml"):
        (tmp_path / bad).write_text("name: Real Name\nemail: x@y.z\n",
                                    encoding="utf-8")
    assert [u["name"] for u in load_users(tmp_path)] == ["example"]
