import datetime as dt

import pytest

from src import main
from src import state as st
from src.models import Job

TODAY = dt.date(2026, 8, 1)
LEVER = "https://jobs.lever.co/acme/bdcfb29f-4f27-42de-933f-7f83a359b9f0"
DROPBOX = "https://jobs.dropbox.com/listing/8106224?gh_jid=8106224"
GREENHOUSE = "https://boards.greenhouse.io/embed/job_app?token=8106224"


@pytest.mark.parametrize("reverse", [False, True])
def test_dropbox_prefers_inner_application_url_and_keeps_richer_metadata(reverse):
    wrapper = _job("url:dropbox", DROPBOX, terms=["Summer 2027"])
    wrapper.jd_url = "https://boards-api.greenhouse.io/v1/boards/dropbox/jobs/8106224"
    direct = _job("url:greenhouse", GREENHOUSE, source="vanshb03-2027")
    jobs = [wrapper, direct]
    if reverse:
        jobs.reverse()
    kept = main._drop_url_dupes(st.empty_state(), "u", _accepted(*jobs),
                                ["Summer 2027"], TODAY)
    assert len(kept) == 1
    survivor = kept[0][0]
    assert survivor.url == GREENHOUSE
    assert survivor.terms == ["Summer 2027"]
    assert survivor.jd_url == wrapper.jd_url


def test_cross_run_upgrades_prior_link_without_renotifying_or_rekeying():
    s = st.empty_state()
    prior = {"key": "url:dropbox", "url": DROPBOX, "applied": True, "resume": "old.docx"}
    s["matches"]["u"] = [prior]
    s["outbox"]["u"] = [dict(prior)]
    st.url_index_put(s, "ats:gh:8106224", prior["key"])
    direct = _job("url:greenhouse", GREENHOUSE)
    assert main._drop_url_dupes(s, "u", _accepted(direct), [], TODAY) == []
    assert prior == {"key": "url:dropbox", "url": GREENHOUSE,
                     "applied": True, "resume": "old.docx"}
    assert s["outbox"]["u"][0]["url"] == GREENHOUSE


def test_user_owned_match_wins_even_when_global_index_points_to_another_users_key():
    s = st.empty_state()
    st.url_index_put(s, "ats:gh:8106224", "url:other-user")
    s["matches"]["u"] = [{"key": "url:dropbox", "url": DROPBOX}]
    direct = _job("url:greenhouse", GREENHOUSE)
    assert main._drop_url_dupes(s, "u", _accepted(direct), [], TODAY) == []
    assert s["jobs"][direct.dedup_key]["dup_of"] == "url:dropbox"


def _job(key, url, source="ats-boards", jobright_id=None, terms=None):
    j = Job(company="Acme", title="SWE Intern", url=url, source=source,
            jobright_id=jobright_id, terms=terms or [])
    j.dedup_key = key
    return j


def _accepted(*jobs):
    return [(j, ["always"]) for j in jobs]


def test_cross_run_suppress_when_prior_owned_via_matches():
    s = st.empty_state()
    # Prior ATS delivery for this user, registered in the index.
    prior = _job("url:acme-lever", LEVER)
    st.touch(s, prior.dedup_key, prior.sources, TODAY)
    st.url_index_put(s, "ats:lever:acme:bdcfb29f-4f27-42de-933f-7f83a359b9f0",
                     prior.dedup_key)
    s["matches"]["u"] = [{"key": "url:acme-lever", "url": LEVER}]
    # The jobright twin arrives, already resolved to the same employer url.
    twin = _job("jr:abc", LEVER, source="jobright-swe", jobright_id="abc")
    kept = main._drop_url_dupes(s, "u", _accepted(twin), ["Summer 2027"], TODAY)
    assert kept == []
    assert st.was_notified(s, "jr:abc", "u")
    assert s["jobs"]["jr:abc"]["dup_of"] == "url:acme-lever"


def test_cross_run_passthrough_when_prior_not_owned_by_user():
    s = st.empty_state()
    st.touch(s, "url:acme-lever", ["ats-boards"], TODAY)
    st.url_index_put(s, "ats:lever:acme:bdcfb29f-4f27-42de-933f-7f83a359b9f0",
                     "url:acme-lever")
    # No matches/outbox/notified entry for user "u" -> not owned.
    twin = _job("jr:abc", LEVER, source="jobright-swe", jobright_id="abc")
    kept = main._drop_url_dupes(s, "u", _accepted(twin), ["Summer 2027"], TODAY)
    assert [j.dedup_key for j, _ in kept] == ["jr:abc"]
    assert not st.was_notified(s, "jr:abc", "u")


