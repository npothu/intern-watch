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

    # not a first run: pre-seed an unrelated entry. It names the jobs' source
    # so that source counts as already known (not first sight, src/seeding.py).
    state_file = tmp_path / "seen.json"
    pre = st.empty_state()
    st.touch(pre, "jr:preexisting", ["ok-src"], TODAY)
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

def _jd_llm_run(monkeypatch, tmp_path, llm_term, terms=None, rules=None, snapshots=None):
    """One run with a single job whose JD says Fall 2027 while the user wants
    Summer 2027; the fake LLM answers `llm_term`. Returns (state, payloads).
    `snapshots`, when a list, collects the delivered match items."""
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
    if snapshots is not None:
        from src.notify import match_item
        real_notify = main._notify_email

        def capture(user_cfg, accepted, state, dry_run, now, terms_order, *rest):
            snapshots.extend(match_item(j, r, terms_order) for j, r in accepted)
            return real_notify(user_cfg, accepted, state, dry_run, now, terms_order, *rest)

        monkeypatch.setattr(main, "_notify_email", capture)
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


def _fall_jd_filter():
    """Grok's repro: wants Spring/Summer/Fall 2027; Summer accepts anything,
    Fall needs top company / Atlanta / remote. The job's JD says Fall 2027
    and it is in Austin."""
    from pathlib import Path

    from src.filters import UserFilter
    cfg = _user_cfg(terms=["Spring 2027", "Summer 2027", "Fall 2027"])
    del cfg["rules"]
    cfg["term_rules"] = {"Spring": "top_atl_remote", "Summer": "anything",
                         "Fall": "top_atl_remote"}
    cfg["unknown_term_policy"] = "llm"
    cfg["llm"] = {"enabled": True, "tasks": ["term_inference", "top_company_judgment"]}
    uf = UserFilter(cfg, Path(__file__).parents[1], today=TODAY)
    uf.llm_enabled = True
    job = _job(1, term="Fall 2027")
    job.terms_from_jd = True
    job.locations = ["Austin, TX"]
    return uf, job


def test_wanted_jd_term_is_not_moved_by_a_cached_llm_term_not_top():
    uf, job = _fall_jd_filter()
    first = uf.evaluate(job)
    assert first.status == "ambiguous" and first.needs == ["top_company"]
    # Another user's term question cached Summer 2027 for this job.
    final, judged = main._finalize(uf, job, {"term": "Summer 2027", "is_top_company": False,
                                             "in_atlanta_metro": False})
    assert judged.terms == ["Fall 2027"]
    assert final.status == "reject"     # judged as Fall: not top, not Atlanta
    assert job.terms == ["Fall 2027"] and job.terms_from_jd


def test_wanted_jd_term_is_not_moved_by_a_cached_llm_term_top():
    uf, job = _fall_jd_filter()
    final, judged = main._finalize(uf, job, {"term": "Winter 2027", "is_top_company": True,
                                             "in_atlanta_metro": False})
    assert judged.terms == ["Fall 2027"]
    assert final.status == "accept"     # kept as Fall, the top-company verdict decides


def test_term_unknown_accept_delivers_no_jd_term(monkeypatch, tmp_path):
    # LLM null -> every-wanted-term fallback accepts; the delivered snapshot
    # must say unknown, not the Fall 2027 JD guess this user did not want.
    items: list[dict] = []
    state, _ = _jd_llm_run(monkeypatch, tmp_path, None, snapshots=items)
    assert st.was_notified(state, _key(1), "example")
    assert [it.get("term") for it in items] == ["Unknown term"]     # not "Fall 2027"


def test_llm_summer_accept_delivers_the_llm_term(monkeypatch, tmp_path):
    items: list[dict] = []
    _jd_llm_run(monkeypatch, tmp_path, "Summer 2027", snapshots=items)
    assert [it.get("term") for it in items] == ["Summer 2027"]


def test_per_user_copies_are_deep():
    from src.dedupe import _merge_pair
    uf, job = _fall_jd_filter()
    uf.terms_wanted = {"Summer 2027"}            # make the JD term unwanted
    _, judged = main._finalize(uf, job, {"term": "Summer 2027"})
    assert judged is not job and judged.locations is not job.locations
    _merge_pair(judged, _job(2, term="Summer 2027"))   # a later URL merge
    assert job.locations == ["Austin, TX"]
    delivered = main._delivered(uf, job)
    assert delivered.term_display_unknown and delivered.terms == job.terms
    assert delivered.locations is not job.locations and not job.term_display_unknown


