"""Hide/dismiss: issue rendering, read-back, webui write-through, and the
body-size budget that MAX_ROWS is tuned against."""

import datetime as dt

from src import dashboard, state as st
from src.webui import core

NOW = dt.datetime(2026, 7, 2, tzinfo=dt.timezone.utc)


def _item(key, company="Acme", **kw):
    base = {"key": key, "company": company, "title": "SWE Intern",
            "url": "https://example.com/j/1", "location": "Atlanta, GA",
            "term": "Fall 2026", "added": "2026-06-20", "applied": False}
    base.update(kw)
    return base


# -- rendering --------------------------------------------------------------

def test_active_rows_carry_an_untucked_hide_box():
    body = dashboard.build_body([_item("url:a")], ["Fall 2026"], NOW)
    hidden, present = dashboard.parse_dismissed(body)
    assert present == {dashboard.short_key("url:a")}
    assert hidden == set()


def test_dismissed_rows_move_to_the_hidden_section():
    items = [_item("url:a"), _item("url:b", company="Zeta", dismissed=True)]
    body = dashboard.build_body(items, ["Fall 2026"], NOW)
    a, b = dashboard.short_key("url:a"), dashboard.short_key("url:b")

    # header: only active rows count as matches; hidden counted separately
    assert body.startswith("**1 matches · 0 applied · 1 hidden**")
    # the dismissed row is out of the term groups (no applied box for it) and
    # inside a details block with its hide box ticked
    checked, present = dashboard.parse_checkboxes(body)
    assert present == {a}
    hidden, h_present = dashboard.parse_dismissed(body)
    assert hidden == {b} and h_present == {a, b}
    assert "<details>" in body and "Hidden (1)" in body
    assert body.index("Zeta") > body.index("<details>")


def test_hidden_row_has_no_applied_or_build_boxes():
    body = dashboard.build_body([_item("url:b", dismissed=True,
                                       resume="resumes/x/y.docx")],
                                ["Fall 2026"], NOW)
    checked, present = dashboard.parse_checkboxes(body)
    assert present == set()          # applied box not rendered -> protected
    assert dashboard.parse_build_selections(body) == set()


# -- read-back --------------------------------------------------------------

def _state_with(items):
    state = st.empty_state()
    state["matches"]["u"] = items
    return state


def test_ticking_hide_dismisses_and_unticking_restores():
    items = [_item("url:a"), _item("url:b", dismissed=True)]
    body = dashboard.build_body(items, ["Fall 2026"], NOW)
    a, b = dashboard.short_key("url:a"), dashboard.short_key("url:b")

    # user ticks hide on the active row, unticks it in the Hidden section
    body = core.flip_dismissed(body, a, True)
    body = core.flip_dismissed(body, b, False)

    state = _state_with([_item("url:a"), _item("url:b", dismissed=True)])
    hidden, h_present = dashboard.parse_dismissed(body)
    by_short = {dashboard.short_key(i["key"]): i["key"]
                for i in state["matches"]["u"]}
    st.matches_set_dismissed(state, "u",
                             {by_short[s] for s in hidden if s in by_short},
                             {by_short[s] for s in h_present if s in by_short})
    by_key = {i["key"]: i for i in state["matches"]["u"]}
    assert by_key["url:a"]["dismissed"] is True
    assert "dismissed" not in by_key["url:b"]  # stored sparsely


def test_matches_set_dismissed_only_touches_rendered_rows():
    state = _state_with([_item("url:a", dismissed=True), _item("url:b")])
    st.matches_set_dismissed(state, "u", hidden=set(), rendered={"url:b"})
    by_key = {i["key"]: i for i in state["matches"]["u"]}
    assert by_key["url:a"]["dismissed"] is True   # not rendered -> untouched
    assert "dismissed" not in by_key["url:b"]


# -- webui write-through ----------------------------------------------------

def test_flip_dismissed_leaves_applied_and_build_boxes_alone():
    body = dashboard.build_body(
        [_item("url:a", applied=True, resume="resumes/x/y.docx")],
        ["Fall 2026"], NOW)
    short = dashboard.short_key("url:a")
    flipped = core.flip_dismissed(body, short, True)
    assert dashboard.parse_checkboxes(flipped) == \
        dashboard.parse_checkboxes(body)
    assert dashboard.parse_build_selections(flipped) == \
        dashboard.parse_build_selections(body)
    hidden, _ = dashboard.parse_dismissed(flipped)
    assert hidden == {short}


def test_flip_applied_leaves_hide_box_alone():
    body = dashboard.build_body([_item("url:a")], ["Fall 2026"], NOW)
    short = dashboard.short_key("url:a")
    flipped = core.flip_applied(body, short, True)
    assert dashboard.parse_dismissed(flipped) == \
        dashboard.parse_dismissed(body)


