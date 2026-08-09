"""Replay the real cross-source duplicate pairs observed in production through
the actual gate sequence (resolve -> url-index -> content) and assert each
posting is delivered exactly once. Each case names the layer that must catch
it, so a regression that shifts the catch to a weaker layer is visible.
"""

import datetime as dt

from src import main
from src import state as st
from src.models import Job

TODAY = dt.date(2026, 8, 1)
TERMS = ["Fall 2026", "Spring 2027", "Summer 2027"]


class _StubResolver:
    """Returns the real employer url for a jobright id, mimicking a logged-in
    JobrightSession. `None` for ids not in the map (resolution miss)."""

    def __init__(self, mapping):
        self.mapping = mapping

    def resolve_apply_url(self, jr_id):
        return self.mapping.get(jr_id)


def _job(key, url, term=None, locs=None, jr=None, source="ats-boards",
         company="C", title="SWE Intern"):
    j = Job(company=company, title=title, url=url, source=source,
            jobright_id=jr, terms=[term] if term else [],
            locations=locs or [])
    j.dedup_key = key
    return j


def _run(state, jobs, resolver, user="u"):
    """The real accepted-job gate sequence from process_user."""
    accepted = [(j, ["always"]) for j in jobs]
    main._resolve_employer_urls(accepted, state, resolver)
    accepted = main._drop_url_dupes(state, user, accepted, TERMS, TODAY)
    accepted = main._drop_content_dupes(state, user, accepted, TERMS, TODAY)
    return [j.dedup_key for j, _ in accepted]


def test_appian_term_divergence_triple():
    # jobright (Unknown term) + greenhouse mirror + custom-domain, one req.
    res = _StubResolver({"a" * 24:
                         "https://job-boards.greenhouse.io/appian/jobs/8041237"})
    jobs = [
        _job("jr:appian", "https://jobright.ai/jobs/info/" + "a" * 24, jr="a" * 24,
             source="jobright-swe"),
        _job("url:gh", "https://job-boards.greenhouse.io/appian/jobs/8041237",
             term="Summer 2027", locs=["Reston, VA"]),
        _job("url:custom",
             "https://careers.appian.com/jobs/8041237-software-engineering-intern",
             term="Summer 2027", locs=["Reston, VA"]),
    ]
    kept = _run(st.empty_state(), jobs, res)
    assert len(kept) == 1, kept   # all three collapse via ats:gh:8041237


def test_cloudflare_location_bucket_divergence():
    res = _StubResolver({"c" * 24:
                         "https://boards.greenhouse.io/cloudflare/jobs/8052785"})
    jobs = [
        _job("url:boards",
             "https://boards.greenhouse.io/cloudflare/jobs/8052785",
             term="Fall 2026", locs=["In-Office"]),
        _job("jr:cf", "https://jobright.ai/jobs/info/" + "c" * 24, jr="c" * 24,
             source="jobright-swe"),
        _job("url:jobboards",
             "https://job-boards.greenhouse.io/cloudflare/jobs/8052785",
             term="Fall 2026", locs=["Austin, TX"]),
    ]
    kept = _run(st.empty_state(), jobs, res)
    assert len(kept) == 1, kept


def test_tower_multicity_resolution_succeeds():
    res = _StubResolver({"t" * 24:
                         "https://www.tower-research.com/open-positions?gh_jid=8024128"})
    jobs = [
        _job("url:tower",
             "https://www.tower-research.com/open-positions?gh_jid=8024128",
             term="Summer 2027", locs=["Chicago, IL", "New York, NY"]),
        _job("jr:tower", "https://jobright.ai/jobs/info/" + "t" * 24, jr="t" * 24,
             source="jobright-swe"),
    ]
    kept = _run(st.empty_state(), jobs, res)
    assert len(kept) == 1, kept   # ats:gh:8024128


def test_tower_multicity_resolution_fails_content_backstop():
    # Same pair, but resolution misses -> the jobright url stays jobright, so
    # the url-index can't join. The content layer must catch it via bucket
    # intersection (multi-city us-il set vs jobright's us-ny).
    res = _StubResolver({})   # miss
    jobs = [
        _job("url:tower",
             "https://www.tower-research.com/open-positions?gh_jid=8024128",
             term="Summer 2027", locs=["Chicago, IL", "New York, NY"]),
        _job("jr:tower", "https://jobright.ai/jobs/info/" + "t" * 24, jr="t" * 24,
             source="jobright-swe", term="Summer 2027", locs=["New York, NY"]),
    ]
    kept = _run(st.empty_state(), jobs, res)
    assert len(kept) == 1, kept


def test_akuna_www_variant_no_ats_id():
    # No stable ATS id -> fallback string joins www/scheme variants.
    jobs = [
        _job("url:www", "https://www.akunacapital.com/careers/job/8021481",
             term="Summer 2027", locs=["Chicago, IL"]),
        _job("url:bare", "https://akunacapital.com/careers/job/8021481",
             term="Summer 2027", locs=["Chicago, IL"]),
    ]
    kept = _run(st.empty_state(), jobs, _StubResolver({}))
    assert len(kept) == 1, kept


def test_zipline_path_variant_same_gh_jid():
    jobs = [
        _job("url:careers", "https://www.zipline.com/careers?gh_jid=7780103003",
             term="Summer 2027", locs=["South San Francisco, CA"]),
        _job("url:roles", "https://www.zipline.com/open-roles?gh_jid=7780103003",
             term="Summer 2027", locs=["South San Francisco, CA"]),
    ]
    kept = _run(st.empty_state(), jobs, _StubResolver({}))
    assert len(kept) == 1, kept


