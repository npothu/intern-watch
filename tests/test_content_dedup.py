import datetime as dt

from src import state as st
from src.content_dedup import (
    SUPPRESS_WINDOW_DAYS,
    _parse_sig,
    compatible,
    content_signature,
    find_compatible,
    seed_from_matches,
    signature_from_item,
)
from src.filters import location_bucket
from src.main import _drop_content_dupes
from src.models import Job
from src.normalize import norm_title


def _job(**kw):
    base = {"company": "Acme", "title": "SWE Intern", "url": "https://acme.com/j/1",
            "source": "jobright-swe", "terms": ["Summer 2027"]}
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
    atl = _job(locations=["Atlanta, GA"])
    atl.dedup_key = "jr:atl"
    aus = _job(locations=["Austin, TX"])
    aus.dedup_key = "jr:aus"
    kept = _drop_content_dupes(state, "example", [(atl, []), (aus, [])],
                               ["Summer 2027"], day)
    assert len(kept) == 2


def test_gate_redelivers_after_window():
    state = st.empty_state()
    day0 = dt.date(2026, 6, 1)
    a = _job(locations=["United States"], terms=["Fall 2026"])
    a.dedup_key = "jr:a"
    b = _job(locations=["United States"], terms=["Fall 2026"])
    b.dedup_key = "jr:b"
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


# --------------------------------------------------- compatibility backstop

def test_parse_sig_right_split_with_pipe_in_company():
    p = _parse_sig("a|b corp|software engineer|Summer 2027|us-ny")
    assert p == ("a|b corp", "software engineer", "Summer 2027",
                 frozenset({"us-ny"}))
    assert _parse_sig("too|few") is None


def test_compatible_term_wildcard():
    # Appian: jobright Unknown-term vs ATS Summer 2027, same company/title/loc.
    # Both the empty marker "?" and primary_term's "Unknown term" sentinel
    # must wildcard (production emits the latter).
    assert compatible("appian|swe intern|?|us-va",
                      "appian|swe intern|Summer 2027|us-va")
    assert compatible("appian|swe intern|Unknown term|us-va",
                      "appian|swe intern|Summer 2027|us-va")


def test_compatible_location_unknown_wildcard():
    # Cloudflare: ATS "In-Office" -> unknown vs jobright us-tx.
    assert compatible("cloudflare|sec eng intern|Fall 2026|unknown",
                      "cloudflare|sec eng intern|Fall 2026|us-tx")


def test_compatible_multi_city_intersection():
    assert compatible("tower|quant intern|Summer 2027|us-il+us-ny+us-tx",
                      "tower|quant intern|Summer 2027|us-ny")


def test_incompatible_distinct_known_states():
    assert not compatible("acme|swe intern|Summer 2027|us-ga",
                          "acme|swe intern|Summer 2027|us-tx")


def test_incompatible_term_both_known():
    assert not compatible("acme|swe intern|Fall 2026|us-ga",
                          "acme|swe intern|Summer 2027|us-ga")


def test_incompatible_distinct_title_or_company():
    assert not compatible("acme|swe intern|?|us-ga", "acme|data intern|?|us-ga")
    assert not compatible("acme|swe intern|?|us-ga", "beta|swe intern|?|us-ga")


def test_find_compatible_respects_window_and_old_flat_sigs():
    state = st.empty_state()
    old = "acme|swe intern|Summer 2027|us-tx"   # a pre-change flat sig
    st.content_mark(state, "u", old, "url:a", dt.date(2026, 6, 1))
    probe = "acme|swe intern|?|us-tx"           # jobright Unknown-term twin
    assert find_compatible(state, "u", probe, dt.date(2026, 6, 10),
                           SUPPRESS_WINDOW_DAYS) == old
    # Outside the window -> not found.
    assert find_compatible(state, "u", probe, dt.date(2027, 6, 10),
                           SUPPRESS_WINDOW_DAYS) is None


def test_drop_content_dupes_uses_compatibility():
    state = st.empty_state()
    # An ATS row delivered first (explicit term + state bucket).
    first = _job(terms=["Summer 2027"], locations=["Austin, TX"])
    first.dedup_key = "url:acme"
    kept = _drop_content_dupes(state, "u", [(first, [])], ["Summer 2027"],
                               dt.date(2026, 6, 1))
    assert [j.dedup_key for j, _ in kept] == ["url:acme"]
    # The jobright twin: no term, city-only location -> both wildcards, but
    # same company+title -> suppressed by the compatibility backstop.
    twin = _job(terms=[], locations=[])
    twin.dedup_key = "jr:acme"
    kept2 = _drop_content_dupes(state, "u", [(twin, [])], ["Summer 2027"],
                                dt.date(2026, 6, 2))
    assert kept2 == []
