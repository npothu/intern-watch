"""Cross-source identity regressions for the 2027 sources (canonical v4).

Two lists can spell one ATS posting differently: Workday site paths differ in
case (/Search/ vs /search/), numeric-only reqids carry a repost counter
(_7654321-1), and SmartRecruiters links carry an optional slug after the
posting id. Each spelling is its own dedup key (normalize_url, unchanged), so
the url_index canonical is what keeps the user from getting both.
"""

import datetime as dt
from pathlib import Path

import pytest

from src import main
from src import state as st
from src.dedupe import dedupe, most_restrictive_degrees
from src.filters import UserFilter
from src.models import Job
from src.normalize import canonical_url

TODAY = dt.date(2026, 11, 8)

# One live-shaped Workday posting as two lists spell it (synthetic tenant).
WD_LIST_A = ("https://acme.wd1.myworkdayjobs.com/search/job/Austin-TX/"
             "Widget-Systems-Intern_7654321-1")
WD_LIST_B = ("https://acme.wd1.myworkdayjobs.com/Search/job/Austin-TX/"
             "Widget-Systems-Intern_7654321-1")
WD_LIST_C = ("https://acme.wd1.myworkdayjobs.com/en-US/ur/job/Austin-TX/"
             "Widget-Systems-Intern_7654321")
SR_BARE = "https://jobs.smartrecruiters.com/AcmeCorp/744000147613769"
SR_SLUG = ("https://jobs.smartrecruiters.com/AcmeCorp/"
           "744000147613769-widget-systems-intern?oga=true")


@pytest.mark.parametrize("urls, token", [
    ((WD_LIST_A, WD_LIST_B, WD_LIST_C), "ats:wd:acme:7654321"),
    ((SR_BARE, SR_SLUG), "ats:sr:acmecorp:744000147613769"),
    (("https://acme.wd5.myworkdayjobs.com/EXT/job/X/AI-Intern_UNI4670-2",
      "https://acme.wd5.myworkdayjobs.com/ext/job/X/AI-Intern_UNI4670"),
     "ats:wd:acme:UNI4670"),
    (("https://jobs.smartrecruiters.com/AcmeCorp/"
      "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "https://jobs.smartrecruiters.com/AcmeCorp/"
      "3FA85F64-5717-4562-B3FC-2C963F66AFA6-widget-systems-intern"),
     "ats:sr:acmecorp:3fa85f64-5717-4562-b3fc-2c963f66afa6"),
    (("https://jobs.smartrecruiters.com/AcmeCorp/"
      "12345678-1111-2222-3333-444444444444",
      "https://jobs.smartrecruiters.com/AcmeCorp/"
      "12345678-1111-2222-3333-444444444444-widget-systems-intern"),
     "ats:sr:acmecorp:12345678-1111-2222-3333-444444444444"),
])
def test_variant_spellings_share_one_canonical(urls, token):
    assert {canonical_url(u) for u in urls} == {token}


def test_digit_leading_smartrecruiters_uuids_stay_distinct():
    # A UUID whose first group is all digits must not collapse to that
    # 8-digit prefix (which would also equal a numeric id with a slug).
    base = "https://jobs.smartrecruiters.com/AcmeCorp/"
    tokens = {canonical_url(base + "12345678-1111-2222-3333-444444444444"),
              canonical_url(base + "12345678-aaaa-bbbb-cccc-dddddddddddd"),
              canonical_url(base + "12345678-widget-systems-intern")}
    assert len(tokens) == 3
    assert canonical_url(base + "12345678-widget-systems-intern") \
        == "ats:sr:acmecorp:12345678"


@pytest.mark.parametrize("suffix", ["2027", "Summer-2027", "Intern2027",
                                    "2027-1", "1999"])
def test_year_like_workday_suffix_is_not_a_reqid(suffix):
    # Two different postings whose slugs merely end in a year must not share
    # a token (an ats: token is never rewritten by a later migration).
    a = canonical_url("https://acme.wd1.myworkdayjobs.com/Ext/job/X/"
                      f"Widget-Systems-Intern_{suffix}")
    b = canonical_url("https://acme.wd1.myworkdayjobs.com/Ext/job/X/"
                      f"Gadget-Analytics-Intern_{suffix}")
    assert a != b
    assert not a.startswith("ats:") and not b.startswith("ats:")


