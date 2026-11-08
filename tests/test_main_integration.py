"""Orchestrator-level integration tests for src.main.main().

These exercise the real fetch -> dedupe -> already-seen -> per-user filter ->
LLM cost-guard -> notify -> state control flow end to end, with the network,
LLM, and SMTP edges stubbed (no real I/O, no sleep). The adapter/LLM/notify
stubbing mirrors tests/test_health.py and tests/test_jd.py.
"""

import datetime as dt

from src import main
from src import state as st
from src.dedupe import dedup_key
from src.models import Job, SourceConfig

TODAY = dt.date(2026, 6, 12)
NOW = dt.datetime(2026, 6, 12, 12, 5, tzinfo=dt.UTC)


# --- minimal user config: accept-always Summer rule, no LLM/dashboard/resume,
# email outbox only. Mirrors the shape load_users() returns (a plain dict).
def _user_cfg(name="example", rules=None, terms=None):
    return {
        "name": name,
        "eliminate": {"unpaid": True, "grad_only": True,
                      "active_clearance": True, "veteran_only": True,
                      "countries_allowed": ["United States", "Canada"]},
        "role_filter": {"include_keywords": ["software", "engineer"]},
        "terms_wanted": terms or ["Summer 2027"],
        "unknown_term_policy": "drop",
        "rules": rules or [{"when": {"term": ["Summer 2027"]},
                            "accept_if_any": [{"always": True}]}],
        "notify": {"email": {"smtp_user_env": "SMTP_U",
                             "smtp_pass_env": "SMTP_P",
                             "send_at_utc": [0, 12, 18]}},
    }


def _job(i, title="Software Engineer Intern", term="Summer 2027",
         source="ok-src", url=None):
    return Job(company=f"Company{i}", title=title,
               url=url or f"https://x.com/{i}", source=source,
               terms=[term] if term else [], term_confidence="explicit",
               locations=["Atlanta, GA"])


def _key(i):
    """The dedup_key main() will compute for _job(i) (set lazily in dedupe)."""
    return dedup_key(_job(i))


def _wire(monkeypatch, sources, adapters, users):
    """Patch the orchestrator's seams: source loading, adapter construction,
    and user loading. No real files, network, or LLM are touched."""
    monkeypatch.setattr(main, "load_sources", lambda path: sources)
    monkeypatch.setattr(main, "make_adapter",
                        lambda cfg: adapters[cfg.name](cfg))
    monkeypatch.setattr(main, "load_users", lambda path: list(users))
    # never let a stray SMTP send / dashboard sync escape if a test misconfigures
    monkeypatch.setattr(main, "send_email", lambda *a, **k: True)
    # SMTP creds present so _notify_email actually reaches the (stubbed) send
    monkeypatch.setenv("SMTP_U", "u@example.com")
    monkeypatch.setenv("SMTP_P", "pass")


