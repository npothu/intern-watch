"""Standards-compliant email headers: deliverability + Gmail threading.

build_message must emit Date / Message-ID / Reply-To / a stable per-user
References+In-Reply-To token / one-click List-Unsubscribe, and stay a pure
function (these assertions never touch the network)."""

from email.utils import parseaddr, parsedate_tz

from src.notify import build_message

SENDER = "intern.watch@example.com"


def _msg(user: str | None = "example", smtp_user: str = SENDER):
    return build_message(smtp_user, "to@example.com", "subj",
                         "<p>hi</p>", "hi", user=user)


def test_all_standard_headers_present():
    msg = _msg()
    for h in ("Date", "Message-ID", "Reply-To", "References", "In-Reply-To",
              "List-Unsubscribe", "List-Unsubscribe-Post"):
        assert msg[h], f"missing header {h}"


def test_date_is_well_formed():
    assert parsedate_tz(_msg()["Date"]) is not None


def test_message_id_uses_sender_domain():
    mid = _msg()["Message-ID"]
    assert mid.startswith("<") and mid.endswith(">")
    assert mid.rstrip(">").endswith("@example.com")


def test_message_id_is_unique_per_message():
    assert _msg()["Message-ID"] != _msg()["Message-ID"]


def test_reply_to_is_the_sender():
    assert parseaddr(_msg()["Reply-To"])[1] == SENDER


def test_references_matches_in_reply_to():
    msg = _msg()
    assert msg["References"] == msg["In-Reply-To"]
    ref = msg["References"]
    assert ref.startswith("<") and ref.endswith(">")
    assert "@example.com" in ref


def test_list_unsubscribe_is_one_click():
    msg = _msg()
    assert SENDER in msg["List-Unsubscribe"]
    assert msg["List-Unsubscribe-Post"] == "List-Unsubscribe=One-Click"


def test_same_user_shares_references_token():
    assert _msg("example")["References"] == _msg("example")["References"]
    # ...and it is stable across an arbitrary number of digests.
    assert _msg("example")["In-Reply-To"] == _msg("example")["References"]


def test_different_users_get_different_threads():
    assert _msg("example")["References"] != _msg("alice")["References"]


def test_thread_token_depends_on_sender():
    a = build_message("a@example.com", "to@x.com", "s", "<p>h</p>", "h",
                      user="example")["References"]
    b = build_message("b@example.com", "to@x.com", "s", "<p>h</p>", "h",
                      user="example")["References"]
    assert a != b


def test_missing_user_still_well_formed():
    # No user (default) must not raise and still yields a valid token.
    msg = _msg(user=None)
    assert msg["References"].startswith("<")
    assert msg["References"] == msg["In-Reply-To"]