def test_existing_workday_tokens_unchanged():
    # R/JR reqids keep their v3 token (persisted url_index entries rely on it).
    assert canonical_url("https://acme.wd1.myworkdayjobs.com/Ext/job/X/"
                         "Title_R2026-4385-1") == "ats:wd:acme:R2026-4385"
    assert canonical_url("https://acme.wd5.myworkdayjobs.com/en-US/Ext/job/X/"
                         "Title_JR2027548") == "ats:wd:acme:JR2027548"


def test_workday_without_reqid_falls_back_case_insensitively():
    a = canonical_url("https://acme.wd1.myworkdayjobs.com/Ext/job/X/Title-2027")
    b = canonical_url("https://acme.wd1.myworkdayjobs.com/ext/job/x/title-2027")
    assert a == b and a is not None and a.startswith("https://")


def _job(url, source, title="Widget Systems Intern", degrees=None,
         salary=None):
    return Job(company="Acme", title=title, url=url, source=source,
               terms=["Summer 2027"], term_confidence="explicit",
               locations=["Austin, TX"], degrees=degrees or [], salary=salary)


def test_two_lists_same_posting_deliver_once():
    # Different dedup keys AND different titles (so content suppression
    # cannot help): the url_index canonical must fold them.
    a = _job(WD_LIST_A, "simplify")
    b = _job(WD_LIST_B, "zshah-2027", title="Widget System Intern")
    jobs = dedupe([a, b])
    assert len({j.dedup_key for j in jobs}) == 2       # keys stay distinct
    s = st.empty_state()
    kept = main._drop_url_dupes(s, "u", [(j, ["always"]) for j in jobs],
                                ["Summer 2027"], TODAY)
    assert len(kept) == 1
    loser = next(j for j in jobs if j.dedup_key != kept[0][0].dedup_key)
    assert st.was_notified(s, loser.dedup_key, "u")


def test_second_list_does_not_redeliver_across_runs():
    s = st.empty_state()
    first = dedupe([_job(SR_BARE, "simplify")])
    main._drop_url_dupes(s, "u", [(first[0], ["always"])], ["Summer 2027"], TODAY)
    st.mark_notified(s, first[0].dedup_key, "u")
    s["matches"]["u"] = [{"key": first[0].dedup_key, "url": SR_BARE}]
    later = dedupe([_job(SR_SLUG, "zshah-2027", title="Widget System Intern")])
    kept = main._drop_url_dupes(s, "u", [(later[0], ["always"])],
                                ["Summer 2027"], TODAY)
    assert kept == []


def test_migrate_v3_rekeys_numeric_workday_and_smartrecruiters():
    s = st.empty_state()
    s["_meta"]["url_index_version"] = 3
    st.touch(s, "url:wd", ["simplify"], TODAY)
    st.touch(s, "url:sr", ["simplify"], TODAY)
    s["url_index"] = {
        # v3 stored these as hardened URL strings (no ats: token)
        "https://acme.wd1.myworkdayjobs.com/search/job/Austin-TX/"
        "Widget-Systems-Intern_7654321-1": "url:wd",
        SR_BARE: "url:sr",
        "ats:wd:acme:R123456": "url:other",
    }
    assert st.migrate_url_index(s) == 2
    assert s["url_index"] == {"ats:wd:acme:7654321": "url:wd",
                              "ats:sr:acmecorp:744000147613769": "url:sr",
                              "ats:wd:acme:R123456": "url:other"}
    assert set(s["jobs"]) == {"url:wd", "url:sr"}      # dedup keys untouched
    assert s["jobs"]["url:wd"]["canon"] == "ats:wd:acme:7654321"
    assert st.migrate_url_index(s) == 0


