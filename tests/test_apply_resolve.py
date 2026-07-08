"""Resolver tests: ATS classification + redirect following (no real network)."""

from __future__ import annotations

import httpx
import pytest

from src.apply.base import ATSFamily
from src.apply.resolve import DEFAULT_HEADERS, classify_ats, resolve


@pytest.mark.parametrize("url,family", [
    ("https://boards.greenhouse.io/acme/jobs/123", ATSFamily.greenhouse),
    ("https://job-boards.greenhouse.io/acme/jobs/1", ATSFamily.greenhouse),
    ("https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/x", ATSFamily.workday),
    ("https://acme.myworkdaysite.com/recruiting/acme/External", ATSFamily.workday),
    ("https://workday.acmecorp.com/apply", ATSFamily.workday),
    ("https://jobs.lever.co/acme/2f4a-uuid", ATSFamily.lever),
    ("https://acme.lever.co/postings/uuid", ATSFamily.lever),
    ("https://jobs.ashbyhq.com/acme/2f4a-uuid", ATSFamily.ashby),
    ("https://acme.ashbyhq.com/jobs/uuid", ATSFamily.ashby),
    ("https://example.com/careers", ATSFamily.unknown),
    ("https://notgreenhouse.io.evil.com/x", ATSFamily.unknown),
    ("", ATSFamily.unknown),
    ("not a url", ATSFamily.unknown),
])
def test_classify_ats(url, family):
    assert classify_ats(url) is family


def test_default_headers_have_realistic_ua():
    assert "Mozilla/5.0" in DEFAULT_HEADERS["User-Agent"]


def test_resolve_follows_aggregator_redirect_to_greenhouse():
    target = "https://boards.greenhouse.io/acme/jobs/9"

    def handler(request: httpx.Request) -> httpx.Response:
        if "tracker" in request.url.host:
            return httpx.Response(302, headers={"location": target})
        return httpx.Response(200, text="ok")

    client = httpx.Client(transport=httpx.MockTransport(handler),
                          follow_redirects=True)
    final, family = resolve("https://tracker.jobright.ai/x", client=client)
    assert final == target and family is ATSFamily.greenhouse
    client.close()


def test_resolve_network_error_falls_back_to_original():
    def boom(request):
        raise httpx.ConnectError("down", request=request)

    client = httpx.Client(transport=httpx.MockTransport(boom))
    final, family = resolve("https://acme.wd5.myworkdayjobs.com/x", client=client)
    assert final == "https://acme.wd5.myworkdayjobs.com/x"
    assert family is ATSFamily.workday
    client.close()


def test_resolve_injected_client_not_closed():
    client = httpx.Client(transport=httpx.MockTransport(
        lambda r: httpx.Response(200)))
    resolve("https://example.com/x", client=client)
    assert not client.is_closed
    client.close()
