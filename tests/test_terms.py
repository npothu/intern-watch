"""Rolling term window (src/terms.py). Dates are fixed; nothing here may
depend on the wall clock."""

import datetime as dt

from src import terms

AUG_26 = dt.date(2026, 8, 26)


def test_parse_and_start():
    assert terms.parse_term("Fall 2026") == ("Fall", 2026)
    assert terms.parse_term(" summer 2027 ") == ("Summer", 2027)
    assert terms.parse_term("Fall") is None
    assert terms.parse_term("2027") is None
    assert terms.term_start("Spring 2027") == dt.date(2027, 1, 10)
    assert terms.term_start("nope") is None


def test_add_months_clamps_day():
    assert terms.add_months(dt.date(2026, 1, 31), 1) == dt.date(2026, 2, 28)
    assert terms.add_months(dt.date(2026, 8, 26), 14) == dt.date(2027, 10, 26)
    assert terms.add_months(dt.date(2026, 3, 15), -14) == dt.date(2025, 1, 15)


def test_rolling_window_late_august():
    # Fall 2026 started Aug 20: gone. Fall 2027 (Aug 20 2027) is within 14
    # months; Summer 2028 is not.
    assert terms.rolling_terms(AUG_26, 3, 14) == [
        "Spring 2027", "Summer 2027", "Fall 2027"]


def test_rolling_window_early_june_matches_the_old_static_list():
    # The committed fixtures' date: the window reproduces the list the yaml
    # used to hard-code, so the migration changes nothing on that day.
    assert terms.rolling_terms(dt.date(2026, 6, 11), 3, 14) == [
        "Fall 2026", "Spring 2027", "Summer 2027"]


def test_lead_time_drops_a_term_before_it_starts():
    # Spring 2027 starts Jan 10; with 3 weeks of lead it drops on Dec 20.
    assert "Spring 2027" in terms.rolling_terms(dt.date(2026, 12, 19), 3, 14)
    assert "Spring 2027" not in terms.rolling_terms(dt.date(2026, 12, 21), 3, 14)


def test_wanted_terms_include_exclude_and_order():
    cfg = {"terms": {"rolling": True, "lead_weeks": 3, "horizon_months": 14,
                     "include": ["Summer 2028"], "exclude": ["Summer 2027"]}}
    assert terms.wanted_terms(cfg, AUG_26) == [
        "Spring 2027", "Fall 2027", "Summer 2028"]


def test_wanted_terms_legacy_list_is_sorted_chronologically():
    cfg = {"terms_wanted": ["Summer 2027", "Fall 2026", "Spring 2027"]}
    assert terms.wanted_terms(cfg, AUG_26) == [
        "Fall 2026", "Spring 2027", "Summer 2027"]


def test_terms_block_wins_over_legacy_list():
    cfg = {"terms": {"rolling": True},
           "terms_wanted": ["Fall 2026"]}
    assert "Fall 2026" not in terms.wanted_terms(cfg, AUG_26)


def test_term_rows_explain_each_term():
    rows = {r.term: r for r in terms.term_rows(
        {"lead_weeks": 3, "horizon_months": 14, "include": ["Summer 2028"],
         "exclude": ["Summer 2027"]}, AUG_26)}
    assert rows["Fall 2026"].status == "past" and not rows["Fall 2026"].wanted
    assert rows["Fall 2026"].drops_on == "2026-07-30"
    assert rows["Spring 2027"].status == "auto" and rows["Spring 2027"].wanted
    assert rows["Spring 2027"].drops_on == "2026-12-20"
    assert rows["Summer 2027"].status == "excluded"
    assert rows["Fall 2027"].status == "auto"
    assert rows["Fall 2027"].added_on == "2026-06-20"
    assert rows["Summer 2028"].status == "included" and rows["Summer 2028"].wanted
    assert list(rows) == ["Fall 2026", "Spring 2027", "Summer 2027",
                          "Fall 2027", "Summer 2028"]