def test_migrate_prefers_delivered_key_over_earlier_undelivered_one():
    # Two v3 url-string canons of one req: the earlier key was never
    # delivered, the later one was. The delivered key must own the token, so
    # a third spelling stays suppressed once the dashboard row is pruned.
    s = st.empty_state()
    s["_meta"]["url_index_version"] = 3
    st.touch(s, "url:early", ["simplify"], TODAY - dt.timedelta(days=10))
    st.touch(s, "url:delivered", ["zshah-2027"], TODAY)
    st.mark_notified(s, "url:delivered", "u")
    s["url_index"] = {
        "https://acme.wd1.myworkdayjobs.com/acme_careers/job/X/"
        "Widget-Systems-Intern_2026798": "url:early",
        "https://acme.wd1.myworkdayjobs.com/Acme_Careers/job/X/"
        "Widget-Systems-Intern_2026798": "url:delivered",
    }
    st.migrate_url_index(s)
    assert s["url_index"] == {"ats:wd:acme:2026798": "url:delivered"}
    assert s["matches"].get("u", []) == []          # no dashboard row left
    third = _job("https://acme.wd1.myworkdayjobs.com/en-US/Acme_Careers/job/X/"
                 "Widget-Systems-Intern_2026798-1", "speedyapply")
    third.dedup_key = "url:third"
    kept = main._drop_url_dupes(s, "u", [(third, ["always"])],
                                ["Summer 2027"], TODAY)
    assert kept == []
    assert s["jobs"]["url:third"]["dup_of"] == "url:delivered"


def _two_spellings_v3(s, early_key, late_key):
    s["_meta"]["url_index_version"] = 3
    st.touch(s, early_key, ["simplify"], TODAY - dt.timedelta(days=10))
    st.touch(s, late_key, ["zshah-2027"], TODAY)
    s["url_index"] = {
        "https://acme.wd1.myworkdayjobs.com/acme_careers/job/X/"
        "Widget-Systems-Intern_2026798": early_key,
        "https://acme.wd1.myworkdayjobs.com/Acme_Careers/job/X/"
        "Widget-Systems-Intern_2026798": late_key,
    }


def _third_spelling(key):
    j = _job("https://acme.wd1.myworkdayjobs.com/en-US/Acme_Careers/job/X/"
             "Widget-Systems-Intern_2026798-1", "speedyapply")
    j.dedup_key = key
    return j


def test_migrate_keeps_every_users_ownership_across_colliding_keys():
    # Bob was notified on the earlier key, Alice on the later one. Whichever
    # key survives, a later spelling must stay suppressed for BOTH users once
    # their dashboard rows are gone.
    s = st.empty_state()
    _two_spellings_v3(s, "url:early", "url:late")
    st.mark_notified(s, "url:early", "bob")
    st.mark_notified(s, "url:late", "alice")
    st.migrate_url_index(s)
    survivor = s["url_index"]["ats:wd:acme:2026798"]
    assert survivor == "url:early"          # both notified: earliest wins
    assert set(s["jobs"][survivor]["notified_for"]) == {"alice", "bob"}
    assert s["jobs"]["url:late"]["notified_for"] == ["alice"]   # untouched
    for user in ("alice", "bob"):
        kept = main._drop_url_dupes(s, user, [(_third_spelling(f"url:{user}-3"),
                                               ["always"])],
                                    ["Summer 2027"], TODAY)
        assert kept == [], user


def test_migrate_notified_key_beats_earlier_outbox_only_key():
    # An earlier key that is only queued in an outbox must not displace a
    # later key that was actually delivered; and the queued user still owns
    # the survivor after their outbox row is gone.
    s = st.empty_state()
    _two_spellings_v3(s, "url:queued", "url:sent")
    s["outbox"] = {"carol": [{"key": "url:queued"}]}
    st.mark_notified(s, "url:sent", "alice")
    st.migrate_url_index(s)
    assert s["url_index"]["ats:wd:acme:2026798"] == "url:sent"
    s["outbox"] = {}
    kept = main._drop_url_dupes(s, "carol", [(_third_spelling("url:c3"), ["always"])],
                                ["Summer 2027"], TODAY)
    assert kept == []