def test_shape_matches_overlays_dismissed_for_rendered_rows_only():
    items = [_item("url:a"), _item("url:b", dismissed=True), _item("url:c")]
    a, b = dashboard.short_key("url:a"), dashboard.short_key("url:b")
    shaped = core.shape_matches(items, hidden={a}, h_present={a, b})
    by = {m["short"]: m for m in shaped}
    assert by[a]["dismissed"] is True        # ticked on the issue
    assert by[b]["dismissed"] is False       # unticked (restored) on the issue
    assert "dismissed" not in by[dashboard.short_key("url:c")]  # not rendered


# -- stale-row auto-hide ------------------------------------------------------

TODAY = dt.date(2026, 7, 2)


def _state_with_jobs(items, last_seen):
    state = _state_with(items)
    for item in items:
        state["jobs"][item["key"]] = {"first_seen": "2026-06-01",
                                      "last_seen": last_seen.get(
                                          item["key"], "2026-07-02")}
    return state


def test_auto_dismiss_hides_only_stale_unapplied_untouched_rows():
    items = [_item("url:stale"), _item("url:fresh"),
             _item("url:applied", applied=True),
             _item("url:restored", restored=True),
             _item("url:gone-job")]
    state = _state_with_jobs(items, {"url:stale": "2026-06-10",
                                     "url:applied": "2026-06-01",
                                     "url:restored": "2026-06-01"})
    del state["jobs"]["url:gone-job"]  # job entry pruned -> unknown, keep

    n = dashboard.auto_dismiss_stale(state, "u", TODAY, days=14)
    assert n == 1
    by_key = {i["key"]: i for i in state["matches"]["u"]}
    assert by_key["url:stale"]["dismissed"] is True
    for key in ("url:fresh", "url:applied", "url:restored", "url:gone-job"):
        assert "dismissed" not in by_key[key], key


def test_auto_dismiss_is_idempotent():
    items = [_item("url:stale")]
    state = _state_with_jobs(items, {"url:stale": "2026-06-01"})
    assert dashboard.auto_dismiss_stale(state, "u", TODAY) == 1
    assert dashboard.auto_dismiss_stale(state, "u", TODAY) == 0


def test_manual_restore_wins_over_auto_hide_forever():
    """Restoring from the Hidden section sets `restored`; the sweep must
    never re-hide it, and re-dismissing clears the marker again."""
    state = _state_with_jobs([_item("url:a", dismissed=True)],
                             {"url:a": "2026-06-01"})
    # user unticks the hidden row -> restored
    st.matches_set_dismissed(state, "u", hidden=set(), rendered={"url:a"})
    item = state["matches"]["u"][0]
    assert "dismissed" not in item and item["restored"] is True
    assert dashboard.auto_dismiss_stale(state, "u", TODAY) == 0

    # user hides it again by hand -> marker cleared, dismissed sticks
    st.matches_set_dismissed(state, "u", hidden={"url:a"},
                             rendered={"url:a"})
    item = state["matches"]["u"][0]
    assert item["dismissed"] is True and "restored" not in item


def test_plain_untick_of_never_dismissed_row_leaves_no_marker():
    state = _state_with([_item("url:a")])
    st.matches_set_dismissed(state, "u", hidden=set(), rendered={"url:a"})
    assert "restored" not in state["matches"]["u"][0]


# -- body budget ------------------------------------------------------------

def test_worst_case_dashboard_stays_under_the_issue_body_cap():
    """Row counts alone can't bound bytes (worst-case rows overflow 65536
    even at the old 250 cap): the byte-budget shrink must kick in."""
    long_title = "Software Engineering Intern - Infrastructure Platform " \
                 "Delivery (Fall 2026) (BS/MS)"
    items = [_item(f"url:https://example.com/careers/job/{i:06d}",
                   company=f"Very Long Company Name Holdings Intl {i:03d}",
                   title=long_title, salary="$45-60/hr",
                   resume=f"resumes/example/{i:012x}/Name_Co.docx",
                   location="San Francisco, California, United States",
                   dismissed=(i % 2 == 0))
             for i in range(2 * dashboard.MAX_ROWS)]
    body = dashboard.build_body(items, ["Fall 2026"], NOW,
                                repo="example/autojobfinder", branch="main")
    assert len(body) <= dashboard.BODY_BUDGET, f"body is {len(body)} chars"
    # the shrink trims, it must not empty the dashboard
    _, present = dashboard.parse_checkboxes(body)
    assert len(present) >= 10


def test_realistic_dashboard_shows_all_rows_unshrunk():
    """Typical rows fit comfortably: the budget loop must not trim them."""
    items = [_item(f"url:https://example.com/j/{i}", company=f"Acme {i}",
                   dismissed=(i >= dashboard.MAX_ROWS))
             for i in range(dashboard.MAX_ROWS + 40)]
    body = dashboard.build_body(items, ["Fall 2026"], NOW)
    _, present = dashboard.parse_checkboxes(body)
    assert len(present) == dashboard.MAX_ROWS
    _, h_present = dashboard.parse_dismissed(body)
    assert len(h_present) == dashboard.MAX_ROWS + 40  # active boxes + hidden