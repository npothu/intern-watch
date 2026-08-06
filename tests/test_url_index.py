import datetime as dt

from src import state as st

TODAY = dt.date(2026, 8, 1)


def test_url_index_first_writer_wins_and_backrefs():
    s = st.empty_state()
    assert st.url_index_put(s, "ats:gh:1", "url:a") == "url:a"
    # A later writer for the same canon never displaces the first.
    assert st.url_index_put(s, "ats:gh:1", "jr:b") == "url:a"
    assert st.url_index_get(s, "ats:gh:1") == "url:a"
    # Back-ref only written when the jobs entry exists.
    assert "url:a" not in s["jobs"]
    st.touch(s, "url:a", ["simplify"], TODAY)
    st.url_index_put(s, "ats:gh:2", "url:a")
    assert s["jobs"]["url:a"]["canon"] == "ats:gh:2"


def test_url_index_get_missing():
    assert st.url_index_get(st.empty_state(), "nope") is None


def test_mark_dup_of():
    s = st.empty_state()
    st.mark_dup_of(s, "jr:b", "url:a")
    assert s["jobs"]["jr:b"]["dup_of"] == "url:a"


def test_seed_url_index_idempotent_first_delivered_wins():
    s = st.empty_state()
    s["matches"] = {"u": [
        {"key": "url:x", "url": "https://boards.greenhouse.io/co/jobs/99"},
        {"key": "jr:y", "url": "https://job-boards.greenhouse.io/co/jobs/99"},
        {"key": "jr:z", "url": "https://jobright.ai/jobs/info/"
                                "6a4298496faf756060967309"},
    ]}
    n = st.seed_url_index(s)
    # jobright url contributes nothing; the two greenhouse variants share a
    # canon and the earliest-listed delivery wins.
    assert n == 2
    assert st.url_index_get(s, "ats:gh:99") == "url:x"
    # Second call is a no-op (flag set).
    assert st.seed_url_index(s) == 0


def test_prune_drops_dead_index_entries():
    s = st.empty_state()
    st.touch(s, "url:live", ["s"], TODAY)
    st.url_index_put(s, "ats:gh:5", "url:live")
    st.url_index_put(s, "ats:gh:6", "url:gone")   # no jobs entry
    st.prune(s, TODAY + dt.timedelta(days=1))
    assert st.url_index_get(s, "ats:gh:5") == "url:live"
    assert st.url_index_get(s, "ats:gh:6") is None


def test_migrate_rekeys_url_canon_to_ats_token_and_backrefs():
    s = st.empty_state()
    st.touch(s, "url:x", ["ats-boards"], TODAY)
    s["url_index"] = {
        "https://acme.wd1.myworkdayjobs.com/Ext/job/City-ST/Title_R123456":
            "url:x"}
    n = st.migrate_url_index(s)
    assert n > 0
    assert s["url_index"] == {"ats:wd:acme:R123456": "url:x"}
    assert s["jobs"]["url:x"]["canon"] == "ats:wd:acme:R123456"
    assert s["_meta"]["url_index_version"] == st.CANON_VERSION


def test_migrate_collision_keeps_earliest_first_seen():
    s = st.empty_state()
    st.touch(s, "url:old", ["ats-boards"], TODAY)
    st.touch(s, "url:new", ["ats-boards"], TODAY + dt.timedelta(days=1))
    s["url_index"] = {
        "https://boards.greenhouse.io/acme/jobs/777": "url:old",
        "https://job-boards.greenhouse.io/acme/jobs/777": "url:new",
    }
    st.migrate_url_index(s)
    assert s["url_index"] == {"ats:gh:777": "url:old"}
    assert s["jobs"]["url:old"]["canon"] == "ats:gh:777"


def test_migrate_clears_stale_canon_of_losing_collision_entry():
    s = st.empty_state()
    st.touch(s, "url:old", ["ats-boards"], TODAY)
    st.touch(s, "url:new", ["ats-boards"], TODAY + dt.timedelta(days=1))
    s["url_index"] = {
        "https://boards.greenhouse.io/acme/jobs/555": "url:old",
        "https://job-boards.greenhouse.io/acme/jobs/555": "url:new",
    }
    s["jobs"]["url:old"]["canon"] = "https://boards.greenhouse.io/acme/jobs/555"
    s["jobs"]["url:new"]["canon"] = "https://job-boards.greenhouse.io/acme/jobs/555"
    st.migrate_url_index(s)
    assert s["jobs"]["url:old"]["canon"] == "ats:gh:555"
    assert "canon" not in s["jobs"]["url:new"]


def test_migrate_tie_prefers_non_jr_key():
    s = st.empty_state()
    st.touch(s, "jr:1", ["jobright"], TODAY)
    st.touch(s, "url:x", ["simplify"], TODAY)   # equal first_seen
    s["url_index"] = {
        "https://boards.greenhouse.io/acme/jobs/888": "jr:1",
        "https://job-boards.greenhouse.io/acme/jobs/888": "url:x",
    }
    st.migrate_url_index(s)
    assert s["url_index"] == {"ats:gh:888": "url:x"}


def test_migrate_leaves_ats_entries_untouched():
    s = st.empty_state()
    st.touch(s, "url:a", ["simplify"], TODAY)
    s["url_index"] = {"ats:gh:42": "url:a"}
    assert st.migrate_url_index(s) == 0
    assert s["url_index"] == {"ats:gh:42": "url:a"}
    assert s["jobs"]["url:a"]["canon"] == "ats:gh:42"


def test_migrate_idempotent_second_call_mutates_nothing():
    import copy
    s = st.empty_state()
    st.touch(s, "jr:1", ["jobright"], TODAY)
    s["url_index"] = {
        "https://job-boards.greenhouse.io/acme/jobs/999": "jr:1"}
    st.migrate_url_index(s)
    before = copy.deepcopy(s)
    assert st.migrate_url_index(s) == 0
    assert s == before


def test_migrate_backfills_jr_apply_urls_first_wins():
    s = st.empty_state()
    # url:share owns the Greenhouse canon via its old URL-string index entry,
    # delivered earlier; jr:owned's apply_url reaches the same canon and must
    # not steal it, while jr:fresh's apply_url registers a brand new entry.
    st.touch(s, "url:share", ["simplify"], TODAY - dt.timedelta(days=1))
    s["url_index"] = {
        "https://boards.greenhouse.io/acme/jobs/123": "url:share"}
    st.touch(s, "jr:owned", ["jobright"], TODAY)
    st.apply_url_put(s, "jr:owned",
                     "https://job-boards.greenhouse.io/acme/jobs/123")
    st.touch(s, "jr:fresh", ["jobright"], TODAY)
    st.apply_url_put(s, "jr:fresh",
                     "https://job-boards.greenhouse.io/acme/jobs/999")
    st.migrate_url_index(s)
    assert s["url_index"]["ats:gh:123"] == "url:share"   # not stolen
    assert "canon" not in s["jobs"]["jr:owned"]
    assert s["url_index"]["ats:gh:999"] == "jr:fresh"
    assert s["jobs"]["jr:fresh"]["canon"] == "ats:gh:999"