def test_migrate_does_not_cancel_a_pending_retry():
    # Dave's notification failed last run: his row is on matches and pending,
    # notified_for empty. Stamping him notified on the survivor would make the
    # pending sweep drop his retry, so the migration must leave him out.
    s = st.empty_state()
    _two_spellings_v3(s, "url:early", "url:late")
    st.mark_notified(s, "url:early", "alice")
    s["matches"] = {"dave": [{"key": "url:late"}]}
    st.set_pending(s, "url:late", "dave")
    st.migrate_url_index(s)
    assert s["url_index"]["ats:wd:acme:2026798"] == "url:early"
    assert s["jobs"]["url:early"]["notified_for"] == ["alice"]
    assert "dave" in s["jobs"]["url:late"]["pending"]
    assert not st.was_notified(s, "url:late", "dave")


def test_migrate_single_member_group_is_not_stamped():
    s = st.empty_state()
    s["_meta"]["url_index_version"] = 3
    st.touch(s, "url:only", ["simplify"], TODAY)
    s["matches"] = {"erin": [{"key": "url:only"}]}
    s["url_index"] = {SR_BARE: "url:only"}
    st.migrate_url_index(s)
    assert s["jobs"]["url:only"]["notified_for"] == []


def test_migrate_prefers_listed_key_when_nothing_notified():
    s = st.empty_state()
    s["_meta"]["url_index_version"] = 3
    st.touch(s, "url:early", ["simplify"], TODAY - dt.timedelta(days=10))
    st.touch(s, "url:queued", ["zshah-2027"], TODAY)
    s["outbox"] = {"u": [{"key": "url:queued"}]}
    s["url_index"] = {SR_BARE: "url:early", SR_SLUG: "url:queued"}
    st.migrate_url_index(s)
    assert s["url_index"] == {"ats:sr:acmecorp:744000147613769": "url:queued"}


# ------------------------------------------------------------ degrees

@pytest.mark.parametrize("a, b, want", [
    ([], ["Master's", "PhD"], ["Master's", "PhD"]),
    (["Master's", "PhD"], [], ["Master's", "PhD"]),
    (["Bachelor's", "Master's"], ["Master's"], ["Master's"]),
    # disjoint: the list that trips the stricter grad-only rule wins
    (["Master's"], ["PhD"], ["PhD"]),
    (["Bachelor's"], ["Master's"], ["Master's"]),
    (["Master's"], ["Bachelor's"], ["Master's"]),
    (["Bachelor's"], ["Associate's"], ["Bachelor's"]),  # equal: keep first
])
def test_most_restrictive_degrees(a, b, want):
    assert most_restrictive_degrees(a, b) == want


def _grad_only_filter():
    cfg = {"name": "u",
           "role_filter": {"include_keywords": ["widget"]},
           "eliminate": {"grad_only": True},
           "terms_wanted": ["Summer 2027"],
           "rules": [{"when": {"term": ["Summer 2027"]},
                      "accept_if_any": [{"always": True}]}]}
    return UserFilter(cfg, Path("."), today=TODAY)


def test_same_key_merge_keeps_losers_degrees_and_filter_rejects():
    # The degree-less row is "richer" (salary) and wins the merge ranking;
    # the Simplify row's graduate-only degrees must survive into the merge.
    rich = _job(WD_LIST_A, "zshah-2027", salary="$40/hr")
    simplify = _job(WD_LIST_A, "simplify", degrees=["Master's", "PhD"])
    for order in ([rich, simplify], [simplify, rich]):
        merged = dedupe([j.model_copy(deep=True) for j in order])
        assert len(merged) == 1
        assert merged[0].degrees == ["Master's", "PhD"]
        v = _grad_only_filter().evaluate(merged[0], today=TODAY)
        assert v.reasons == ["eliminated:grad-only-degrees"]


def test_disjoint_degree_twins_do_not_let_the_unknown_twin_through():
    # Three spellings of one posting: one source says Bachelor's, another
    # Master's, a third nothing. The degree-less twin must not inherit the
    # permissive list.
    a = _job(WD_LIST_A, "simplify", degrees=["Bachelor's"])
    b = _job(WD_LIST_B, "speedyapply", degrees=["Master's"])
    c = _job(WD_LIST_C, "zshah-2027")
    jobs = dedupe([a, b, c])
    assert len(jobs) == 3
    empty = next(j for j in jobs if j.source == "zshah-2027")
    assert empty.degrees == ["Master's"]
    assert _grad_only_filter().evaluate(empty, today=TODAY).reasons \
        == ["eliminated:grad-only-degrees"]


