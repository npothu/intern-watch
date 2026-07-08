import datetime as dt

from src import state as st
from src.content_dedup import (SUPPRESS_WINDOW_DAYS, content_signature,
                               seed_from_matches, signature_from_item)
from src.filters import location_bucket
from src.main import _drop_content_dupes
from src.models import Job
from src.normalize import norm_title


def _job(**kw):
    base = dict(company="Acme", title="SWE Intern", url="https://acme.com/j/1",
                source="jobright-swe", terms=["Summer 2027"])
    base.update(kw)
    return Job(**base)


# ---------------------------------------------------------------- norm_title

def test_norm_title_drops_term_and_punctuation():
    assert (norm_title("Developer Intern, Open Source- Fall 2026")
            == norm_title("Developer Intern Open Source (Fall 2026)")
            == "developer intern open source")


def test_norm_title_ampersand_equals_and():
    assert (norm_title("Research & Development Intern")
            == norm_title("Research and Development Intern"))


def test_norm_title_distinct_roles_stay_distinct():
    assert norm_title("Frontend Intern") != norm_title("Backend Intern")


# ------------------------------------------------------------- location_bucket

def test_location_bucket_state_name_and_abbrev_match():
    assert location_bucket("Atlanta, GA") == "us-ga"
    assert location_bucket("Atlanta, Georgia, United States") == "us-ga"


def test_location_bucket_distinct_states():
    assert location_bucket("Austin, TX") != location_bucket("Atlanta, GA")


def test_location_bucket_country_level_collapses_remote_variants():
    assert location_bucket("Remote (United States)") == "us"
    assert location_bucket("United States") == "us"


def test_location_bucket_abbrev_beats_name_substring():
    # a town named Indiana inside Pennsylvania reads as PA, not IN
    assert location_bucket("Indiana, PA") == "us-pa"


def test_location_bucket_canada_and_intl():
    assert location_bucket("Remote in Canada") == "ca"
    assert location_bucket("Quebec-CAN - Remote") == "ca-qc"
    assert location_bucket("London, UK") == "intl"


# ----------------------------------------------------------- content_signature

def test_signature_collapses_feed_duplicates():
    # same posting, two jobright feeds: cosmetic title diff, same country
    a = _job(title="Developer Intern, Open Source- Fall 2026",
             terms=["Fall 2026"], locations=["Remote (United States)"])
    b = _job(title="Developer Intern Open Source Fall 2026",
             terms=["Fall 2026"], locations=["United States"])
    assert content_signature(a, "Fall 2026") == content_signature(b, "Fall 2026")


def test_signature_keeps_us_and_canada_distinct():
    us = _job(terms=["Fall 2026"], locations=["United States"])
    ca = _job(terms=["Fall 2026"], locations=["Remote in Canada"])
    assert content_signature(us, "Fall 2026") != content_signature(ca, "Fall 2026")


def test_signature_keeps_per_state_distinct():
    atl = _job(locations=["Atlanta, GA"])
    aus = _job(locations=["Austin, TX"])
    assert content_signature(atl, "Summer 2027") != content_signature(aus, "Summer 2027")


def test_signature_keeps_terms_distinct():
    job = _job(locations=["Atlanta, GA"])
    assert content_signature(job, "Fall 2026") != content_signature(job, "Spring 2027")


# ----------------------------------------------------------------- state layer

def test_content_seen_respects_window():
    state = st.empty_state()
    day0 = dt.date(2026, 6, 1)
    st.content_mark(state, "example", "sig", "jr:1", day0)
    assert st.content_seen(state, "example", "sig", day0, SUPPRESS_WINDOW_DAYS)
    within = day0 + dt.timedelta(days=SUPPRESS_WINDOW_DAYS)
    beyond = day0 + dt.timedelta(days=SUPPRESS_WINDOW_DAYS + 1)
    assert st.content_seen(state, "example", "sig", within, SUPPRESS_WINDOW_DAYS)
    assert not st.content_seen(state, "example", "sig", beyond, SUPPRESS_WINDOW_DAYS)


