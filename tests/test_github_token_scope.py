import datetime as dt

import httpx

TODAY = dt.date(2026, 11, 8)


def test_github_token_only_reaches_github_hosts():
    from src.adapters.base import GitHubTokenAuth
    seen = {}

    def handler(req):
        seen[req.url.host] = req.headers.get("Authorization")
        return httpx.Response(200, text="{}")

    with httpx.Client(transport=httpx.MockTransport(handler),
                      auth=GitHubTokenAuth("tok")) as c:
        for url in ("https://raw.githubusercontent.com/o/r/main/README.md",
                    "https://api.smartrecruiters.com/v1/companies/X/postings",
                    "https://boards-api.greenhouse.io/v1/boards/x/jobs",
                    "https://api.lever.co/v0/postings/x",
                    "https://api.ashbyhq.com/posting-api/job-board/x"):
            c.get(url)
    assert seen["raw.githubusercontent.com"] == "Bearer tok"
    for host in ("api.smartrecruiters.com", "boards-api.greenhouse.io",
                 "api.lever.co", "api.ashbyhq.com"):
        assert seen[host] is None


def test_redirect_off_github_drops_the_token():
    from src.adapters.base import GitHubTokenAuth
    seen = {}

    def handler(req):
        seen[req.url.host] = req.headers.get("Authorization")
        if req.url.host == "raw.githubusercontent.com":
            return httpx.Response(302,
                                  headers={"Location": "https://example.com/x"})
        return httpx.Response(200, text="")

    with httpx.Client(transport=httpx.MockTransport(handler),
                      auth=GitHubTokenAuth("tok"),
                      follow_redirects=True) as c:
        c.get("https://raw.githubusercontent.com/o/r/main/README.md")
    assert seen["raw.githubusercontent.com"] == "Bearer tok"
    assert seen["example.com"] is None


def test_redirect_onto_github_stays_unauthenticated():
    from src.adapters.base import GitHubTokenAuth
    seen = {}

    def handler(req):
        seen[req.url.host] = req.headers.get("Authorization")
        if req.url.host == "example.com":
            return httpx.Response(
                302, headers={"Location": "https://raw.githubusercontent.com/o/r/x"})
        return httpx.Response(200, text="")

    with httpx.Client(transport=httpx.MockTransport(handler),
                      auth=GitHubTokenAuth("tok"),
                      follow_redirects=True) as c:
        c.get("https://example.com/x")
    assert seen["example.com"] is None
    assert seen["raw.githubusercontent.com"] is None


def test_fetch_all_scopes_the_token(monkeypatch):
    from src import main
    from src.adapters.base import GitHubTokenAuth
    made = {}
    real = httpx.Client

    def spy(**kw):
        made.update(kw)
        return real(transport=httpx.MockTransport(
            lambda r: httpx.Response(200, text="")), **kw)

    monkeypatch.setenv("GITHUB_TOKEN", "tok")
    monkeypatch.setattr(main.httpx, "Client", spy)
    main.fetch_all([], {"_meta": {"source_rows": {}}}, TODAY)
    assert "Authorization" not in made["headers"]
    assert isinstance(made["auth"], GitHubTokenAuth)
