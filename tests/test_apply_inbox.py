"""Inbox parsing + polling tests (pure; no IMAP, no network)."""

from __future__ import annotations

from email.message import EmailMessage

import pytest

from src.apply.inbox import Inbox, classify_reply, extract_link, extract_otp, message_text, poll
from src.apply.profile import InboxConfig


def test_extract_link_prefers_verification_link():
    body = ("Welcome! Visit https://example.com/privacy then "
            "https://acme.myworkdayjobs.com/verify?token=abc123 to finish.")
    assert extract_link(body) == "https://acme.myworkdayjobs.com/verify?token=abc123"


def test_extract_link_filters_denylist_and_trailing_punct():
    body = "Click https://acme.com/confirm/xyz. Unsubscribe: https://acme.com/unsubscribe"
    assert extract_link(body) == "https://acme.com/confirm/xyz"


def test_extract_link_hard_filter():
    body = "a https://x.com/verify b https://x.com/activate?tenant=acme c"
    assert extract_link(body, link_contains="activate") == "https://x.com/activate?tenant=acme"


def test_extract_link_none_when_no_urls():
    assert extract_link("no links here") is None


def test_extract_otp_prefers_code_context():
    assert extract_otp("Your verification code is 482913. Ignore 2024.") == "482913"


def test_extract_otp_fallback_any_digits():
    assert extract_otp("Use 7788 to continue") == "7788"
    assert extract_otp("nothing numeric") is None


def test_message_text_multipart():
    msg = EmailMessage()
    msg["Subject"] = "hi"
    msg.set_content("plain body https://acme.com/verify/1")
    assert "https://acme.com/verify/1" in message_text(msg)


def test_poll_retries_until_truthy():
    calls = {"n": 0}
    def fn():
        calls["n"] += 1
        return "found" if calls["n"] == 3 else None
    assert poll(fn, attempts=5, delay=0, sleep=lambda *_: None) == "found"
    assert calls["n"] == 3


def test_poll_gives_up():
    assert poll(lambda: None, attempts=3, delay=0, sleep=lambda *_: None) is None


def test_inbox_from_config_disabled_or_no_creds(monkeypatch):
    monkeypatch.delenv("GMAIL_ADDRESS", raising=False)
    monkeypatch.delenv("GMAIL_APP_PASSWORD", raising=False)
    assert Inbox.from_config(InboxConfig(enabled=False)) is None
    assert Inbox.from_config(InboxConfig(enabled=True)) is None

    monkeypatch.setenv("GMAIL_ADDRESS", "me@gmail.com")
    monkeypatch.setenv("GMAIL_APP_PASSWORD", "app-pw")
    inbox = Inbox.from_config(InboxConfig(enabled=True))
    assert inbox is not None and inbox.user == "me@gmail.com"


# --------------------------------------------------------- classify_reply

@pytest.mark.parametrize("subject,body,signal", [
    # oa: two phrasings + a named platform.
    ("Next step: online assessment",
     "Please complete your assessment within 5 days.", "oa"),
    ("Coding challenge for the SWE Intern role",
     "We use HackerRank; here is your invitation to complete it.", "oa"),
    ("Take-home exercise",
     "Attached is a take-home assignment for the data role.", "oa"),
    # phone_screen: the more specific stage wins over generic interview words.
    ("Let's schedule your interview",
     "Pick a phone screen slot that works for you.", "phone_screen"),
    ("Next step: recruiter chat",
     "We'd like to set up an initial call with our recruiter.", "phone_screen"),
    ("Screening call for the SWE Intern role",
     "Please book your screening call this week.", "phone_screen"),
    # interview: invite, scheduling, calendly-paired (clearly not a screen).
    ("Interview invitation",
     "We would like to interview you next week.", "interview"),
    ("Next steps",
     "Grab a time to interview here: https://calendly.com/acme/30min", "interview"),
    # rejected: several standard let-down phrasings.
    ("Update on your application",
     "We have decided not to move forward with your application.", "rejected"),
    ("Your application",
     "We are moving forward with other candidates at this time.", "rejected"),
    ("Regarding the Intern role",
     "Unfortunately this position has been filled.", "rejected"),
    # offer: two phrasings.
    ("Great news",
     "We are pleased to offer you the Summer Intern position.", "offer"),
    ("Your offer",
     "Please find your offer letter attached.", "offer"),
    # subject-only vs body-only matches.
    ("We'd like to extend an offer", "See attached.", "offer"),
    ("Congrats", "The team would love to meet the team lead? Actually, meet the team.",
     "interview"),
])
def test_classify_reply_detects_signal(subject, body, signal):
    result = classify_reply(subject, body)
    assert result is not None, (subject, body)
    assert result[0] == signal
    assert result[1]  # non-empty evidence snippet


@pytest.mark.parametrize("subject,body", [
    # application-received confirmation is "applied", not a new signal.
    ("Thank you for applying to Acme",
     "We have received your application and will be in touch."),
    ("Application received",
     "Your application was submitted successfully."),
    # our own digest.
    ("intern-watch matches", "3 new roles you can interview for soon."),
    # job alert / newsletter.
    ("New jobs for you", "5 internships matching your search. Schedule an interview today!"),
    ("Job alert: SWE Intern", "Apply now. Unsubscribe from these alerts."),
    # linkedin / indeed notifications.
    ("You appeared in 9 searches this week",
     "See who's viewing your LinkedIn profile."),
    ("New from Indeed",
     "Jobs you may like at indeed.com; complete your assessment of the market."),
    # OTP / verification-code mail handled elsewhere in the module.
    ("Your verification code is 482913",
     "Use code 482913 to sign in. Extend an offer of trust to us."),
    ("One-time password", "Your one-time code: 771122."),
    # nothing recruiter-like at all.
    ("Weekly newsletter", "Read our blog about resume tips and cover letters."),
    ("", ""),
])
def test_classify_reply_hard_negatives_return_none(subject, body):
    assert classify_reply(subject, body) is None