def test_vanshb03_jr_keyed_employer_url_no_resolver_needed():
    # A jr:-keyed row whose url is already the employer link registers at the
    # gate for free; the ATS twin joins it with no resolver call.
    jobs = [
        _job("jr:vansh", "https://jobs.lever.co/acme/"
             "bdcfb29f-4f27-42de-933f-7f83a359b9f0",
             term="Summer 2027", locs=["Remote"], jr="v" * 24,
             source="vanshb03-2027"),
        _job("url:lever", "https://jobs.lever.co/acme/"
             "bdcfb29f-4f27-42de-933f-7f83a359b9f0",
             term="Summer 2027", locs=["Remote"]),
    ]
    kept = _run(st.empty_state(), jobs, None)   # no resolver at all
    assert len(kept) == 1, kept


def test_two_run_sequence_ats_then_jobright_mirror():
    # Run 1 delivers the ATS row; run 2's jobright mirror is suppressed by the
    # cross-run url-index once the ATS delivery is owned by the user.
    state = st.empty_state()
    res = _StubResolver({"c" * 24:
                         "https://boards.greenhouse.io/cloudflare/jobs/8052785"})
    ats = _job("url:boards",
               "https://boards.greenhouse.io/cloudflare/jobs/8052785",
               term="Fall 2026", locs=["Austin, TX"])
    kept1 = _run(state, [ats], res)
    assert kept1 == ["url:boards"]
    # Record the delivery the way process_user would (dashboard match).
    st.matches_add(state, "u", {"key": "url:boards",
                                "url": ats.url, "added": "2026-08-01"})
    jr = _job("jr:cf", "https://jobright.ai/jobs/info/" + "c" * 24, jr="c" * 24,
              source="jobright-swe")
    kept2 = _run(state, [jr], res)
    assert kept2 == []
    assert st.was_notified(state, "jr:cf", "u")


def test_seeded_state_suppresses_ats_rearrival():
    # A job delivered before this feature (only in matches) must suppress a
    # later ATS re-arrival once the index is seeded.
    state = st.empty_state()
    state["matches"]["u"] = [{
        "key": "jr:old", "added": "2026-06-01",
        "url": "https://boards.greenhouse.io/cloudflare/jobs/8052785"}]
    st.seed_url_index(state)
    st.mark_notified(state, "jr:old", "u")
    ats = _job("url:new",
               "https://job-boards.greenhouse.io/cloudflare/jobs/8052785",
               term="Fall 2026", locs=["Austin, TX"])
    kept = _run(state, [ats], _StubResolver({}))
    assert kept == []
    assert st.was_notified(state, "url:new", "u")


def test_boeing_workday_three_forms_one_requisition():
    # One Boeing requisition arriving as three Workday URL forms (exposed
    # EXTERNAL_CAREERS / en-US details / INTERN career-site) from different
    # feeds. The trailing _JR<reqid> slug collapses all three to
    # ats:wd:boeing:JR2026520976, so only the first arrival is delivered.
    base = ("Boeing-Summer-2027-Internship-Program--Paid----"
            "Data-Analytics-Intern_JR2026520976")
    jobs = [
        _job("url:wd-external",
             "https://boeing.wd1.myworkdayjobs.com/EXTERNAL_CAREERS/job/"
             "USA---Everett-WA/" + base,
             term="Summer 2027", locs=["Everett, WA"], company="Boeing",
             title="Data Analytics Intern (Summer 2027)"),
        _job("url:wd-details",
             "https://boeing.wd1.myworkdayjobs.com/en-US/EXTERNAL_CAREERS/"
             "details/" + base + "-1",
             term="Summer 2027", locs=["Everett, WA"], company="Boeing",
             title="Data Analytics Intern (Summer 2027)"),
        _job("url:wd-intern",
             "https://boeing.wd1.myworkdayjobs.com/INTERN/job/"
             "USA---Everett-WA/" + base,
             term="Summer 2027", locs=["Everett, WA"], company="Boeing",
             title="Data Analytics Intern (Summer 2027)"),
    ]
    kept = _run(st.empty_state(), jobs, _StubResolver({}))
    assert kept == ["url:wd-external"], kept   # ats:wd:boeing:JR2026520976


def test_amazon_apply_vs_en_jobs_same_reqid():
    # Amazon serves the same req at both /en/jobs/<digits>/ and the bare
    # /jobs/<digits>/apply form; both normalize to ats:amazon:10412530.
    jobs = [
        _job("url:amz-en",
             "https://www.amazon.jobs/en/jobs/10412530/"
             "software-development-engineer-internship-2026",
             term="Summer 2027", locs=["Seattle, WA"], company="Amazon",
             title="Software Development Engineer Internship"),
        _job("url:amz-apply", "https://amazon.jobs/jobs/10412530/apply",
             term="Summer 2027", locs=["Seattle, WA"], company="Amazon",
             title="Software Development Engineer Internship"),
    ]
    kept = _run(st.empty_state(), jobs, _StubResolver({}))
    assert kept == ["url:amz-en"], kept   # ats:amazon:10412530


def test_workable_apply_suffix_doubling():
    # The trailing /apply suffix on a Workable posting must not mint a second
    # identity; both forms collapse to ats:workable:altom-transport:1E3C4A9408.
    jobs = [
        _job("url:wk",
             "https://apply.workable.com/altom-transport/j/1E3C4A9408",
             term="Summer 2027", locs=["Atlanta, GA"], company="Altom Transport",
             title="Software Engineer Intern"),
        _job("url:wk-apply",
             "https://apply.workable.com/altom-transport/j/1E3C4A9408/apply",
             term="Summer 2027", locs=["Atlanta, GA"], company="Altom Transport",
             title="Software Engineer Intern"),
    ]
    kept = _run(st.empty_state(), jobs, _StubResolver({}))
    assert kept == ["url:wk"], kept
