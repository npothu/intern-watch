import datetime as dt

import pytest

from src.normalize import (canonical_url, extract_jobright_id, infer_terms,
                           norm_company, normalize_url, parse_month_day,
                           split_locations, strip_html, strip_tracking)

TODAY = dt.date(2026, 6, 11)


@pytest.mark.parametrize("title,terms,conf", [
    ("Software Engineer Intern (Fall 2026)", ["Fall 2026"], "explicit"),
    ("SWE Intern - Summer '27", ["Summer 2027"], "explicit"),
    ("Intern, Fall2026 Cohort", ["Fall 2026"], "explicit"),
    ("Software Intern Autumn 2026", ["Fall 2026"], "explicit"),
    ("Intern (Fall 2026 & Spring 2027)", ["Fall 2026", "Spring 2027"], "explicit"),
    ("Product Manager Intern - 2026 Summer (BS/MS)", ["Summer 2026"], "explicit"),
    ("January 2027 Start - Developer Co-op", ["Spring 2027"], "inferred"),
    ("Sept 2026 Engineering Co-op", ["Fall 2026"], "inferred"),
    ("Fall Software Co-op", ["Fall 2026"], "inferred"),     # season, no year
    ("2027 Software Engineer Intern", ["Summer 2027"], "inferred"),  # bare year
    ("Software Engineer Intern", [], "unknown"),
    ("Backend Developer Intern - Atlanta", [], "unknown"),
])
def test_infer_terms(title, terms, conf):
    got_terms, got_conf = infer_terms(title, TODAY)
    assert got_terms == terms
    assert got_conf == conf


def test_season_no_year_rolls_forward():
    # asking in November 2026 about a "Spring" intern -> Spring 2027
    assert infer_terms("Spring Developer Co-op", dt.date(2026, 11, 1))[0] == ["Spring 2027"]


@pytest.mark.parametrize("a,b", [
    ("Google LLC", "google"),
    ("NVIDIA Corporation", "nvidia"),
    ("Stripe, Inc.", "stripe"),
    ("The Home Depot", "the home depot"),
    ("D. E. Shaw & Co.", "d e shaw and"),
])
def test_norm_company(a, b):
    assert norm_company(a) == b


def test_norm_company_matches_aliases():
    assert norm_company("Citadel Securities LLC") == norm_company("Citadel Securities")


def test_split_locations():
    assert split_locations("Atlanta, GA / NYC") == ["Atlanta, GA", "NYC"]
    assert split_locations("Portland, OR") == ["Portland, OR"]
    runon = ("Atlanta, Georgia, United States Boston, Massachusetts, "
             "United States Costa Mesa, California, United States")
    got = split_locations(runon)
    assert len(got) == 3
    assert got[0] == "Atlanta, Georgia, United States"
    assert split_locations("Remote or Atlanta, GA") == ["Remote", "Atlanta, GA"]
    assert split_locations("Boston, MA New York, NY") == ["Boston, MA", "New York, NY"]
    assert split_locations("NYC<br/>Seattle, WA") == ["NYC", "Seattle, WA"]


def test_url_tracking_strip_and_normalize():
    url = "https://jobright.ai/jobs/info/6a0b2c8c538d03366dc8273a?utm_campaign=1079&utm_source=git"
    assert strip_tracking(url) == "https://jobright.ai/jobs/info/6a0b2c8c538d03366dc8273a"
    # job-id query params survive normalization, tracking ones don't
    u = "https://Stoke.com/careers/?gh_jid=598&jr_id=69fae0acd21cf86d1e3cd79c&utm_source=x"
    assert normalize_url(u) == "https://stoke.com/careers?gh_jid=598"
    # same posting, different tracking -> same canonical form
    assert normalize_url(url + "&utm_medium=z") == normalize_url(url)
    # greenhouse publishes the same job with and without ?gh_jid=<path id>
    assert normalize_url("https://boards.greenhouse.io/x/jobs/514?gh_jid=514") \
        == normalize_url("https://boards.greenhouse.io/x/jobs/514")
    # workday locale prefix is not identity
    assert normalize_url("https://co.wd5.myworkdayjobs.com/en-US/site/job/X/Y_J1") \
        == normalize_url("https://co.wd5.myworkdayjobs.com/site/job/X/Y_J1")


