"""First-sight seeding of newly added sources and ATS boards (src/seeding.py)."""

import datetime as dt

from src import main, seeding
from src import state as st
from src.adapters import ats_boards
from src.dedupe import dedupe
from src.models import Job, SourceConfig
from tests.test_main_integration import _freeze_clock, _user_cfg, _wire

TODAY = dt.date(2026, 6, 12)


def _job(i, source="old-src", board=None):
    return Job(company=f"Co{i}", title="Software Engineer Intern",
               url=f"https://x.com/{i}", source=source, board=board,
               terms=["Summer 2027"], term_confidence="explicit",
               locations=["Atlanta, GA"])


def _state(known_sources=(), known_boards=(), entries=()):
    state = st.empty_state()
    state["_meta"]["known_sources"] = sorted(known_sources)
    state["_meta"]["known_boards"] = sorted(known_boards)
    for key, sources in entries:
        st.touch(state, key, sources, TODAY - dt.timedelta(days=3))
    return state


def _plan(state, raw, report):
    dedupe(raw)  # stamps dedup_key on every raw row
    return seeding.first_sight(state, raw, report)


def _report(sources=None, boards=None):
    return seeding.FetchReport(sources=dict(sources or {}),
                               boards=dict(boards or {}))


# ------------------------------------------------------------ unit: planning

def test_new_source_backlog_seeded_known_source_not():
    state = _state(known_sources={"old-src"})
    raw = [_job(1, "old-src"), _job(2, "new-src"), _job(3, "new-src")]
    plan = _plan(state, raw, _report({"old-src": False, "new-src": False}))
    assert set(plan) == {raw[1].dedup_key, raw[2].dedup_key}
    assert plan[raw[1].dedup_key] == ["new-src"]


def test_same_job_via_known_source_is_evaluated_not_seeded():
    state = _state(known_sources={"old-src"})
    raw = [_job(1, "new-src"), _job(1, "old-src")]
    plan = _plan(state, raw, _report({"old-src": False, "new-src": False}))
    assert plan == {}


def test_already_seen_job_from_new_source_is_not_touched():
    state = _state(known_sources={"old-src"}, entries=[("url:https://x.com/1", ["old-src"])])
    raw = [_job(1, "new-src")]
    raw[0].dedup_key = "url:https://x.com/1"
    assert seeding.first_sight(state, raw, _report({"new-src": False})) == {}


def test_new_board_inside_known_source_seeded():
    state = _state(known_sources={"ats-boards"}, known_boards={"greenhouse:old"})
    raw = [_job(1, "ats-boards", "greenhouse:old"),
           _job(2, "ats-boards", "oracle:new")]
    plan = _plan(state, raw, _report(
        {"ats-boards": False},
        {"greenhouse:old": ("ats-boards", False),
         "oracle:new": ("ats-boards", False)}))
    assert plan == {raw[1].dedup_key: ["oracle:new"]}


def test_backfill_rows_opt_out():
    state = _state(known_sources={"ats-boards"})
    raw = [_job(1, "new-src"), _job(2, "ats-boards", "oracle:new")]
    plan = _plan(state, raw, _report(
        {"new-src": True, "ats-boards": False},
        {"oracle:new": ("ats-boards", True)}))
    assert plan == {}


def test_bootstrap_derives_known_from_state():
    # No known_* lists yet (first run of this code). old-src appears in
    # state; greenhouse:old has a job state already saw through ats-boards;
    # oracle:new does not -> only its new job is seeded.
    state = st.empty_state()
    for key, src in [("url:https://x.com/1", ["old-src"]),
                     ("url:https://x.com/10", ["ats-boards"])]:
        st.touch(state, key, src, TODAY)
    raw = [_job(2, "old-src"),
           _job(10, "ats-boards", "greenhouse:old"),
           _job(11, "ats-boards", "greenhouse:old"),
           _job(20, "ats-boards", "oracle:new")]
    plan = _plan(state, raw, _report(
        {"old-src": False, "ats-boards": False},
        {"greenhouse:old": ("ats-boards", False),
         "oracle:new": ("ats-boards", False)}))
    assert plan == {raw[3].dedup_key: ["oracle:new"]}


def test_bootstrap_evidence_ignores_jobs_ingested_by_another_source():
    # The new board's job was already in state via simplify: that is no
    # evidence the BOARD was fetched before, so its other new job is seeded.
    state = st.empty_state()
    st.touch(state, "url:https://x.com/20", ["simplify"], TODAY)
    st.touch(state, "url:https://x.com/99", ["ats-boards"], TODAY)
    raw = [_job(20, "ats-boards", "oracle:new"),
           _job(21, "ats-boards", "oracle:new")]
    plan = _plan(state, raw, _report(
        {"ats-boards": False}, {"oracle:new": ("ats-boards", False)}))
    assert plan == {raw[1].dedup_key: ["oracle:new"]}


