"""Gmail OAuth setup CLI: the pure URL-building / token-exchange helpers and
the CLI's env-error handling (no live network in these tests)."""

import base64
import io
import json
import threading
import urllib.error
import urllib.parse
import urllib.request
from urllib.parse import parse_qs, parse_qsl, urlsplit

import pytest

from src import mail_auth


class _Resp:
    """Minimal urlopen result stand-in for the token/profile responses."""

    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self.body


# -- URL building -----------------------------------------------------------

def test_build_auth_url_includes_required_params():
    url = mail_auth.build_auth_url("cid", "http://127.0.0.1:1234/")
    assert url.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    qs = parse_qs(urlsplit(url).query)
    assert qs["client_id"] == ["cid"]
    assert qs["redirect_uri"] == ["http://127.0.0.1:1234/"]
    assert qs["response_type"] == ["code"]
    assert qs["scope"] == ["https://www.googleapis.com/auth/gmail.readonly"]
    assert qs["access_type"] == ["offline"]   # required for a refresh token
    assert qs["prompt"] == ["consent"]        # required for a fresh grant


# -- token exchange ---------------------------------------------------------

def test_exchange_code_parses_tokens(monkeypatch):
    captured = {}

    def fake_urlopen(req, timeout=30):
        captured["url"] = req.full_url
        captured["data"] = dict(parse_qsl(req.data.decode()))
        return _Resp(json.dumps({"access_token": "at", "refresh_token": "rt",
                                 "id_token": "x.y.z"}).encode())

    monkeypatch.setattr(mail_auth, "urlopen", fake_urlopen)
    tokens = mail_auth.exchange_code("cid", "cs", "code",
                                     "http://127.0.0.1:1/")
    assert tokens == {"access_token": "at", "refresh_token": "rt",
                      "id_token": "x.y.z"}
    assert captured["url"] == mail_auth.TOKEN_URL
    assert captured["data"]["grant_type"] == "authorization_code"
    assert captured["data"]["client_id"] == "cid"
    assert captured["data"]["client_secret"] == "cs"
    assert captured["data"]["code"] == "code"
    assert captured["data"]["redirect_uri"] == "http://127.0.0.1:1/"


def test_exchange_code_raises_on_http_error(monkeypatch):
    body = json.dumps({"error": "invalid_grant"}).encode()

    def fake_urlopen(req, timeout=30):
        raise urllib.error.HTTPError(req.full_url, 400, "bad request", {},
                                     io.BytesIO(body))

    monkeypatch.setattr(mail_auth, "urlopen", fake_urlopen)
    with pytest.raises(mail_auth.MailAuthError,
                       match="token exchange failed"):
        mail_auth.exchange_code("cid", "cs", "code", "http://127.0.0.1:1/")


def test_missing_refresh_token_explains_consent(monkeypatch):
    def fake_urlopen(req, timeout=30):
        return _Resp(json.dumps({"access_token": "at"}).encode())

    monkeypatch.setattr(mail_auth, "urlopen", fake_urlopen)
    tokens = mail_auth.exchange_code("cid", "cs", "code",
                                     "http://127.0.0.1:1/")
    with pytest.raises(mail_auth.MailAuthError, match="refresh token"):
        mail_auth._require_refresh_token(tokens)


# -- account email resolution -----------------------------------------------

def _fake_id_token(email: str) -> str:
    payload = base64.urlsafe_b64encode(
        json.dumps({"email": email}).encode()).rstrip(b"=").decode()
    return f"header.{payload}.sig"


def test_resolve_account_email_from_id_token(monkeypatch):
    tokens = {"id_token": _fake_id_token("a@x.com"), "access_token": "at"}
    assert mail_auth.resolve_account_email(tokens) == "a@x.com"


def test_resolve_account_email_falls_back_to_profile(monkeypatch):
    def fake_urlopen(req, timeout=30):
        assert req.full_url == mail_auth.PROFILE_URL
        return _Resp(json.dumps({"emailAddress": "b@y.com"}).encode())

    monkeypatch.setattr(mail_auth, "urlopen", fake_urlopen)
    assert mail_auth.resolve_account_email({"access_token": "at"}) == "b@y.com"


# -- the loopback flow ------------------------------------------------------

def test_oauth_flow_end_to_end(monkeypatch):
    """The whole loopback dance against a real local redirect server: consent
    simulated by GETting the redirect URI with a code, token exchange and the
    store mocked. Regression: the redirect handler must publish the captured
    code on the CLASS (a handler instance dies with its request)."""
    def fake_urlopen(req, timeout=30):
        assert req.full_url == mail_auth.TOKEN_URL
        return _Resp(json.dumps(
            {"access_token": "at", "refresh_token": "rt",
             "id_token": _fake_id_token("a@x.com")}).encode())

    monkeypatch.setattr(mail_auth, "urlopen", fake_urlopen)

    stored = {}

    class FakeStore:
        def set_mail_account(self, user, email, refresh_token):
            stored["account"] = (user, email, refresh_token)

    def fake_browser_open(url):
        redirect = parse_qs(urlsplit(url).query)["redirect_uri"][0]
        threading.Thread(
            target=urllib.request.urlopen, args=(f"{redirect}?code=abc",),
            daemon=True).start()
        return True

    email, rt = mail_auth.oauth_flow("cid", "cs", "u", FakeStore(),
                                     out=io.StringIO(),
                                     browser_open=fake_browser_open)
    assert (email, rt) == ("a@x.com", "rt")
    assert stored["account"] == ("u", "a@x.com", "rt")


def test_oauth_flow_denied_consent(monkeypatch):
    def fake_browser_open(url):
        redirect = parse_qs(urlsplit(url).query)["redirect_uri"][0]
        threading.Thread(
            target=urllib.request.urlopen,
            args=(f"{redirect}?error=access_denied",), daemon=True).start()
        return True

    with pytest.raises(mail_auth.MailAuthError, match="access_denied"):
        mail_auth.oauth_flow("cid", "cs", "u", object(), out=io.StringIO(),
                             browser_open=fake_browser_open)


# -- CLI env error messages -------------------------------------------------

def test_main_missing_env(monkeypatch, capsys):
    # keep a developer's real .env out of the test
    monkeypatch.setattr(mail_auth, "load_dotenv", lambda *a, **k: None)
    monkeypatch.delenv("GMAIL_CLIENT_ID", raising=False)
    monkeypatch.delenv("GMAIL_CLIENT_SECRET", raising=False)
    assert mail_auth.main([]) == 1
    err = capsys.readouterr().err
    assert "missing env var(s)" in err
    assert "GMAIL_CLIENT_ID" in err and "GMAIL_CLIENT_SECRET" in err


def test_main_requires_convex(monkeypatch, capsys):
    monkeypatch.setattr(mail_auth, "load_dotenv", lambda *a, **k: None)
    monkeypatch.setenv("GMAIL_CLIENT_ID", "cid")
    monkeypatch.setenv("GMAIL_CLIENT_SECRET", "cs")
    monkeypatch.delenv("STORE", raising=False)  # collapses to `github` default
    assert mail_auth.main([]) == 1
    err = capsys.readouterr().err
    assert "STORE=convex" in err
