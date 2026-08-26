"""OAuth setup CLI for Gmail mail-sync (the Convex inbox backend).

    python -m src.mail_auth [--user NAME]

Runs the Google installed-app OAuth loopback flow for the narrow
`gmail.readonly` scope, exchanges the code for a refresh token, and stores it
on the user's Convex mail account so the server-side watcher can pull
recruiter mail. Requires a Convex-backed store (STORE=convex) plus a Google
Cloud OAuth client for a desktop app (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET).

The URL-building and token-exchange helpers are pure functions (the exchange
takes an injectable `urlopen`) so they are unit-testable without network.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit

from .envfile import load_dotenv
from .filters import load_users
from .paths import DATA_ROOT as DATA_ROOT
from .store import ConvexStore

SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
PROFILE_URL = "https://www.googleapis.com/gmail/v1/users/me/profile"
# "You can close this tab" page served to the browser right after the redirect.
_CLOSE_PAGE = (b"<html><body><h2>Authorized.</h2>"
               b"<p>You can close this tab and return to the terminal.</p>"
               b"</body></html>")

urlopen = urllib.request.urlopen  # module global so tests can monkeypatch it


class MailAuthError(Exception):
    """User-visible CLI setup failure (printed to stderr by main)."""


# -- pure helpers -----------------------------------------------------------

def build_auth_url(client_id: str, redirect_uri: str,
                   auth_url: str = AUTH_URL) -> str:
    """The Google consent URL. `redirect_uri` must be the loopback URI built
    from the bound port. access_type=offline + prompt=consent are what force
    a refresh token from every grant."""
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPE,
        "access_type": "offline",
        "prompt": "consent",
    }
    return f"{auth_url}?{urlencode(params)}"


def exchange_code(client_id: str, client_secret: str, code: str,
                  redirect_uri: str, token_url: str = TOKEN_URL) -> dict:
    """POST the auth code to the token endpoint and return the parsed JSON.
    Raises MailAuthError on transport error, a non-success status, or
    non-JSON. Uses the module `urlopen` so tests can inject a fake."""
    data = urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "code": code,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }).encode()
    req = urllib.request.Request(
        token_url, data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urlopen(req, timeout=30) as resp:
            body = resp.read()
    except urllib.error.HTTPError as exc:
        raise MailAuthError(
            f"token exchange failed (HTTP {exc.code}): "
            f"{exc.read().decode(errors='replace')}") from exc
    except (OSError, TimeoutError) as exc:
        raise MailAuthError(f"token exchange request failed: {exc}") from exc
    try:
        return json.loads(body)
    except ValueError as exc:
        raise MailAuthError("token exchange returned non-JSON") from exc


def _id_token_email(token: str) -> str:
    """The `email` claim from an id_token's unverified payload, or "" when it
    can't be parsed. The id_token is only used to learn the granted account;
    its signature is never checked."""
    if not token:
        return ""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)  # unpadded base64url
        claims = json.loads(base64.urlsafe_b64decode(payload).decode("utf-8"))
        return claims.get("email", "")
    except Exception:  # noqa: BLE001 - best-effort only
        return ""


def _gmail_profile_email(access_token: str,
                         profile_url: str = PROFILE_URL) -> str:
    """The account email from the Gmail profile endpoint (used when the token
    response carried no usable id_token)."""
    req = urllib.request.Request(
        profile_url, headers={"Authorization": f"Bearer {access_token}"})
    try:
        with urlopen(req, timeout=30) as resp:
            body = resp.read()
    except urllib.error.HTTPError as exc:
        raise MailAuthError(
            f"couldn't read the Gmail account email (HTTP {exc.code}): "
            f"{exc.read().decode(errors='replace')}") from exc
    except (OSError, TimeoutError) as exc:
        raise MailAuthError(f"Gmail profile request failed: {exc}") from exc
    try:
        return json.loads(body).get("emailAddress") or ""
    except ValueError as exc:
        raise MailAuthError("Gmail profile returned non-JSON") from exc


def resolve_account_email(tokens: dict) -> str:
    """The granted Gmail account email: from the id_token payload when present,
    else from the profile endpoint with the access token."""
    email = _id_token_email(tokens.get("id_token", ""))
    if not email and tokens.get("access_token"):
        email = _gmail_profile_email(tokens["access_token"])
    if not email:
        raise MailAuthError("couldn't determine the granted Gmail account email")
    return email


def _require_refresh_token(tokens: dict) -> str:
    """The refresh token, or an explanatory error when Google didn't grant one
    (that means consent wasn't fresh, so no offline token was minted)."""
    rt = tokens.get("refresh_token")
    if not rt:
        raise MailAuthError(
            "Google granted no refresh token (offline access missing). "
            "This usually means consent was already granted and reused -- "
            "revoke app access at myaccount.google.com/connections, then "
            "run this again so prompt=consent forces a fresh grant.")
    return rt


# -- loopback redirect capture ---------------------------------------------

class _RedirectHandler(BaseHTTPRequestHandler):
    """Serves the single GET the browser lands on after consent and records
    the auth `code` (or `error`) the user's redirect carried."""
    holder: dict = {}

    def do_GET(self) -> None:  # noqa: N802 (http.server API)
        params = parse_qs(urlsplit(self.path).query)
        # On the CLASS: the handler instance only lives for this one request,
        # so an instance attribute would be lost before oauth_flow reads it.
        type(self).holder = {
            "code": params.get("code", [None])[0],
            "error": params.get("error", [None])[0],
        }
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(_CLOSE_PAGE)))
        self.end_headers()
        self.wfile.write(_CLOSE_PAGE)

    def log_message(self, fmt: str, *args) -> None:  # quiet
        pass


