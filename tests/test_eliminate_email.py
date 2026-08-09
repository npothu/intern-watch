"""v2 features: elimination rules and the batched email channel."""

import datetime as dt
from pathlib import Path

import pytest
import yaml

from src import state as st
from src.filters import UserFilter, location_country
from src.models import Job
from src.notify import build_email, outbox_item

ROOT = Path(__file__).parent.parent
NOW = dt.datetime(2026, 6, 12, 12, 40, tzinfo=dt.UTC)
TERMS = ["Fall 2026", "Spring 2027", "Summer 2027"]


@pytest.fixture
def uf() -> UserFilter:
    cfg = yaml.safe_load((ROOT / "users" / "example.yaml").read_text(encoding="utf-8"))
    return UserFilter(cfg, ROOT)


def _job(**kw):
    base = {"company": "Stripe", "title": "Software Engineer Intern Fall 2026",
            "terms": ["Fall 2026"], "url": "https://x.com/1", "source": "s",
            "locations": ["New York, NY"]}
    base.update(kw)
    return Job(**base)


# ------------------------------------------------------------ eliminations

@pytest.mark.parametrize("loc,country", [
    ("San Francisco, CA", "us"),
    ("US, CA, Santa Clara", "us"),
    ("Remote (United States)", "us"),
    ("Atlanta, Georgia", "us"),
    ("Toronto, ON, Canada", "canada"),
    ("Montreal, Quebec", "canada"),
    ("London, United Kingdom", "other"),
    ("Bangalore, India", "other"),
    ("Warsaw, Poland", "other"),
    ("Remote", "unknown"),
    ("NYC", "unknown"),
])
def test_location_country(loc, country):
    assert location_country(loc) == country


def test_canada_eliminated(uf):
    # example.yaml is US-only (countries_allowed: ["United States"]), so a
    # confidently-Canadian location is dropped like any other non-US country.
    v = uf.evaluate(_job(locations=["Toronto, ON, Canada"]))
    assert v.status == "reject" and "eliminated:location-country" in v.reasons


def test_foreign_eliminated(uf):
    v = uf.evaluate(_job(locations=["London, United Kingdom"]))
    assert v.status == "reject" and "eliminated:location-country" in v.reasons


def test_mixed_us_foreign_kept(uf):
    assert uf.evaluate(_job(locations=["London, United Kingdom",
                                       "New York, NY"])).status == "accept"


def test_unknown_location_kept(uf):
    assert uf.evaluate(_job(locations=["Anywhere Plaza"])).status != "reject"


def test_unpaid_eliminated(uf):
    v = uf.evaluate(_job(title="Software Engineer Intern - Unpaid (Fall 2026)"))
    assert v.status == "reject" and "eliminated:unpaid" in v.reasons
    v = uf.evaluate(_job(salary="Unpaid"))
    assert v.status == "reject" and "eliminated:unpaid" in v.reasons


@pytest.mark.parametrize("title", [
    "Machine Learning Intern - Ph.D.",
    "Software Engineering Intern (MS/PhD)",
    "Avionics Software Internship - Graduate",
    "Data Science Intern - Master's Students",
    "Doctoral Software Intern - Computing Research Fall 2026",
])
def test_grad_only_titles_eliminated(uf, title):
    v = uf.evaluate(_job(title=title))
    assert v.status == "reject" and "eliminated:grad-only-title" in v.reasons


@pytest.mark.parametrize("title", [
    "Research Scientist Intern, Audio Quality with AI (PhD)",
    "Machine Learning Research Intern Fall 2026",
    "AI Researcher Intern",
    "Applied Scientist Intern Fall 2026",
    "Research Engineer Intern, Foundation Models",
])
def test_research_track_titles_excluded(uf, title):
    v = uf.evaluate(_job(title=title))
    assert v.status == "reject" and v.reasons[0].startswith("excluded-keyword:")


@pytest.mark.parametrize("title", [
    "Software Engineer Intern, Research Tools Fall 2026",
    "Software Engineer Intern - Search Fall 2026",
])
def test_research_adjacent_sw_titles_kept(uf, title):
    assert uf.evaluate(_job(title=title)).status == "accept"


@pytest.mark.parametrize("title", [
    "Software Engineer Intern (BS/MS) Fall 2026",
    "Avionics Software Internship - Undergraduate Fall 2026",
    "Software Engineer Intern Fall 2026",
])
def test_undergrad_titles_kept(uf, title):
    assert uf.evaluate(_job(title=title)).status == "accept"


def test_grad_only_degrees_field(uf):
    assert uf.evaluate(_job(degrees=["Master's", "PhD"])).status == "reject"
    assert uf.evaluate(_job(degrees=["Bachelor's"])).status == "accept"
    assert uf.evaluate(_job(degrees=["Bachelor's", "Master's"])).status == "accept"
    assert uf.evaluate(_job(degrees=[])).status == "accept"   # unknown -> kept


@pytest.mark.parametrize("title", [
    "Software Engineer Intern - TS/SCI with Polygraph",
    "Software Intern (Active Secret Clearance) Fall 2026",
    "Cleared Software Engineering Intern",
    "Embedded SWE Intern - Top Secret",
])
def test_active_clearance_eliminated(uf, title):
    v = uf.evaluate(_job(title=title))
    assert v.status == "reject" and "eliminated:active-clearance" in v.reasons