def test_within_batch_known_term_beats_unknown_and_nonjobright_wins_tie():
    s = st.empty_state()
    jr = _job("jr:abc", LEVER, source="jobright-swe", jobright_id="abc")
    ats = _job("url:acme-lever", LEVER, terms=["Summer 2027"])
    # ats has a term, jr does not -> ats survives regardless of order.
    kept = main._drop_url_dupes(s, "u", _accepted(jr, ats),
                                ["Summer 2027"], TODAY)
    assert [j.dedup_key for j, _ in kept] == ["url:acme-lever"]
    assert st.was_notified(s, "jr:abc", "u")
    assert s["jobs"]["jr:abc"]["dup_of"] == "url:acme-lever"
    # Survivor absorbed the loser's source.
    survivor = kept[0][0]
    assert "jobright-swe" in survivor.sources


def test_within_batch_tie_prefers_non_jobright():
    s = st.empty_state()
    jr = _job("jr:abc", LEVER, source="jobright-swe", jobright_id="abc",
              terms=["Summer 2027"])
    ats = _job("url:acme-lever", LEVER, terms=["Summer 2027"])
    # Both have a term -> non-jobright wins.
    kept = main._drop_url_dupes(s, "u", _accepted(jr, ats),
                                ["Summer 2027"], TODAY)
    assert [j.dedup_key for j, _ in kept] == ["url:acme-lever"]


def test_uncanonicalizable_jobright_url_passes_through():
    s = st.empty_state()
    j = _job("jr:abc", "https://jobright.ai/jobs/info/"
             "6a4298496faf756060967309", source="jobright-swe",
             jobright_id="abc")
    kept = main._drop_url_dupes(s, "u", _accepted(j), ["Summer 2027"], TODAY)
    assert [x.dedup_key for x, _ in kept] == ["jr:abc"]


def test_survivor_registers_in_index():
    s = st.empty_state()
    j = _job("url:acme-lever", LEVER)
    main._drop_url_dupes(s, "u", _accepted(j), ["Summer 2027"], TODAY)
    assert st.url_index_get(
        s, "ats:lever:acme:bdcfb29f-4f27-42de-933f-7f83a359b9f0") \
        == "url:acme-lever"


# --- _backfill_apply_urls -------------------------------------------------

class _StubResolver:
    def __init__(self, mapping):
        self.mapping = mapping
        self.calls = []

    def resolve_apply_url(self, jr_id):
        self.calls.append(jr_id)
        return self.mapping.get(jr_id)


def test_backfill_oldest_first_capped_and_indexes():
    s = st.empty_state()
    s["matches"]["u"] = [
        {"key": "jr:aaaaaaaaaaaaaaaaaaaaaaaa", "url": "x", "added": "2026-07-10"},
        {"key": "jr:bbbbbbbbbbbbbbbbbbbbbbbb", "url": "x", "added": "2026-07-01"},
        {"key": "jr:cccccccccccccccccccccccc", "url": "x", "added": "2026-07-20"},
    ]
    res = _StubResolver({
        "bbbbbbbbbbbbbbbbbbbbbbbb": LEVER,
        "aaaaaaaaaaaaaaaaaaaaaaaa": "https://boards.greenhouse.io/c/jobs/5",
    })
    n = main._backfill_apply_urls(s, res, limit=2)
    assert n == 2
    # Oldest two by `added`: bbb (07-01) then aaa (07-10); ccc untouched.
    assert res.calls == ["bbbbbbbbbbbbbbbbbbbbbbbb", "aaaaaaaaaaaaaaaaaaaaaaaa"]
    assert st.apply_url_get(s, "jr:bbbbbbbbbbbbbbbbbbbbbbbb") == LEVER
    assert st.url_index_get(s, "ats:gh:5") == "jr:aaaaaaaaaaaaaaaaaaaaaaaa"
    # Never rewrites the delivered match item's display url.
    assert s["matches"]["u"][0]["url"] == "x"


def test_backfill_skips_already_cached_and_handles_none():
    s = st.empty_state()
    s["matches"]["u"] = [
        {"key": "jr:dddddddddddddddddddddddd", "url": "x", "added": "2026-07-01"},
    ]
    st.apply_url_put(s, "jr:dddddddddddddddddddddddd", LEVER)  # already cached
    res = _StubResolver({})
    assert main._backfill_apply_urls(s, res) == 0
    assert res.calls == []


def test_backfill_resolver_none_safe():
    assert main._backfill_apply_urls(st.empty_state(), None) == 0