def test_unknown_term_snapshot_does_not_wildcard_content_dedup(monkeypatch, tmp_path):
    """Run 1 delivers the Fall-JD job to a summer-only user as "Unknown
    term" (LLM null -> fallback). Run 2 brings an explicit Summer 2027
    posting of the same company and title: it must still be delivered. An
    "Unknown term" content signature would wildcard-suppress it."""
    items: list[dict] = []
    state, _ = _jd_llm_run(monkeypatch, tmp_path, None, snapshots=items)
    assert [it["term"] for it in items] == ["Unknown term"]
    summer = Job(company="Company1", title="Software Engineer Intern",
                 url="https://x.com/summer-posting", source="ok-src",
                 terms=["Summer 2027"], term_confidence="explicit",
                 locations=["Atlanta, GA"])

    class Run2:
        def __init__(self, cfg): pass
        def fetch(self, client, today): return [summer]

    monkeypatch.setattr(main, "make_adapter", lambda cfg: Run2(cfg))
    assert main.main(["--state-file", str(tmp_path / "seen.json")]) == 0
    state = st.load_state(tmp_path / "seen.json")
    key = dedup_key(summer)
    # Run 1 used the 12:00 email slot, so the match waits in the outbox.
    assert key in {it["key"] for it in st.outbox_items(state, "example")} \
        or st.was_notified(state, key, "example")


# ------------------------------------------------ JD-fetch cap leaves pending

def test_jd_cap_overflow_stays_pending_unevaluated_then_decides(
        monkeypatch, tmp_path):
    import httpx
    listed = [_job(i) for i in (1, 2, 3)]
    for j in listed:
        j.jd_url = f"https://api.example/jd/{j.url.rsplit('/', 1)[1]}"

    class OkAdapter:
        def __init__(self, cfg): pass
        def fetch(self, client, today): return [j.model_copy() for j in listed]

    sources = [SourceConfig(name="ok-src", adapter="a")]
    _wire(monkeypatch, sources, {"ok-src": OkAdapter}, [_user_cfg()])
    _freeze_clock(monkeypatch)
    monkeypatch.setattr(main, "JD_FETCH_CAP", 2)
    fetched = []
    real = httpx.Client

    def handler(req):
        fetched.append(str(req.url))
        return httpx.Response(200, json={"content": "<p>Paid internship.</p>"})

    monkeypatch.setattr(main.httpx, "Client", lambda **kw: real(
        transport=httpx.MockTransport(handler), **kw))

    state_file = tmp_path / "seen.json"
    pre = st.empty_state()
    st.touch(pre, "jr:preexisting", ["ok-src"], TODAY)
    st.save_state(pre, state_file)

    assert main.main(["--state-file", str(state_file)]) == 0
    state = st.load_state(state_file)
    assert len(fetched) == 2
    waiting = st.pending_keys(state, "example")
    assert len(waiting) == 1
    (late,) = waiting
    # not evaluated: neither delivered nor queued
    assert not st.was_notified(state, late, "example")
    assert late not in {it["key"] for it in st.outbox_items(state, "example")}

    # next run: no new jobs, the pending one gets its JD and is decided
    assert main.main(["--state-file", str(state_file)]) == 0
    state = st.load_state(state_file)
    assert len(fetched) == 3
    assert st.pending_keys(state, "example") == set()
    assert (st.was_notified(state, late, "example")
            or late in {it["key"] for it in st.outbox_items(state, "example")})


def test_enrich_jds_cap_takes_oldest_first_and_reports_the_rest(monkeypatch):
    import httpx
    jobs = [Job(company="c", title="Intern", url=f"https://x/{k}",
                jd_url=f"https://api.example/{k}", source="s") for k in "abc"]
    for j, k in zip(jobs, ("url:a", "url:b", "url:c"), strict=True):
        j.dedup_key = k
    state = st.empty_state()
    st.touch(state, "url:a", ["s"], TODAY)                         # newest
    st.touch(state, "url:b", ["s"], TODAY - dt.timedelta(days=5))  # oldest
    st.touch(state, "url:c", ["s"], TODAY - dt.timedelta(days=2))
    monkeypatch.setattr(main, "JD_FETCH_CAP", 2)
    real = httpx.Client
    monkeypatch.setattr(main.httpx, "Client", lambda **kw: real(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(200, json={"content": "jd"})), **kw))
    deferred: list[str] = []
    assert main.enrich_jds(jobs, state, deferred) == 2
    assert deferred == ["url:a"]
    assert jobs[0].description is None and jobs[1].description == "jd"


