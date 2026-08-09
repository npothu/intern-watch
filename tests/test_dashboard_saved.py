"""Saved (bookmark) tick: issue rendering, read-back, webui write-through.
Mirrors test_dashboard_dismiss.py, but `saved` is a plain symmetric boolean
like `applied` -- no restored-marker/Hidden-section side effects."""

import datetime as dt

from src import dashboard
from src import state as st
from src.webui import core

NOW = dt.datetime(2026, 7, 2, tzinfo=dt.UTC)


def _item(key, company="Acme", **kw):
    base = {"key": key, "company": company, "title": "SWE Intern",
            "url": "https://example.com/j/1", "location": "Atlanta, GA",
            "term": "Fall 2026", "added": "2026-06-20", "applied": False}
    base.update(kw)
    return base


# -- rendering ----------------------------------------------------------------

def test_active_rows_carry_an_unticked_save_box():
    body = dashboard.build_body([_item("url:a")], ["Fall 2026"], NOW)
    saved, present = dashboard.parse_saved(body)
    assert present == {dashboard.short_key("url:a")}
    assert saved == set()


def test_saved_row_renders_ticked():
    body = dashboard.build_body([_item("url:a", saved=True)],
                                ["Fall 2026"], NOW)
    saved, present = dashboard.parse_saved(body)
    short = dashboard.short_key("url:a")
    assert saved == {short} and present == {short}
    assert "0 saved" not in body and "1 saved" in body


def test_hidden_row_has_no_save_box():
    body = dashboard.build_body([_item("url:a", dismissed=True, saved=True)],
                                ["Fall 2026"], NOW)
    saved, present = dashboard.parse_saved(body)
    assert present == set()          # save box not rendered -> protected


# -- read-back ------------------------------------------------------------------

def _state_with(items):
    state = st.empty_state()
    state["matches"]["u"] = items
    return state


def test_ticking_save_flows_back_into_state():
    items = [_item("url:a"), _item("url:b")]
    body = dashboard.build_body(items, ["Fall 2026"], NOW)
    a = dashboard.short_key("url:a")

    body = core.flip_saved(body, a, True)

    state = _state_with(items)
    saved, present = dashboard.parse_saved(body)
    by_short = {dashboard.short_key(i["key"]): i["key"]
                for i in state["matches"]["u"]}
    st.matches_set_saved(state, "u",
                         {by_short[s] for s in saved if s in by_short},
                         {by_short[s] for s in present if s in by_short})
    by_key = {i["key"]: i for i in state["matches"]["u"]}
    assert by_key["url:a"]["saved"] is True
    assert by_key["url:b"]["saved"] is False


def test_matches_set_saved_only_touches_rendered_rows():
    state = _state_with([_item("url:a", saved=True), _item("url:b")])
    st.matches_set_saved(state, "u", saved=set(), rendered={"url:b"})
    by_key = {i["key"]: i for i in state["matches"]["u"]}
    assert by_key["url:a"]["saved"] is True   # not rendered -> untouched
    assert by_key["url:b"]["saved"] is False


# -- webui write-through --------------------------------------------------------

def test_flip_saved_leaves_applied_dismissed_and_build_boxes_alone():
    body = dashboard.build_body(
        [_item("url:a", applied=True, resume="resumes/x/y.docx")],
        ["Fall 2026"], NOW)
    short = dashboard.short_key("url:a")
    flipped = core.flip_saved(body, short, True)
    assert dashboard.parse_checkboxes(flipped) == \
        dashboard.parse_checkboxes(body)
    assert dashboard.parse_build_selections(flipped) == \
        dashboard.parse_build_selections(body)
    assert dashboard.parse_dismissed(flipped) == dashboard.parse_dismissed(body)
    saved, _ = dashboard.parse_saved(flipped)
    assert saved == {short}


def test_flip_applied_and_flip_dismissed_leave_save_box_alone():
    body = dashboard.build_body([_item("url:a")], ["Fall 2026"], NOW)
    short = dashboard.short_key("url:a")
    for flip in (lambda b: core.flip_applied(b, short, True),
                lambda b: core.flip_dismissed(b, short, True)):
        flipped = flip(body)
        assert dashboard.parse_saved(flipped) == dashboard.parse_saved(body)


def test_shape_matches_overlays_saved_for_rendered_rows_only():
    items = [_item("url:a"), _item("url:b", saved=True), _item("url:c")]
    a, b = dashboard.short_key("url:a"), dashboard.short_key("url:b")
    shaped = core.shape_matches(items, saved={a}, s_present={a, b})
    by = {m["short"]: m for m in shaped}
    assert by[a]["saved"] is True         # ticked on the issue
    assert by[b]["saved"] is False        # unticked on the issue
    assert "saved" not in by[dashboard.short_key("url:c")]  # not rendered
