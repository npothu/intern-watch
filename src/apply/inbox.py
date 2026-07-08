"""Email-inbox reader for auto-apply.

Account creation on many ATSes (Workday especially) emails a verification link;
some sign-ins email a one-time code. This module reads the user's inbox over
IMAP (Gmail by default, reusing the watcher's app-password secret) and extracts
those, so the auth flow can finish unattended:

  create account -> "verify your email" -> inbox.find_verification_link() ->
  page.goto(link) -> signed in.

The parsing (`extract_link`, `extract_otp`) is pure and unit-tested; the IMAP
plumbing is thin and degrades to None on any error so a flaky mailbox never
crashes an apply run. `poll()` retries because the email usually lags the click.
"""

from __future__ import annotations

import email
import imaplib
import logging
import os
import re
import time
from email.message import Message

from .profile import InboxConfig

log = logging.getLogger(__name__)

_URL_RE = re.compile(r"https?://[^\s\"'<>)\]]+")
_OTP_RE = re.compile(r"\b(\d{4,8})\b")
# Links that are obviously not the verification target.
_LINK_DENY = ("unsubscribe", "privacy", "terms", "/help", "support@",
              "twitter.com", "facebook.com", "linkedin.com", "instagram.com")
_VERIFY_HINTS = ("verify", "confirm", "activate", "validate", "verification")


# ------------------------------------------------------------- pure parsing

def extract_link(body: str, link_contains: str = "",
                 prefer: tuple[str, ...] = _VERIFY_HINTS) -> str | None:
    """First plausible verification URL in `body`. `link_contains` (if given)
    is a hard filter; otherwise links hinting at verification rank first."""
    urls = [u.rstrip(".,;)") for u in _URL_RE.findall(body or "")]
    urls = [u for u in urls if not any(d in u.lower() for d in _LINK_DENY)]
    if link_contains:
        urls = [u for u in urls if link_contains.lower() in u.lower()]
    if not urls:
        return None
    for u in urls:
        if any(h in u.lower() for h in prefer):
            return u
    return urls[0]


def extract_otp(text: str) -> str | None:
    """A 4–8 digit one-time code, preferring digits near the word 'code'."""
    if not text:
        return None
    near = re.search(r"(?:code|otp|passcode)\D{0,20}(\d{4,8})", text, re.I)
    if near:
        return near.group(1)
    m = _OTP_RE.search(text)
    return m.group(1) if m else None


# Recruiter-reply signals, tuned for precision over recall: a wrong status
# proposal is worse than a missed one, so every pattern is an explicit phrase
# a real recruiter email uses, not a bare keyword. Order matters only for the
# returned label when several fire; rejection/offer read first as they are the
# most decisive. Callers get (signal, snippet) so the snippet can show as a
# tracker history note.
_REPLY_SIGNALS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("rejected", re.compile(
        r"decided not to move forward"
        r"|will not be moving forward"
        r"|other candidates whose"
        r"|mov(?:e|ing) forward with other candidates"
        r"|unable to offer you"
        r"|(?:this |the )?position has been filled"
        r"|you (?:have|were) not (?:been )?selected"
        r"|not to proceed with your application", re.I)),
    ("offer", re.compile(
        r"pleased to offer"
        r"|offer letter"
        r"|extend (?:you )?an offer"
        r"|excited to extend (?:you )?an offer", re.I)),
    ("oa", re.compile(
        r"online assessment"
        r"|coding challenge"
        r"|hackerrank|codesignal|codility"
        r"|take[- ]home (?:assignment|assessment|challenge|exercise|test)"
        r"|complete your assessment"
        r"|invitation to complete"
        r"|complete (?:a|the|your) (?:online )?assessment", re.I)),
    # phone_screen before interview: the more specific stage wins (they are
    # distinct statuses in src/ledger.py, and screen emails often also say
    # "interview").
    ("phone_screen", re.compile(
        r"phone screen"
        r"|recruiter screen"
        r"|screening call"
        r"|(?:intro|initial) call with (?:a|our) recruiter", re.I)),
    ("interview", re.compile(
        r"schedule your interview"
        r"|schedule an interview"
        r"|meet the team"
        r"|invite you to (?:an? )?interview"
        r"|(?:would like|like) to interview you"
        r"|set up (?:a|an) (?:phone |video |call )?interview"
        r"|interview.{0,40}(?:calendly\.com|schedule a time)"
        r"|(?:calendly\.com|schedule a time).{0,40}interview", re.I)),
)