def test_clearance_obtainable_kept(uf):
    # plain "clearance" / ability-to-obtain wording stays -- user is a citizen
    assert uf.evaluate(_job(
        title="Software Intern Fall 2026 - must be able to obtain a security clearance"
    )).status == "accept"


@pytest.mark.parametrize("title", [
    "DoD SkillBridge Intern - Systems Administrator (Active Duty Service Member)",
    "Veteran Software Engineering Internship Program",
])
def test_veteran_only_eliminated(uf, title):
    assert uf.evaluate(_job(title=title)).status == "reject"


def test_elimination_beats_summer_always_rule(uf):
    v = uf.evaluate(_job(title="SWE Intern Summer 2027", terms=["Summer 2027"],
                         locations=["Berlin, Germany"]))
    assert v.status == "reject"


# ----------------------------------------------------------- email_due

SLOTS = [0, 12, 18]


def _due(last_iso, now):
    return st.email_due(last_iso, SLOTS, now)


def test_email_due_slot_logic():
    base = dt.datetime(2026, 6, 12, tzinfo=dt.UTC)
    assert _due(None, base.replace(hour=12, minute=5)) is True       # never sent
    sent_8am_slot = base.replace(hour=12, minute=10).isoformat()
    assert _due(sent_8am_slot, base.replace(hour=13, minute=0)) is False  # same slot
    assert _due(sent_8am_slot, base.replace(hour=18, minute=2)) is True   # next slot
    # delayed run: 18:00 slot honored by a 19:05 run
    assert _due(sent_8am_slot, base.replace(hour=19, minute=5)) is True
    sent_6pm = base.replace(hour=18, minute=30).isoformat()
    assert _due(sent_6pm, base.replace(hour=23, minute=0)) is False
    # midnight slot the next day
    assert _due(sent_6pm, base.replace(hour=0) + dt.timedelta(days=1, minutes=20)) is True


def test_email_due_local_tz_tracks_dst():
    """8am/12pm/6pm ET slots fire at the right UTC hour in both seasons: the
    8am ET slot is 12:00 UTC in summer (EDT) but 13:00 UTC in winter (EST)."""
    from zoneinfo import ZoneInfo
    et = ZoneInfo("America/New_York")
    hours = [8, 12, 18]

    def due(last_iso, now):
        return st.email_due(last_iso, hours, now, et)

    # --- summer (EDT, UTC-4): 8am ET == 12:00 UTC ---
    jul = dt.datetime(2026, 7, 15, tzinfo=dt.UTC)
    assert due(None, jul.replace(hour=11, minute=55)) is True   # never sent -> due
    sent = jul.replace(hour=10).isoformat()
    assert due(sent, jul.replace(hour=11, minute=55)) is False  # 7:55am ET, pre-slot
    assert due(sent, jul.replace(hour=12, minute=5)) is True    # 8:05am ET slot

    # --- winter (EST, UTC-5): 8am ET == 13:00 UTC ---
    jan = dt.datetime(2027, 1, 15, tzinfo=dt.UTC)
    sent_w = jan.replace(hour=11).isoformat()
    assert due(sent_w, jan.replace(hour=12, minute=5)) is False  # 7:05am EST, pre-slot
    assert due(sent_w, jan.replace(hour=13, minute=5)) is True   # 8:05am EST slot


# ----------------------------------------------------------- outbox + email

def test_outbox_idempotent_and_email_build():
    state = st.empty_state()
    job = _job()
    job.dedup_key = "url:https://x.com/1"
    item = outbox_item(job, ["company:top_companies"], TERMS)
    assert st.outbox_add(state, "example", item) is True
    assert st.outbox_add(state, "example", item) is False     # dedup by key
    job2 = _job(company="NCR Voyix", title="SWE Co-op Spring 2027 <script>",
                terms=["Spring 2027"], url="https://x.com/2",
                locations=["Atlanta, GA"], salary="$30/hr")
    job2.dedup_key = "url:https://x.com/2"
    st.outbox_add(state, "example", outbox_item(job2, ["location:atlanta-metro"], TERMS))

    items = st.outbox_items(state, "example")
    subject, html, text = build_email(items, TERMS, NOW)
    assert subject == "intern-watch: 2 new (Fall 2026: 1, Spring 2027: 1)"
    assert "[TOP]" in text and "[ATL]" in text
    assert 'href="https://x.com/1"' in html
    assert "&lt;script&gt;" in html                          # html-escaped titles
    assert html.index("Fall 2026") < html.index("Spring 2027")

    st.outbox_clear(state, "example")
    assert st.outbox_items(state, "example") == []


def test_outbox_survives_save_load(tmp_path):
    state = st.empty_state()
    job = _job()
    job.dedup_key = "url:https://x.com/1"
    st.outbox_add(state, "example", outbox_item(job, ["always"], TERMS))
    st.set_last_email(state, "example", NOW)
    st.save_state(state, tmp_path / "seen.json")
    loaded = st.load_state(tmp_path / "seen.json")
    assert len(st.outbox_items(loaded, "example")) == 1
    assert st.get_last_email(loaded, "example") == NOW.isoformat()