def _freeze_clock(monkeypatch, today=TODAY, now=NOW):
    class _Date(dt.date):
        @classmethod
        def today(cls):
            return today

    class _DT(dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return now

    monkeypatch.setattr(main.dt, "date", _Date)
    monkeypatch.setattr(main.dt, "datetime", _DT)


def _run(monkeypatch, tmp_path, argv_extra=None):
    state_file = tmp_path / "seen.json"
    argv = ["--state-file", str(state_file)] + (argv_extra or [])
    rc = main.main(argv)
    return rc, state_file


# ----------------------------------------------------------- dead + live source

def test_one_dead_one_live_source_run_continues(monkeypatch, tmp_path):
    class DeadAdapter:
        def __init__(self, cfg): pass
        def fetch(self, client, today): raise RuntimeError("dead")

    class OkAdapter:
        def __init__(self, cfg): pass
        def fetch(self, client, today): return [_job(1)]

    sources = [SourceConfig(name="dead-src", adapter="a"),
               SourceConfig(name="ok-src", adapter="a")]
    _wire(monkeypatch, sources,
          {"dead-src": DeadAdapter, "ok-src": OkAdapter}, [_user_cfg()])
    _freeze_clock(monkeypatch)

    # pre-seed an unrelated entry so this isn't a first run (no seed-only path)
    # and the live job is genuinely new this run. dead-src already failing once.
    state_file = tmp_path / "seen.json"
    pre = st.empty_state()
    st.touch(pre, "jr:preexisting", ["ok-src"], TODAY)
    st.record_source_failure(pre, "dead-src", "x", TODAY)
    st.save_state(pre, state_file)

    rc2 = main.main(["--state-file", str(state_file)])

    assert rc2 == 0
    state = st.load_state(state_file)
    # dead source failure recorded (was 1, now 2); live source kept flowing
    assert state["_meta"]["source_health"]["dead-src"]["consecutive_failures"] == 2
    assert "ok-src" not in state["_meta"]["source_health"]
    # the live job made it all the way through: NOW is 12:05 UTC, the 12:00
    # slot has passed and last_email is None -> emailed (notified).
    assert st.was_notified(state, _key(1), "example")


# ---------------------------------------------------------- total source outage

def test_total_outage_returns_nonzero_and_preserves_state(monkeypatch, tmp_path):
    class DeadAdapter:
        def __init__(self, cfg): pass
        def fetch(self, client, today): raise RuntimeError("dead")

    sources = [SourceConfig(name="dead-src", adapter="a")]
    _wire(monkeypatch, sources, {"dead-src": DeadAdapter}, [_user_cfg()])
    _freeze_clock(monkeypatch)

    # pre-seed real state on disk so we can prove main() does NOT wipe it
    state_file = tmp_path / "seen.json"
    seeded = st.empty_state()
    st.touch(seeded, "jr:deadbeef", ["ok-src"], TODAY)
    st.mark_notified(seeded, "jr:deadbeef", "example")
    st.save_state(seeded, state_file)

    rc = main.main(["--state-file", str(state_file)])

    assert rc == 1
    after = st.load_state(state_file)
    assert "jr:deadbeef" in after["jobs"]                 # state untouched
    assert st.was_notified(after, "jr:deadbeef", "example")


# ------------------------------------------------------ first-run seed, then new

def test_first_run_seeds_without_notifying_then_notifies_new(monkeypatch, tmp_path):
    listed = [_job(1)]

    class OkAdapter:
        def __init__(self, cfg): pass
        def fetch(self, client, today): return list(listed)

    sources = [SourceConfig(name="ok-src", adapter="a")]
    _wire(monkeypatch, sources, {"ok-src": OkAdapter}, [_user_cfg()])
    _freeze_clock(monkeypatch)

    # first run (empty state, no --backfill) -> seed only, no notification
    rc1, state_file = _run(monkeypatch, tmp_path)
    assert rc1 == 0
    state = st.load_state(state_file)
    assert _key(1) in state["jobs"]
    assert not st.was_notified(state, _key(1), "example")
    assert st.outbox_items(state, "example") == []

    # second run: an additional genuinely-new job appears -> only it notifies
    listed.append(_job(2))
    rc2, _ = _run(monkeypatch, tmp_path)
    assert rc2 == 0
    state = st.load_state(state_file)
    assert not st.was_notified(state, _key(1), "example")  # old, seeded
    assert st.was_notified(state, _key(2), "example")      # new


# ------------------------------------------------ user whose rules reject all

def test_user_rejecting_everything_adds_nothing(monkeypatch, tmp_path):
    class OkAdapter:
        def __init__(self, cfg): pass
        def fetch(self, client, today):
            return [_job(1), _job(2)]

    sources = [SourceConfig(name="ok-src", adapter="a")]
    # Fall 2026 rule that requires Atlanta, but jobs are Summer 2027 -> no rule
    # for the term -> reject. (Also no dashboard, no LLM.)
    cfg = _user_cfg(terms=["Fall 2026"],
                    rules=[{"when": {"term": ["Fall 2026"]},
                            "accept_if_any": [
                                {"location_matches": ["new york"]}]}])
    _wire(monkeypatch, sources, {"ok-src": OkAdapter}, [cfg])
    _freeze_clock(monkeypatch)

    rc1, state_file = _run(monkeypatch, tmp_path, ["--seed"])
    assert rc1 == 0
    rc2, _ = _run(monkeypatch, tmp_path)
    assert rc2 == 0

    state = st.load_state(state_file)
    assert st.outbox_items(state, "example") == []
    assert st.matches_items(state, "example") == []
    for i in (1, 2):
        assert not st.was_notified(state, _key(i), "example")


# ------------------------------------------------- LLM cost guard defers excess

def test_llm_cost_guard_defers_excess_and_retries_next_run(monkeypatch, tmp_path):
    # 3 ambiguous jobs (unknown term, policy=llm), cap of 2 per run.
    listed = [_job(i, term=None) for i in (1, 2, 3)]

    class OkAdapter:
        def __init__(self, cfg): pass
        def fetch(self, client, today): return list(listed)

    sources = [SourceConfig(name="ok-src", adapter="a")]
    cfg = _user_cfg(terms=["Summer 2027"])
    cfg["unknown_term_policy"] = "llm"
    cfg["llm"] = {"enabled": True, "provider": "gemini",
                  "tasks": ["term_inference", "top_company_judgment",
                            "atlanta_metro_judgment"],
                  "max_jobs_per_run": 2}
    _wire(monkeypatch, sources, {"ok-src": OkAdapter}, [cfg])
    _freeze_clock(monkeypatch)
    monkeypatch.setenv("GEMINI_API_KEY", "k")

    classified = []

    def fake_classify(batch, top_def, terms, llm_cfg):
        classified.append([j.dedup_key for j in batch])
        # resolve every job in the batch to Summer 2027 -> accept-always
        return {j.dedup_key: {"term": "Summer 2027"} for j in batch}

    monkeypatch.setattr(main, "classify", fake_classify)

    # pre-seed an unrelated entry so this is NOT a first run (no seed-only path):
    # the 3 ambiguous jobs are all genuinely new and reach the LLM stage.
    state_file = tmp_path / "seen.json"
    pre = st.empty_state()
    st.touch(pre, "jr:preexisting", ["ok-src"], TODAY)
    st.save_state(pre, state_file)

    rc2 = main.main(["--state-file", str(state_file)])
    assert rc2 == 0

    state = st.load_state(state_file)
    # first real run classified exactly the cap (2); the 3rd stayed pending
    assert len(classified) == 1 and len(classified[0]) == 2
    assert len(st.pending_keys(state, "example")) == 1

    # the 2 that classified this run accepted and emailed (12:00 slot due, no
    # prior email) -> notified; the deferred one is still pending, not lost.
    deferred = (st.pending_keys(state, "example")).pop()
    for j in listed:
        if j.dedup_key != deferred:
            assert st.was_notified(state, j.dedup_key, "example")

    # next run: nothing new from sources, but the deferred job is re-fed and
    # classified now. It accepts and lands in the outbox; the 12:00 slot was
    # already consumed by run 2's email, so it waits there rather than being
    # lost. Either way it is no longer pending.
    rc3, _ = _run(monkeypatch, tmp_path)
    assert rc3 == 0
    state = st.load_state(state_file)
    assert st.pending_keys(state, "example") == set()
    outbox_keys = {it["key"] for it in st.outbox_items(state, "example")}
    assert deferred in outbox_keys or st.was_notified(state, deferred, "example")
    # exactly 3 jobs classified across the two runs (2 then 1), none repeated
    assert sorted(k for b in classified for k in b) == sorted(
        j.dedup_key for j in listed)


# --------------------------------------------------- outbox/state JSON roundtrip

def test_state_outbox_roundtrips_through_save_load(monkeypatch, tmp_path):
    class OkAdapter:
        def __init__(self, cfg): pass
        def fetch(self, client, today): return [_job(1)]

    sources = [SourceConfig(name="ok-src", adapter="a")]
    cfg = _user_cfg()
    # hold the match in the outbox: pick a clock with no send slot since seed.
    _wire(monkeypatch, sources, {"ok-src": OkAdapter}, [cfg])

    sent = []
    monkeypatch.setattr(main, "send_email",
                        lambda *a, **k: sent.append(a) or True)

    # First run at 06:00 UTC seeds; we then advance so the job notifies. To
    # keep the match parked in the outbox instead, set last_email to NOW so no
    # slot is due, then verify the parked item survives a save/load roundtrip.
    _freeze_clock(monkeypatch, now=dt.datetime(2026, 6, 12, 6, 0,
                                               tzinfo=dt.UTC))
    rc1, state_file = _run(monkeypatch, tmp_path, ["--seed"])
    assert rc1 == 0

    # mark an email "just sent" so the upcoming run's 06:00 slot isn't due
    pre = st.load_state(state_file)
    st.set_last_email(pre, "example",
                      dt.datetime(2026, 6, 12, 5, 30, tzinfo=dt.UTC))
    st.save_state(pre, state_file)

    # add a brand new listed job and run: it accepts, lands in the outbox, but
    # no slot is due so it is NOT emailed.
    monkeypatch.setattr(OkAdapter, "fetch",
                        lambda self, client, today: [_job(1), _job(2)])
    rc2, _ = _run(monkeypatch, tmp_path)
    assert rc2 == 0
    assert sent == []                                   # no slot due

    state = st.load_state(state_file)
    box = st.outbox_items(state, "example")
    assert len(box) == 1 and box[0]["key"] == _key(2)

    # the outbox snapshot round-trips unchanged through save_state/load_state
    st.save_state(state, tmp_path / "again.json")
    reloaded = st.load_state(tmp_path / "again.json")
    assert st.outbox_items(reloaded, "example") == box
    assert reloaded["jobs"] == state["jobs"]

# ------------------------------------------ cross-source url dedup end-to-end

def test_cross_source_url_dupe_reaches_outbox_once(monkeypatch, tmp_path):
    """Two greenhouse host variants of one req, from two sources, both accepted:
    only one is delivered (outbox) and the other is marked notified + dup_of,
    never building a second outbox/matches row."""
    from src.models import Job

    def _gh(key, host):
        return Job(company="Cloudflare", title="Software Engineer Intern",
                   url=f"https://{host}/cloudflare/jobs/8052785",
                   source="ok-src", terms=["Summer 2027"],
                   term_confidence="explicit", locations=["Austin, TX"])

    class BoardsAdapter:
        def __init__(self, cfg): pass
        def fetch(self, client, today):
            return [_gh(1, "boards.greenhouse.io")]

    class JobBoardsAdapter:
        def __init__(self, cfg): pass
        def fetch(self, client, today):
            return [_gh(2, "job-boards.greenhouse.io")]

    sources = [SourceConfig(name="boards-src", adapter="a"),
               SourceConfig(name="jobboards-src", adapter="a")]
    _wire(monkeypatch, sources,
          {"boards-src": BoardsAdapter, "jobboards-src": JobBoardsAdapter},
          [_user_cfg()])
    _freeze_clock(monkeypatch)

    # not a first run: pre-seed an unrelated entry.
    state_file = tmp_path / "seen.json"
    pre = st.empty_state()
    st.touch(pre, "jr:preexisting", ["x"], TODAY)
    st.save_state(pre, state_file)

    rc = main.main(["--state-file", str(state_file)])
    assert rc == 0
    state = st.load_state(state_file)

    # Exactly one variant survived the gate (NOW hits the 12:00 send slot, so
    # the outbox has already flushed): the other is recorded as its dup_of and
    # the index maps the shared canon to the survivor, never the suppressed key.
    survivor = st.url_index_get(state, "ats:gh:8052785")
    assert survivor is not None
    dups = {k: v["dup_of"] for k, v in state["jobs"].items() if "dup_of" in v}
    assert len(dups) == 1
    (suppressed, points_to), = dups.items()
    assert points_to == survivor
    assert "dup_of" not in state["jobs"][survivor]


# ------------------------------------- JD-body term inference before the LLM

def test_jd_term_inference_resolves_unknown_terms_before_the_llm(monkeypatch, tmp_path):
    # Three title-only-unknown jobs. Two carry a JD body already (as ATS
    # boards deliver it); the third has none. Only the third reaches the LLM.
    listed = [_job(i, term=None) for i in (1, 2, 3)]
    for job in listed:
        job.term_confidence = "unknown"
    # Dated: a yearless "summer internship" read in June is ambiguous by
    # design (unknown -> LLM), so this one names its start.
    listed[0].description = "This 12-week internship starts in June 2027."
    listed[1].description = "Internship dates: May-August 2027. Pursuing a BS degree."

    class OkAdapter:
        def __init__(self, cfg): pass
        def fetch(self, client, today): return list(listed)

    sources = [SourceConfig(name="ok-src", adapter="a")]
    cfg = _user_cfg(terms=["Summer 2027"])
    cfg["unknown_term_policy"] = "llm"
    cfg["llm"] = {"enabled": True, "provider": "gemini",
                  "tasks": ["term_inference"], "max_jobs_per_run": 10}
    _wire(monkeypatch, sources, {"ok-src": OkAdapter}, [cfg])
    _freeze_clock(monkeypatch)
    monkeypatch.setenv("GEMINI_API_KEY", "k")

    classified: list[str] = []

    def fake_classify(batch, top_def, terms, llm_cfg):
        classified.extend(j.dedup_key for j in batch)
        return {j.dedup_key: {"term": "Summer 2027"} for j in batch}

    monkeypatch.setattr(main, "classify", fake_classify)
    state_file = tmp_path / "seen.json"
    pre = st.empty_state()
    st.touch(pre, "jr:preexisting", ["ok-src"], TODAY)
    st.save_state(pre, state_file)

    assert main.main(["--state-file", str(state_file)]) == 0

    assert classified == [_key(3)]
    state = st.load_state(state_file)
    for i in (1, 2, 3):
        assert st.was_notified(state, _key(i), "example")


def test_infer_terms_from_jds_only_touches_unknown_terms_with_a_jd():
    known = _job(1)                                   # title term: untouched
    known.description = "Our Fall 2027 co-op."
    no_jd = _job(2, term=None)                        # nothing to read
    jd = _job(3, term=None)
    jd.description = "Start date: January 11, 2027."
    jd.date_posted = dt.date(2026, 10, 1)
    assert main.infer_terms_from_jds([known, no_jd, jd], TODAY) == 1
    assert known.terms == ["Summer 2027"]
    assert no_jd.terms == []
    assert (jd.terms, jd.term_confidence) == (["Spring 2027"], "inferred")


# ------------------------- a JD-derived term may only accept, never reject

def _jd_llm_run(monkeypatch, tmp_path, llm_term, terms=None, rules=None):
    """One run with a single job whose JD says Fall 2027 while the user wants
    Summer 2027; the fake LLM answers `llm_term`. Returns (state, payloads)."""
    job = _job(1, term=None)
    job.term_confidence = "unknown"
    job.description = "Join our Fall 2027 internship program in Atlanta."

    class OkAdapter:
        def __init__(self, cfg): pass
        def fetch(self, client, today): return [job]

    cfg = _user_cfg(terms=terms or ["Summer 2027"], rules=rules)
    cfg["unknown_term_policy"] = "llm"
    cfg["llm"] = {"enabled": True, "provider": "gemini",
                  "tasks": ["term_inference"], "max_jobs_per_run": 10}
    _wire(monkeypatch, [SourceConfig(name="ok-src", adapter="a")],
          {"ok-src": OkAdapter}, [cfg])
    _freeze_clock(monkeypatch)
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    batches: list[list[Job]] = []

    def fake_classify(batch, top_def, wanted, llm_cfg):
        batches.append(list(batch))
        return {j.dedup_key: {"term": llm_term} for j in batch}

    monkeypatch.setattr(main, "classify", fake_classify)
    state_file = tmp_path / "seen.json"
    pre = st.empty_state()
    st.touch(pre, "jr:preexisting", ["ok-src"], TODAY)
    st.save_state(pre, state_file)
    assert main.main(["--state-file", str(state_file)]) == 0
    return st.load_state(state_file), batches


def test_unwanted_jd_term_goes_to_the_llm_and_its_summer_verdict_accepts(monkeypatch, tmp_path):
    state, batches = _jd_llm_run(monkeypatch, tmp_path, "Summer 2027")
    # Without the accept-only rule this was a permanent term-not-wanted.
    assert [j.dedup_key for b in batches for j in b] == [_key(1)]
    assert st.was_notified(state, _key(1), "example")


def test_unwanted_jd_term_with_a_null_llm_verdict_uses_the_every_wanted_term_fallback(
        monkeypatch, tmp_path):
    # Every wanted term (just Summer 2027) accepts -> the fallback accepts.
    state, _ = _jd_llm_run(monkeypatch, tmp_path, None)
    assert st.was_notified(state, _key(1), "example")


def test_jd_term_stage_verdicts():
    from pathlib import Path

    from src.filters import UserFilter
    cfg = _user_cfg(terms=["Summer 2027", "Spring 2028"])   # Spring 2028 has no rule
    cfg["unknown_term_policy"] = "llm"
    cfg["llm"] = {"enabled": True, "tasks": ["term_inference"]}
    uf = UserFilter(cfg, Path(__file__).parents[1], today=TODAY)
    uf.llm_enabled = True

    def jd_job(term):
        j = _job(1, term=term)
        j.terms_from_jd = True
        return j

    # wanted JD term: proceeds to the rules as before
    assert uf.evaluate(jd_job("Summer 2027")).status == "accept"
    # unwanted JD term: unknown-term, handed to the LLM
    first = uf.evaluate(jd_job("Fall 2027"))
    assert (first.status, first.reasons) == ("ambiguous", ["unknown-term"])
    assert "term" in first.needs
    # LLM null: every-wanted-term fallback; Spring 2028 has no rule -> unresolved
    second = uf.evaluate(jd_job("Fall 2027"), llm_facts={"term": None})
    assert (second.status, second.reasons) == ("reject", ["term-unresolved"])
    # the same term from title/source data keeps rejecting as term-not-wanted
    source = uf.evaluate(_job(1, term="Fall 2027"))
    assert (source.status, source.reasons) == ("reject", ["term-not-wanted"])


def _two_user_run(monkeypatch, tmp_path, order):
    """JD says Fall 2027; one user wants Summer 2027 (its LLM says Summer),
    the other wants Fall 2027. Users run in `order`."""
    job = _job(1, term=None)
    job.term_confidence = "unknown"
    job.description = "Join our Fall 2027 internship program in Atlanta."

    class OkAdapter:
        def __init__(self, cfg): pass
        def fetch(self, client, today): return [job]

    def cfg_for(name, term):
        cfg = _user_cfg(name=name, terms=[term],
                        rules=[{"when": {"term": [term]}, "accept_if_any": [{"always": True}]}])
        cfg["unknown_term_policy"] = "llm"
        cfg["llm"] = {"enabled": True, "provider": "gemini",
                      "tasks": ["term_inference"], "max_jobs_per_run": 10}
        return cfg

    users = {"summer": cfg_for("summer", "Summer 2027"), "fall": cfg_for("fall", "Fall 2027")}
    _wire(monkeypatch, [SourceConfig(name="ok-src", adapter="a")],
          {"ok-src": OkAdapter}, [users[n] for n in order])
    _freeze_clock(monkeypatch)
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    monkeypatch.setattr(main, "classify", lambda batch, *a: {
        j.dedup_key: {"term": "Summer 2027"} for j in batch})
    state_file = tmp_path / "seen.json"
    pre = st.empty_state()
    st.touch(pre, "jr:preexisting", ["ok-src"], TODAY)
    st.save_state(pre, state_file)
    assert main.main(["--state-file", str(state_file)]) == 0
    return st.load_state(state_file)


def test_llm_term_replacing_a_jd_term_does_not_leak_to_other_users(monkeypatch, tmp_path):
    # The summer user's LLM verdict must not overwrite the shared job's JD
    # term for the fall user, whichever runs first.
    for order in (("summer", "fall"), ("fall", "summer")):
        state = _two_user_run(monkeypatch, tmp_path / "-".join(order), order)
        assert st.was_notified(state, _key(1), "summer"), order
        assert st.was_notified(state, _key(1), "fall"), order


def test_url_slug_terms_are_source_data_not_accept_only():
    job = _job(1, term=None, url="https://jobs.lever.co/acme/software-engineer-intern-fall-2027")
    job.description = "Build backend services with the platform team in Austin."
    assert main.infer_terms_from_jds([job], TODAY) == 1
    assert (job.terms, job.terms_from_jd) == (["Fall 2027"], False)
    jd = _job(2, term=None)
    jd.description = "Join our Fall 2027 internship program."
    main.infer_terms_from_jds([jd], TODAY)
    assert (jd.terms, jd.terms_from_jd) == (["Fall 2027"], True)