# Emails that superficially resemble a recruiter reply but are not a new status.
# Any hit here forces None: application-received confirmations are the "applied"
# state we already know, digests/alerts/notifications are noise, and OTP mails
# are handled by extract_otp elsewhere in this module.
_REPLY_NEGATIVES = re.compile(
    r"thank you for applying"
    r"|thanks for applying"
    r"|we(?:'ve| have) received your application"
    r"|your application (?:has been|was) (?:received|submitted)"
    r"|application received"
    r"|intern[- ]watch"
    r"|job alert|new jobs? (?:for you|matching)|jobs you may"
    r"|unsubscribe from (?:these|job) (?:alerts|emails)"
    r"|linkedin|indeed\.com|glassdoor"
    r"|your (?:verification|security|login|one[- ]time) code"
    r"|verification code|passcode|one[- ]time password", re.I)


def classify_reply(subject: str, body: str) -> tuple[str, str] | None:
    """Recognize a recruiter-reply signal in an email.

    Returns (signal, evidence_snippet) where signal is one of "oa",
    "phone_screen", "interview", "rejected", "offer", or None when nothing
    confident matches.
    Conservative by design (precision over recall): known non-signals
    (application-received confirmations, job alerts, our own digest, OTP mails)
    force None even if a signal phrase also appears."""
    text = f"{subject or ''}\n{body or ''}"
    if _REPLY_NEGATIVES.search(text):
        return None
    for signal, pattern in _REPLY_SIGNALS:
        m = pattern.search(text)
        if m:
            return signal, m.group(0)
    return None


def message_text(msg: Message) -> str:
    """Best-effort plain-text body of an email.message.Message."""
    parts: list[str] = []
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() in ("text/plain", "text/html"):
                try:
                    payload = part.get_payload(decode=True) or b""
                    parts.append(payload.decode(part.get_content_charset() or
                                                "utf-8", "replace"))
                except Exception:
                    continue
    else:
        try:
            payload = msg.get_payload(decode=True) or b""
            parts.append(payload.decode(msg.get_content_charset() or "utf-8",
                                        "replace"))
        except Exception:
            pass
    return "\n".join(parts)


def poll(fn, attempts: int = 6, delay: float = 5.0, sleep=time.sleep):
    """Call `fn` until it returns a truthy value or attempts run out."""
    for i in range(attempts):
        result = fn()
        if result:
            return result
        if i < attempts - 1:
            sleep(delay)
    return None


# --------------------------------------------------------------- IMAP client

class Inbox:
    """Thin IMAP reader. Use Inbox.from_config(); None means 'no inbox'."""

    def __init__(self, host: str, port: int, user: str, password: str):
        self.host, self.port, self.user, self.password = host, port, user, password

    @classmethod
    def from_config(cls, cfg: InboxConfig) -> "Inbox | None":
        if not cfg.enabled:
            return None
        user = os.environ.get(cfg.user_env)
        password = os.environ.get(cfg.password_env)
        if not user or not password:
            log.info("inbox disabled: %s/%s not set", cfg.user_env, cfg.password_env)
            return None
        return cls(cfg.imap_host, cfg.imap_port, user, password)

    def _search_bodies(self, *, since_seconds: int, from_contains: str,
                       subject_contains: str, limit: int = 10) -> list[str]:
        """Return plain-text bodies of recent matching messages, newest first."""
        try:
            conn = imaplib.IMAP4_SSL(self.host, self.port)
            conn.login(self.user, self.password)
        except Exception as exc:
            log.warning("inbox login failed: %s", exc)
            return []
        try:
            conn.select("INBOX")
            since = time.gmtime(time.time() - since_seconds)
            crit = ["SINCE", time.strftime("%d-%b-%Y", since)]
            if from_contains:
                crit += ["FROM", from_contains]
            if subject_contains:
                crit += ["SUBJECT", subject_contains]
            typ, data = conn.search(None, *crit)
            if typ != "OK" or not data or not data[0]:
                return []
            ids = data[0].split()[-limit:][::-1]      # newest first
            bodies: list[str] = []
            for mid in ids:
                typ, msg_data = conn.fetch(mid, "(RFC822)")
                if typ != "OK" or not msg_data or not msg_data[0]:
                    continue
                msg = email.message_from_bytes(msg_data[0][1])
                bodies.append(message_text(msg))
            return bodies
        except Exception as exc:
            log.warning("inbox search failed: %s", exc)
            return []
        finally:
            try:
                conn.logout()
            except Exception:
                pass

    def find_verification_link(self, *, from_contains: str = "",
                               subject_contains: str = "", link_contains: str = "",
                               since_seconds: int = 600) -> str | None:
        for body in self._search_bodies(since_seconds=since_seconds,
                                        from_contains=from_contains,
                                        subject_contains=subject_contains):
            link = extract_link(body, link_contains=link_contains)
            if link:
                return link
        return None

    def find_otp_code(self, *, from_contains: str = "", subject_contains: str = "",
                      since_seconds: int = 600) -> str | None:
        for body in self._search_bodies(since_seconds=since_seconds,
                                        from_contains=from_contains,
                                        subject_contains=subject_contains):
            code = extract_otp(body)
            if code:
                return code
        return None
