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