def test_content_mark_tracks_keys_and_is_per_user():
    state = st.empty_state()
    day = dt.date(2026, 6, 1)
    st.content_mark(state, "example", "sig", "jr:1", day)
    st.content_mark(state, "example", "sig", "jr:2", day)
    assert st.content_keys(state, "example", "sig") == ["jr:1", "jr:2"]
    assert st.content_keys(state, "other", "sig") == []


# ------------------------------------------------------------------ the gate

def test_gate_suppresses_second_duplicate_keeps_first():
    state = st.empty_state()
    day = dt.date(2026, 6, 1)
    a = _job(jobright_id="a" * 24, title="SWE Intern- Fall 2026",
             terms=["Fall 2026"], locations=["United States"])
    b = _job(jobright_id="b" * 24, title="SWE Intern Fall 2026",
             terms=["Fall 2026"], locations=["Remote (United States)"])
    a.dedup_key, b.dedup_key = f"jr:{a.jobright_id}", f"jr:{b.jobright_id}"
    terms = ["Fall 2026", "Summer 2027"]
    kept = _drop_content_dupes(state, "example", [(a, []), (b, [])], terms, day)
    assert [j for j, _ in kept] == [a]


def test_gate_keeps_per_state_siblings():
    state = st.empty_state()
    day = dt.date(2026, 6, 1)
    atl = _job(locations=["Atlanta, GA"]); atl.dedup_key = "jr:atl"
    aus = _job(locations=["Austin, TX"]); aus.dedup_key = "jr:aus"
    kept = _drop_content_dupes(state, "example", [(atl, []), (aus, [])],
                               ["Summer 2027"], day)
    assert len(kept) == 2


def test_gate_redelivers_after_window():
    state = st.empty_state()
    day0 = dt.date(2026, 6, 1)
    a = _job(locations=["United States"], terms=["Fall 2026"]); a.dedup_key = "jr:a"
    b = _job(locations=["United States"], terms=["Fall 2026"]); b.dedup_key = "jr:b"
    terms = ["Fall 2026"]
    assert _drop_content_dupes(state, "example", [(a, [])], terms, day0)
    later = day0 + dt.timedelta(days=SUPPRESS_WINDOW_DAYS + 1)
    assert _drop_content_dupes(state, "example", [(b, [])], terms, later)


# ------------------------------------------------------------------ seeding

def test_seed_from_matches_then_suppress():
    state = st.empty_state()
    state["matches"]["example"] = [{
        "key": "jr:old", "company": "Acme", "title": "SWE Intern Fall 2026",
        "term": "Fall 2026", "location": "United States", "added": "2026-06-20"}]
    n = seed_from_matches(state)
    assert n == 1 and state["_meta"]["content_seeded"] is True
    # a later run sees a fresh duplicate key of that already-delivered posting
    dup = _job(title="SWE Intern- Fall 2026", terms=["Fall 2026"],
               locations=["Remote (United States)"])
    dup.dedup_key = "jr:new"
    kept = _drop_content_dupes(state, "example", [(dup, [])], ["Fall 2026"],
                               dt.date(2026, 6, 25))
    assert kept == []


def test_seed_is_idempotent():
    state = st.empty_state()
    state["matches"]["example"] = [{
        "key": "jr:old", "company": "Acme", "title": "SWE Intern",
        "term": "Summer 2027", "location": "United States", "added": "2026-06-20"}]
    assert seed_from_matches(state) == 1
    assert seed_from_matches(state) == 0


def test_signature_from_item_matches_single_location_job():
    job = _job(terms=["Fall 2026"], locations=["Atlanta, GA"])
    item = {"company": "Acme", "title": "SWE Intern", "term": "Fall 2026",
            "location": "Atlanta, GA"}
    assert content_signature(job, "Fall 2026") == signature_from_item(item)