def test_record_known_unions_and_sorts():
    state = _state(known_sources={"b"}, known_boards={"x:1"})
    seeding.record_known(state, _report({"a": False},
                                        {"y:2": ("ats-boards", False)}))
    assert state["_meta"]["known_sources"] == ["a", "b"]
    assert state["_meta"]["known_boards"] == ["x:1", "y:2"]


# ------------------------------------------------- adapter stamps board ids

def test_ats_adapter_stamps_board_and_reports_answered_boards(
        monkeypatch, tmp_path, fixtures):
    boards = tmp_path / "boards.yaml"
    boards.write_text(
        "boards:\n"
        "- {company: Anduril, ats: greenhouse, slug: AndurilIndustries}\n"
        "- {company: Empty, ats: ashby, slug: empty, backfill: true}\n"
        "- {company: Dead, ats: lever, slug: dead}\n", encoding="utf-8")
    gh = (fixtures / "ats_greenhouse_anduril.json").read_text(encoding="utf-8")

    def fake_fetch(client, url):
        if "greenhouse" in url:
            return gh
        if "ashby" in url:
            return '{"jobs": []}'
        raise RuntimeError("down")

    monkeypatch.setattr(ats_boards, "fetch_text", fake_fetch)
    monkeypatch.setattr(ats_boards, "ROOT", tmp_path)
    adapter = ats_boards.AtsBoardsAdapter(SourceConfig(
        name="ats-boards", adapter="ats_boards", boards_file="boards.yaml"))
    jobs = adapter.fetch(None, TODAY)
    assert jobs and {j.board for j in jobs} == {"greenhouse:andurilindustries"}
    # zero-row boards count as answered; failed boards do not
    assert adapter.fetched_boards == {"greenhouse:andurilindustries": False,
                                      "ashby:empty": True}


# ------------------------------------------------------------ end to end

def _wire_two(monkeypatch, listed):
    class Adapter:
        def __init__(self, cfg):
            self.cfg = cfg
            self.fetched_boards = {}

        def fetch(self, client, today):
            jobs = [j.model_copy() for j in listed if j.source == self.cfg.name]
            if not jobs and self.cfg.name == "new-src":
                # not live yet; a source that answers (even empty) is known
                raise RuntimeError("not configured yet")
            for j in jobs:
                if j.board:
                    self.fetched_boards[j.board] = False
            return jobs

    sources = [SourceConfig(name="old-src", adapter="a"),
               SourceConfig(name="ats-boards", adapter="a"),
               SourceConfig(name="new-src", adapter="a")]
    _wire(monkeypatch, sources, {s.name: Adapter for s in sources},
          [_user_cfg()])
    _freeze_clock(monkeypatch)


def test_end_to_end_new_origins_deliver_nothing(monkeypatch, tmp_path):
    listed = [_job(1, "old-src"), _job(2, "ats-boards", "greenhouse:old")]
    _wire_two(monkeypatch, listed)
    state_file = tmp_path / "seen.json"
    argv = ["--state-file", str(state_file)]
    assert main.main(argv + ["--seed"]) == 0
    state = st.load_state(state_file)
    # --seed records what answered as known
    assert state["_meta"]["known_sources"] == ["ats-boards", "old-src"]
    assert state["_meta"]["known_boards"] == ["greenhouse:old"]

    # Next run: a new source and a new board appear with a backlog, plus one
    # genuinely new job on a known source and one on a known board.
    listed += [_job(3, "new-src"), _job(4, "new-src"),
               _job(5, "ats-boards", "oracle:new"),
               _job(6, "old-src"), _job(7, "ats-boards", "greenhouse:old")]
    assert main.main(argv) == 0
    state = st.load_state(state_file)
    keys = {i: dedupe([_job(i)])[0].dedup_key for i in range(1, 8)}
    for i in (3, 4, 5):
        assert state["jobs"][keys[i]]["seeded"] == TODAY.isoformat()
        assert not st.was_notified(state, keys[i], "example")
    for i in (6, 7):
        assert "seeded" not in state["jobs"][keys[i]]
        assert st.was_notified(state, keys[i], "example")
    assert "new-src" in state["_meta"]["known_sources"]
    assert "oracle:new" in state["_meta"]["known_boards"]

    # Third run: the once-new origins now deliver their new postings.
    listed += [_job(8, "new-src"), _job(9, "ats-boards", "oracle:new")]
    monkeypatch.setattr(main, "send_email", lambda *a, **k: True)
    assert main.main(argv + ["--send-now"]) == 0
    state = st.load_state(state_file)
    for i in (8, 9):
        key = dedupe([_job(i)])[0].dedup_key
        assert "seeded" not in state["jobs"][key]
        assert st.was_notified(state, key, "example")