# -- flow -------------------------------------------------------------------

def oauth_flow(client_id: str, client_secret: str, user: str, store,
               out=None, browser_open=webbrowser.open) -> tuple[str, str]:
    """Run the loopback flow end to end and return (email, refresh_token).
    `out` receives the auth URL to open; `browser_open` is injected for tests.
    Raises MailAuthError on any step the user can't act on from the terminal."""
    out = out or sys.stdout
    _RedirectHandler.holder = {}  # drop any capture from an earlier flow
    # Plain HTTPServer on purpose: handle_request() must process the redirect
    # synchronously before returning (the threading server hands it to a
    # worker and returns at accept, racing the holder read below).
    with HTTPServer(("127.0.0.1", 0), _RedirectHandler) as server:
        port = server.server_address[1]
        redirect_uri = f"http://127.0.0.1:{port}/"
        auth_url = build_auth_url(client_id, redirect_uri)
        print(f"\nOpen this URL to authorize Gmail access:\n  {auth_url}",
              file=out)
        try:
            browser_open(auth_url)
        except Exception:  # noqa: BLE001 - a failed auto-open is non-fatal
            print("(couldn't open a browser automatically -- paste the URL "
                  "above into one)", file=out)
        # Serve until the redirect lands (a stray request first, e.g. a
        # favicon probe, carries neither code nor error and is ignored).
        while not _RedirectHandler.holder.get("code") and \
                not _RedirectHandler.holder.get("error"):
            server.handle_request()
        result = dict(_RedirectHandler.holder)
    if result.get("error"):
        raise MailAuthError(f"authorization failed: {result['error']}")
    code = result.get("code")
    if not code:
        raise MailAuthError("no authorization code received -- the redirect "
                            "was never completed")

    tokens = exchange_code(client_id, client_secret, code, redirect_uri)
    refresh_token = _require_refresh_token(tokens)
    email = resolve_account_email(tokens)
    store.set_mail_account(user, email, refresh_token)
    return email, refresh_token


# -- CLI --------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m src.mail_auth",
                                 description=__doc__)
    ap.add_argument("--user", default="",
                    help="watcher user (default: the sole users/*.yaml)")
    args = ap.parse_args(argv)

    # Local-only: pick up GMAIL_*/STORE/CONVEX_* from the gitignored .env.
    load_dotenv()
    client_id = os.environ.get("GMAIL_CLIENT_ID", "")
    client_secret = os.environ.get("GMAIL_CLIENT_SECRET", "")
    missing = [n for n, v in (("GMAIL_CLIENT_ID", client_id),
                              ("GMAIL_CLIENT_SECRET", client_secret))
               if not v]
    if missing:
        print(f"missing env var(s): {', '.join(missing)} -- add them to .env "
              "(a Google Cloud OAuth client ID/secret for a desktop app)",
              file=sys.stderr)
        return 1
    if os.environ.get("STORE", "github") != "convex":
        print("mail sync needs STORE=convex in .env (this feature lives in "
              "the Convex backend)", file=sys.stderr)
        return 1

    users = {u["name"]: u for u in load_users(DATA_ROOT / "users")}
    if not users:
        print("no watcher configs in users/*.yaml", file=sys.stderr)
        return 1
    user = args.user or (next(iter(users)) if len(users) == 1 else "")
    if not user:
        print(f"several users configured ({', '.join(sorted(users))}) - "
              "pick one with --user", file=sys.stderr)
        return 1
    if user not in users:
        print(f"unknown user {user!r} (have: {', '.join(sorted(users))})",
              file=sys.stderr)
        return 1

    try:
        store = ConvexStore(DATA_ROOT, {"name": user})
        email, _ = oauth_flow(client_id, client_secret, user, store)
    except MailAuthError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - ConvexStore env/API failures
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(f"\nStored Gmail account {email!r} for user {user!r}. "
          "Mail sync is set up.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
