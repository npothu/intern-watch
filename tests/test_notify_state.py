import datetime as dt
from pathlib import Path

from src import state as st
from src.models import Job
from src.notify import CHUNK_LIMIT, build_digest

NOW = dt.datetime(2026, 6, 11, 18, 0, tzinfo=dt.timezone.utc)
TERMS = ["Fall 2026", "Spring 2027", "Summer 2027"]


def _match(i, term="Fall 2026", reasons=None):
    return (Job(company=f"Company{i}", title=f"SWE Intern {i} ({term})",
                terms=[term], url=f"https://x.com/{i}", source="s",
                locations=["Atlanta, GA"]),
            reasons or ["company:top_companies"])


def test_digest_grouping_and_tags():
    matches = [_match(1, "Summer 2027", ["always"]),
               _match(2, "Fall 2026", ["company:top_companies"]),
               _match(3, "Fall 2026", ["location:atlanta-metro"]),
               _match(4, "Fall 2026", ["company:top_companies (LLM)"])]
    chunks = build_digest(matches, TERMS, NOW)
    text = "\n".join(chunks)
    assert text.index("Fall 2026") < text.index("Summer 2027")
    assert "[TOP] Company2" in text
    assert "[ATL] Company3" in text
    assert "[TOP*] Company4" in text
    assert "4 new matches" in text
    assert "<https://x.com/1>" in text          # <> suppresses Discord embeds


def test_digest_chunking_under_limit():
    matches = [_match(i) for i in range(300)]
    chunks = build_digest(matches, TERMS, NOW)
    assert len(chunks) > 1
    assert all(len(c) <= CHUNK_LIMIT for c in chunks)
    assert sum(c.count("• ") for c in chunks) == 300   # nothing dropped


def test_empty_matches_no_chunks():
    assert build_digest([], TERMS, NOW) == []


# ------------------------------------------------------------------- state

def test_state_roundtrip(tmp_path: Path):
    today = dt.date(2026, 6, 11)
    state = st.load_state(tmp_path / "seen.json")
    assert st.touch(state, "jr:abc", ["jobright-swe"], today) is True
    assert st.touch(state, "jr:abc", ["speedyapply"], today) is False
    assert state["jobs"]["jr:abc"]["sources"] == ["jobright-swe", "speedyapply"]

    st.mark_notified(state, "jr:abc", "example")
    st.set_pending(state, "url:x", "example")
    st.llm_cache_put(state, "jr:abc",
                     {"term": "Fall 2026", "in_atlanta_metro": False})
    st.company_top_put(state, "Universal Creative", "example", True, today)

    st.save_state(state, tmp_path / "seen.json")
    loaded = st.load_state(tmp_path / "seen.json")
    assert st.was_notified(loaded, "jr:abc", "example")
    assert st.pending_keys(loaded, "example") == {"url:x"}
    facts = st.llm_cache_get(loaded, "jr:abc")
    assert facts == {"term": "Fall 2026", "in_atlanta_metro": False}
    # top-company verdict is per-employer and per-user
    assert st.company_top_get(loaded, "Universal Creative", "example") is True
    assert st.company_top_get(loaded, "universal creative", "example") is True
    assert st.company_top_get(loaded, "Universal Creative", "otheruser") is None
    assert st.company_top_get(loaded, "Universal Orlando", "example") is None


def test_company_prune(tmp_path: Path):
    state = st.load_state(tmp_path / "seen.json")
    st.company_top_put(state, "OldCo", "example", True, dt.date(2026, 1, 1))
    st.company_top_put(state, "FreshCo", "example", False, dt.date(2026, 6, 10))
    st.prune(state, dt.date(2026, 6, 11), keep_days=120)
    assert st.company_top_get(state, "OldCo", "example") is None
    assert st.company_top_get(state, "FreshCo", "example") is False


def test_prune_on_last_seen(tmp_path: Path):
    state = st.load_state(tmp_path / "seen.json")
    st.touch(state, "old", ["s"], dt.date(2026, 1, 1))
    st.touch(state, "fresh", ["s"], dt.date(2026, 1, 1))
    st.touch(state, "fresh", ["s"], dt.date(2026, 6, 10))  # seen again recently
    assert st.prune(state, dt.date(2026, 6, 11), keep_days=120) == 1
    assert "fresh" in state["jobs"] and "old" not in state["jobs"]