"""Authenticated jobright.ai session.

Login POST to https://jobright.ai/swan/auth/login/pwd with JSON
{email, password} returns errorCode 10000 on success and sets a SESSION_ID
cookie. The cookie is persisted so later runs reuse the session. Fail open:
callers get None, never an exception.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
from pathlib import Path

import httpx

from ..normalize import strip_tracking
from ..paths import DATA_ROOT as DATA_ROOT
from . import jobright_page
from .jobright_page import _PAGE_UA

log = logging.getLogger(__name__)

_LOGIN_URL = "https://jobright.ai/swan/auth/login/pwd"
_OK_CODE = 10000
_SESSION_COOKIE = "SESSION_ID"

class JobrightSession:
    def __init__(self, email, password, session_path=None, cap=25):
        self.email = email
        self.password = password
        self.session_path = Path(session_path) if session_path else (
            DATA_ROOT / "state" / "jobright_session.json")
        self.cap = cap
        self.disabled = False
        self.auth_failed_msg = None
        self.succeeded = False
        self.calls = 0
        self._memo = {}
        self._cap_logged = False
        self._client = httpx.Client(timeout=30.0, headers={
            "User-Agent": _PAGE_UA,
            "Origin": "https://jobright.ai",
            "Referer": "https://jobright.ai/",
        })
        self._load_cookies()

    @classmethod
    def from_env(cls):
        email = os.environ.get("JOBRIGHT_EMAIL")
        password = os.environ.get("JOBRIGHT_PASSWORD")
        if not email or not password:
            log.info("missing JOBRIGHT_EMAIL/JOBRIGHT_PASSWORD env")
            return None
        return cls(email, password)

    def _load_cookies(self):
        try:
            data = json.loads(self.session_path.read_text())
            for name, value in (data.get("cookies") or {}).items():
                self._client.cookies.set(name, value)
        except Exception:
            pass

    def _save_cookies(self):
        try:
            self.session_path.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "saved_at": dt.datetime.now(dt.UTC).isoformat(),
                "cookies": dict(self._client.cookies),
            }
            self.session_path.write_text(json.dumps(payload) + "\n",
                                         newline="\n")
        except Exception as exc:
            log.debug("could not save jobright session: %s", exc)

    def login(self) -> bool:
        self.calls += 1
        try:
            resp = self._client.post(
                _LOGIN_URL,
                json={"email": self.email, "password": self.password},
            )
            # A rejected credential comes back as 401/403, not as an OK
            # envelope -- it must disable the session rather than look like
            # a transient network blip that gets retried every run.
            if resp.status_code in (401, 403):
                return self._reject(f"HTTP {resp.status_code}")
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            log.warning("jobright login request failed: %s", exc)
            return False
        if data.get("errorCode") == _OK_CODE:
            self._save_cookies()
            self.succeeded = True
            return True
        return self._reject(str(data.get("errorMsg") or
                                data.get("errorCode")))

    def _reject(self, detail: str) -> bool:
        self.disabled = True
        self.auth_failed_msg = (
            f"jobright login rejected ({detail}) -- check JOBRIGHT_EMAIL / "
            "JOBRIGHT_PASSWORD")
        log.error("%s", self.auth_failed_msg)
        return False

    def fetch_job_result(self, jobright_id: str) -> dict | None:
        if jobright_id in self._memo:
            return self._memo[jobright_id]
        if self.disabled:
            return None
        if self.calls >= self.cap:
            if not self._cap_logged:
                self._cap_logged = True
                log.warning("jobright request cap %s reached", self.cap)
            return None
        try:
            if _SESSION_COOKIE not in self._client.cookies and not self.login():
                self._memo[jobright_id] = None
                return None
            result = jobright_page.fetch_job_result(self._client, jobright_id)
            self.calls += 1
            if (not result or result.get("applyLink") is None) and self.login():
                result = jobright_page.fetch_job_result(self._client, jobright_id)
                self.calls += 1
            if result and result.get("applyLink"):
                self.succeeded = True
            self._memo[jobright_id] = result
            return result
        except Exception as exc:
            log.warning("jobright fetch failed for %s: %s", jobright_id, exc)
            self._memo[jobright_id] = None
            return None

    def resolve_apply_url(self, jobright_id: str) -> str | None:
        result = self.fetch_job_result(jobright_id)
        if not result:
            return None
        url = result.get("applyLink") or result.get("originalUrl")
        if not url:
            return None
        stripped = strip_tracking(url)
        try:
            parts = httpx.URL(stripped)
        except Exception:
            return None
        host = (parts.host or "").lower()
        if parts.scheme not in ("http", "https"):
            return None
        if host == "jobright.ai" or host.endswith(".jobright.ai"):
            return None
        return stripped

    def close(self):
        self._client.close()