def _jd_cap_run(monkeypatch, tmp_path, feeds, cap=0,
                jd="<p>Paid internship.</p>"):
    """Run main once per entry of `feeds` (a list of job lists the stub
    source returns that run) with JD_FETCH_CAP=cap; returns the state."""
    import httpx
    run = {"i": 0}

    class Feed:
        def __init__(self, cfg): pass
        def fetch(self, client, today):
            return [j.model_copy() for j in feeds[run["i"]]]

    _wire(monkeypatch, [SourceConfig(name="ok-src", adapter="a")],
          {"ok-src": Feed}, [_user_cfg()])
    _freeze_clock(monkeypatch)
    real = httpx.Client
    monkeypatch.setattr(main.httpx, "Client", lambda **kw: real(
        transport=httpx.MockTransport(lambda r: httpx.Response(
            200, json={"content": jd})), **kw))
    state_file = tmp_path / "seen.json"
    pre = st.empty_state()
    st.touch(pre, "jr:preexisting", ["ok-src"], TODAY)
    st.save_state(pre, state_file)
    states = []
    for i, _ in enumerate(feeds):
        run["i"] = i
        monkeypatch.setattr(main, "JD_FETCH_CAP", cap if i == 0 else 80)
        assert main.main(["--state-file", str(state_file)]) == 0
        states.append(st.load_state(state_file))
    return states


def _delivered(state, key):
    return (st.was_notified(state, key, "example")
            or key in {it["key"] for it in st.outbox_items(state, "example")})


def test_jd_deferred_rows_twin_is_held_until_both_are_decided(
        monkeypatch, tmp_path):
    ats = _job(1, url="https://boards.greenhouse.io/acme/jobs/777")
    ats.jd_url = "https://boards-api.greenhouse.io/v1/boards/acme/jobs/777"
    twin = _job(2, url="https://job-boards.greenhouse.io/acme/jobs/777")
    twin.company = ats.company
    s1, s2 = _jd_cap_run(monkeypatch, tmp_path, [[ats, twin], [ats, twin]])
    ka, kt = dedup_key(ats), dedup_key(twin)
    assert ka != kt
    # run 1: the ATS row waits on its JD and its twin waits with it
    assert st.pending_keys(s1, "example") == {ka, kt}
    assert not _delivered(s1, ka) and not _delivered(s1, kt)
    # run 2: decided together, delivered once
    assert st.pending_keys(s2, "example") == set()
    # delivered once: one spelling survives, the other is its dup
    dups = {k: s2["jobs"][k].get("dup_of") for k in (ka, kt)}
    assert sorted(v is None for v in dups.values()) == [False, True]
    survivor = next(k for k, v in dups.items() if v is None)
    assert set(dups.values()) == {None, survivor}
    assert _delivered(s2, survivor)


def test_jd_deferred_row_that_vanishes_is_still_evaluated_on_relist(
        monkeypatch, tmp_path):
    job = _job(1, url="https://boards.greenhouse.io/acme/jobs/888")
    job.jd_url = "https://boards-api.greenhouse.io/v1/boards/acme/jobs/888"
    other = _job(2)
    s1, s2, s3 = _jd_cap_run(monkeypatch, tmp_path,
                             [[job], [other], [job]])
    key = dedup_key(job)
    assert key in st.pending_keys(s1, "example")
    assert key in st.pending_keys(s2, "example")      # gone, but not dropped
    assert key not in st.pending_keys(s3, "example")  # relisted: decided
    assert _delivered(s3, key)
    assert "jd_deferred" not in s3["jobs"][key]


def test_held_twin_is_decided_with_the_ats_jd_eliminations(
        monkeypatch, tmp_path):
    ats = _job(1, url="https://boards.greenhouse.io/acme/jobs/999")
    ats.jd_url = "https://boards-api.greenhouse.io/v1/boards/acme/jobs/999"
    twin = _job(2, url="https://job-boards.greenhouse.io/acme/jobs/999")
    twin.company = ats.company
    jd = ("<p>Candidates must hold an active TS/SCI security clearance at "
          "the time of application.</p>")
    s1, s2 = _jd_cap_run(monkeypatch, tmp_path, [[ats, twin], [ats, twin]],
                         jd=jd)
    ka, kt = dedup_key(ats), dedup_key(twin)
    assert st.pending_keys(s1, "example") == {ka, kt}
    # run 2: the ATS row is rejected by its JD, and the twin with it
    assert st.pending_keys(s2, "example") == set()
    assert not _delivered(s2, ka) and not _delivered(s2, kt)


def test_twin_takes_the_longest_jd_of_its_same_canon_rows():
    from src.filters import UserFilter
    from src.paths import ROOT
    url = "https://boards.greenhouse.io/acme/jobs/4242"
    blurb = _job(1, url=url)
    blurb.description = "Great internship."
    full = _job(2, url="https://job-boards.greenhouse.io/acme/jobs/4242")
    full.description = ("Great internship. Applicants must hold an active "
                        "TS/SCI security clearance.")
    twin = _job(3, url="https://boards.greenhouse.io/acme/jobs/4242?gh_src=x")
    uf = UserFilter(_user_cfg(), ROOT, today=TODAY)
    kept = main._apply_twin_jds(uf, [blurb, full, twin], [(twin, ["ok"])],
                                "example", TODAY)
    assert kept == []
    assert "TS/SCI" in (twin.description or "")
