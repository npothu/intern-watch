import datetime as dt

from src import main, state as st
from src.models import Job

TODAY = dt.date(2026, 8, 1)
LEVER = "https://jobs.lever.co/acme/bdcfb29f-4f27-42de-933f-7f83a359b9f0"


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
