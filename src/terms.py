"""Rolling internship terms.

A static `terms_wanted` list rots: nobody remembers to drop "Fall 2026" in
August or to add "Fall 2027" in June. With `terms:` in the user yaml the
wanted set is derived from today's date instead: every Spring/Summer/Fall
term whose start lies between `lead_weeks` from now and `horizon_months`
from now is wanted, and `include` / `exclude` pin explicit exceptions.

    terms:
      rolling: true
      lead_weeks: 3          # stop wanting a term this close to its start
      horizon_months: 14     # don't want a term starting further out
      include: []            # always wanted, e.g. ["Summer 2028"]
      exclude: []            # never wanted, e.g. ["Spring 2027"]

The legacy `terms_wanted: [...]` list keeps working unchanged when `terms:`
is absent. `web/lib/terms.ts` mirrors the window arithmetic so the settings
page can preview the effect of a lead-time change before the watcher runs;
keep the two in step.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import asdict, dataclass

# Seasons the rolling window generates, chronological within a year. Winter
# is parseable (an `include` may name one) but never generated: winter
# co-ops are rare and would mostly add noise.
SEASONS = ("Spring", "Summer", "Fall")
SEASON_START: dict[str, tuple[int, int]] = {
    "Spring": (1, 10), "Summer": (5, 20), "Fall": (8, 20), "Winter": (12, 1),
}
DEFAULT_LEAD_WEEKS = 3
DEFAULT_HORIZON_MONTHS = 14

_TERM_RE = re.compile(r"^\s*(Spring|Summer|Fall|Winter)\s+(20\d\d)\s*$", re.I)


def parse_term(term: str) -> tuple[str, int] | None:
    """'Fall 2026' -> ('Fall', 2026); None when it isn't a season + year."""
    m = _TERM_RE.match(term or "")
    if not m:
        return None
    return m.group(1).title(), int(m.group(2))


def term_start(term: str) -> dt.date | None:
    parsed = parse_term(term)
    if parsed is None:
        return None
    season, year = parsed
    month, day = SEASON_START[season]
    return dt.date(year, month, day)


def term_season(term: str) -> str | None:
    parsed = parse_term(term)
    return parsed[0] if parsed else None


def add_months(day: dt.date, months: int) -> dt.date:
    """Calendar-month arithmetic, clamping the day (Jan 31 + 1 -> Feb 28)."""
    month0 = day.month - 1 + months
    year = day.year + month0 // 12
    month = month0 % 12 + 1
    last = (dt.date(year + (month == 12), month % 12 + 1, 1)
            - dt.timedelta(days=1)).day
    return dt.date(year, month, min(day.day, last))


def window(today: dt.date, lead_weeks: int,
           horizon_months: int) -> tuple[dt.date, dt.date]:
    """(earliest, latest) term start the rolling window wants today."""
    return (today + dt.timedelta(weeks=lead_weeks),
            add_months(today, horizon_months))


def rolling_terms(today: dt.date, lead_weeks: int = DEFAULT_LEAD_WEEKS,
                  horizon_months: int = DEFAULT_HORIZON_MONTHS) -> list[str]:
    """Generated terms inside the window, chronological."""
    lo, hi = window(today, lead_weeks, horizon_months)
    out: list[str] = []
    for year in range(lo.year, hi.year + 1):
        for season in SEASONS:
            month, day = SEASON_START[season]
            if lo <= dt.date(year, month, day) <= hi:
                out.append(f"{season} {year}")
    return out


def sort_terms(terms: list[str]) -> list[str]:
    """Chronological; unparseable terms keep their relative order at the end."""
    known = [t for t in terms if term_start(t) is not None]
    unknown = [t for t in terms if term_start(t) is None]
    known.sort(key=lambda t: term_start(t) or dt.date.max)
    return known + unknown


@dataclass
class TermRow:
    """One term as the settings page shows it: wanted or not, and why."""
    term: str
    start: str                 # ISO date
    wanted: bool
    # auto: inside the window | included / excluded: pinned by config |
    # past: start is closer than lead_weeks (or gone) | beyond: past horizon
    status: str
    added_on: str              # ISO date the window first wants it
    drops_on: str              # ISO date the window stops wanting it


def canonical(term: str) -> str | None:
    """'  summer 2027 ' -> 'Summer 2027', the spelling generated terms and
    job.terms use; None when it isn't a term."""
    parsed = parse_term(term)
    return f"{parsed[0]} {parsed[1]}" if parsed else None


def canonical_list(terms: list[str] | None) -> list[str]:
    """Canonical spellings, unparseable entries dropped, order kept, no dups."""
    out: list[str] = []
    for raw in terms or []:
        c = canonical(str(raw))
        if c and c not in out:
            out.append(c)
    return out


def _config(cfg_terms: dict | None) -> tuple[int, int, list[str], list[str]]:
    cfg_terms = cfg_terms or {}
    lead = int(cfg_terms.get("lead_weeks", DEFAULT_LEAD_WEEKS))
    horizon = int(cfg_terms.get("horizon_months", DEFAULT_HORIZON_MONTHS))
    return (lead, horizon, canonical_list(cfg_terms.get("include")),
            canonical_list(cfg_terms.get("exclude")))


def term_rows(cfg_terms: dict | None, today: dt.date) -> list[TermRow]:
    """Every term worth showing: the window's terms, the pinned ones, and
    the term that most recently dropped out (so "Fall 2026: dropped Aug 3"
    explains its absence). Chronological."""
    lead, horizon, include, exclude = _config(cfg_terms)
    lo, hi = window(today, lead, horizon)
    auto = rolling_terms(today, lead, horizon)

    # The most recent generated term whose start fell before the window.
    previous: str | None = None
    for year in range(lo.year - 1, lo.year + 1):
        for season in SEASONS:
            month, day = SEASON_START[season]
            if dt.date(year, month, day) < lo:
                previous = f"{season} {year}"

    names = sort_terms(list(dict.fromkeys(
        auto + include + exclude + ([previous] if previous else []))))
    rows: list[TermRow] = []
    for term in names:
        start = term_start(term)
        assert start is not None  # everything above parsed
        if term in exclude:
            status, wanted = "excluded", False
        elif term in include:
            status, wanted = "included", True
        elif term in auto:
            status, wanted = "auto", True
        elif start < lo:
            status, wanted = "past", False
        else:
            status, wanted = "beyond", False
        rows.append(TermRow(
            term=term, start=start.isoformat(), wanted=wanted, status=status,
            added_on=add_months(start, -horizon).isoformat(),
            drops_on=(start - dt.timedelta(weeks=lead)).isoformat()))
    return rows


def wanted_terms(cfg: dict, today: dt.date) -> list[str]:
    """The user's wanted terms today, chronological. `terms:` (rolling)
    wins over the legacy `terms_wanted:` list when both are present."""
    cfg_terms = cfg.get("terms")
    if isinstance(cfg_terms, dict) and cfg_terms.get("rolling", True):
        return [r.term for r in term_rows(cfg_terms, today) if r.wanted]
    # Legacy list: canonical spellings where they parse, so "fall 2026"
    # still meets a job tagged "Fall 2026"; anything else passes through
    # untouched (a user may list a term shape this module doesn't know).
    legacy = [canonical(str(t)) or str(t)
              for t in cfg.get("terms_wanted") or [] if t]
    return sort_terms(list(dict.fromkeys(legacy)))


def rows_as_dicts(rows: list[TermRow]) -> list[dict]:
    return [asdict(r) for r in rows]