def test_extract_jobright_id():
    assert extract_jobright_id(
        "https://jobright.ai/jobs/info/6A0B2C8C538D03366DC8273A?utm=1") \
        == "6a0b2c8c538d03366dc8273a"
    assert extract_jobright_id(
        "https://x.com/job?a=1&jr_id=69eaa8e4dc35f7132c4ab803") \
        == "69eaa8e4dc35f7132c4ab803"
    assert extract_jobright_id("https://x.com/job") is None


def test_strip_html_drops_script_style_noscript_content():
    html = ("<html><head><style>.a{color:red}</style>"
            "<script>var x = 1; document.write('bad');</script></head>"
            "<body><p>Hello world</p><noscript>no js msg</noscript>"
            "<p>Goodbye</p></body></html>")
    assert strip_html(html) == "Hello world Goodbye"


def test_parse_month_day_year_rollover():
    assert parse_month_day("Jun 11", TODAY) == dt.date(2026, 6, 11)
    assert parse_month_day("Dec 30", dt.date(2026, 1, 5)) == dt.date(2025, 12, 30)
    assert parse_month_day("garbage", TODAY) is None
    assert parse_month_day("Feb 30", TODAY) is None


def test_canonical_url_greenhouse_host_variants_collapse():
    a = canonical_url("https://boards.greenhouse.io/cloudflare/jobs/8052785")
    b = canonical_url("https://job-boards.greenhouse.io/cloudflare/jobs/8052785")
    assert a == b == "ats:gh:8052785"


def test_canonical_url_gh_jid_path_variants_collapse():
    # Same requisition, different marketing path (Zipline) and host (Tower).
    a = canonical_url("https://www.zipline.com/careers?gh_jid=7780103003")
    b = canonical_url("https://www.zipline.com/open-roles?gh_jid=7780103003")
    assert a == b == "ats:gh:7780103003"
    assert canonical_url(
        "https://www.tower-research.com/open-positions?gh_jid=8024128") \
        == "ats:gh:8024128"


def test_canonical_url_greenhouse_custom_domain_slug():
    assert canonical_url(
        "https://careers.appian.com/jobs/8041237-software-engineering-intern") \
        == "ats:gh:8041237"
    # ... and it joins the greenhouse-hosted mirror of the same req.
    assert canonical_url("https://job-boards.greenhouse.io/appian/jobs/8041237") \
        == "ats:gh:8041237"


def test_canonical_url_lever_and_ashby_ids():
    assert canonical_url(
        "https://jobs.lever.co/palantir/bdcfb29f-4f27-42de-933f-7f83a359b9f0/apply") \
        == "ats:lever:palantir:bdcfb29f-4f27-42de-933f-7f83a359b9f0"
    assert canonical_url(
        "https://jobs.ashbyhq.com/ramp/12345678-1234-1234-1234-123456789abc") \
        == "ats:ashby:12345678-1234-1234-1234-123456789abc"


def test_canonical_url_fallback_string_joins_www_and_scheme():
    # No stable ATS id -> hardened URL string; www/scheme variants collapse.
    a = canonical_url("https://www.akunacapital.com/careers/job/8021481")
    b = canonical_url("http://akunacapital.com/careers/job/8021481")
    assert a == b == "https://akunacapital.com/careers/job/8021481"


def test_canonical_url_none_cases():
    assert canonical_url("https://jobright.ai/jobs/info/"
                         "6a4298496faf756060967309") is None
    assert canonical_url("mailto:x@y.com") is None
    assert canonical_url("") is None


@pytest.mark.parametrize("url,expected", [
    ("https://boards.greenhouse.io/cloudflare/jobs/8052785?utm_source=x"
     "&gh_jid=8052785", "https://boards.greenhouse.io/cloudflare/jobs/8052785"),
    ("https://X.com/EN-us/jobs/9/", "https://x.com/jobs/9"),
    ("http://Foo.com/a?b=2&a=1", "http://foo.com/a?a=1&b=2"),
    ("https://acme.com/j/1/", "https://acme.com/j/1"),
])
def test_normalize_url_unchanged_by_canon_refactor(url, expected):
    # Guards the _sorted_kept_query extraction: normalize_url must be byte-
    # identical to its pre-refactor behavior.
    assert normalize_url(url) == expected