def test_same_canon_twins_share_degrees_before_evaluation():
    # Different dedup keys, same posting: the twin without degrees must not
    # slip past the elimination the Simplify twin hits.
    simplify = _job(WD_LIST_A, "simplify", degrees=["Master's"])
    other = _job(WD_LIST_B, "zshah-2027", title="Widget System Intern")
    jobs = dedupe([simplify, other])
    assert len(jobs) == 2
    uf = _grad_only_filter()
    for j in jobs:
        assert j.degrees == ["Master's"]
        assert uf.evaluate(j, today=TODAY).reasons == ["eliminated:grad-only-degrees"]


# ------------------------------------- a retry that succeeds on a losing key

WD_THIRD = ("https://acme.wd1.myworkdayjobs.com/en-US/Acme_Careers/job/X/"
            "Widget-Systems-Intern_2026798-1")
WD_LATE = ("https://acme.wd1.myworkdayjobs.com/Acme_Careers/job/X/"
           "Widget-Systems-Intern_2026798")


def _pending_on_loser():
    s = st.empty_state()
    _two_spellings_v3(s, "url:early", "url:late")
    st.mark_notified(s, "url:early", "alice")
    s["matches"] = {"dave": [{"key": "url:late", "url": WD_LATE}]}
    st.set_pending(s, "url:late", "dave")
    st.migrate_url_index(s)
    assert s["url_index"]["ats:wd:acme:2026798"] == "url:early"
    return s


def test_successful_discord_retry_on_losing_key_also_marks_the_owner(monkeypatch):
    s = _pending_on_loser()
    monkeypatch.setenv("DAVE_HOOK", "https://discord.invalid/hook")
    monkeypatch.setattr(main, "send_discord", lambda url, chunks: True)
    retry = _job(WD_LATE, "zshah-2027")
    retry.dedup_key = "url:late"
    main._notify_discord({"name": "dave",
                          "notify": {"discord_webhook_env": "DAVE_HOOK"}},
                         [(retry, ["always"])], s, False,
                         dt.datetime(2026, 11, 9, 12, tzinfo=dt.UTC),
                         ["Summer 2027"])
    assert st.was_notified(s, "url:late", "dave")
    assert st.was_notified(s, "url:early", "dave")      # the index owner too
    assert "pending" not in s["jobs"]["url:late"]
    # Dashboard row pruned later; a new spelling must still be suppressed.
    s["matches"] = {}
    kept = main._drop_url_dupes(s, "dave", [(_third_spelling("url:d4"), ["always"])],
                                ["Summer 2027"], TODAY)
    assert kept == []


def test_email_digest_send_marks_the_index_owner(monkeypatch):
    s = _pending_on_loser()
    st.clear_pending(s, "url:late", "dave")
    s["outbox"] = {"dave": [{"key": "url:late", "url": WD_LATE, "company": "Acme",
                             "title": "Widget Systems Intern", "term": "Summer 2027",
                             "tag": "", "location": "Austin, TX"}]}
    monkeypatch.setattr(main, "send_email", lambda *a, **k: True)
    monkeypatch.setenv("SMTP_U", "u@example.invalid")
    monkeypatch.setenv("SMTP_P", "pass")
    main._notify_email({"name": "dave", "notify": {"email": {
        "smtp_user_env": "SMTP_U", "smtp_pass_env": "SMTP_P"}}},
        [], s, False, dt.datetime(2026, 11, 9, 12, tzinfo=dt.UTC),
        ["Summer 2027"], send_now=True)
    assert st.was_notified(s, "url:early", "dave")
    s["matches"] = {}
    kept = main._drop_url_dupes(s, "dave", [(_third_spelling("url:d5"), ["always"])],
                                ["Summer 2027"], TODAY)
    assert kept == []
