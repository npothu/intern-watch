"""Watch preferences: the settings a user edits in the hosted web app.

The user yaml is operator config (sources, keywords, credentials, the LLM
block). The handful of preferences a person changes a few times a year -
which terms, how picky per season, the priority companies, remote, digest
time and recipients - live in the TrackerStore as one `watch` object the
Settings > Watch page writes. Each run overlays that object on the yaml
(store wins) and reports the resolved result back, so the page can show
what the watcher actually used.

Store shape (camelCase, written by convex/settings.ts setWatch):

    {terms: {leadWeeks, horizonMonths, include, exclude},
     rules: {Spring, Summer, Fall},
     priority: {companies, fromTracker, emailImmediately, subjectNames},
     location: {remoteCounts},
     email: {sendAtLocal, timezone, to}}

Every key is optional; an absent key leaves the yaml value in force.
"""

from __future__ import annotations

import copy
import datetime as dt
from pathlib import Path

from . import ledger, terms
from .normalize import norm_company

METRO_NAME = "Atlanta, GA"     # the only metro the rule engine knows today
METRO_RADIUS_MILES = 35


def _str_list(value) -> list[str] | None:
    if not isinstance(value, list):
        return None
    return [str(v).strip() for v in value if str(v).strip()]


def apply_overlay(cfg: dict, prefs: dict | None) -> dict:
    """Return a copy of the user yaml with the store's watch prefs applied.
    Unknown or malformed keys are ignored: a bad preference must never
    take the watcher down."""
    out = copy.deepcopy(cfg)
    if not isinstance(prefs, dict) or not prefs:
        return out

    t = prefs.get("terms")
    if isinstance(t, dict):
        block = dict(out.get("terms") or {})
        block["rolling"] = True
        if isinstance(t.get("leadWeeks"), int):
            block["lead_weeks"] = t["leadWeeks"]
        if isinstance(t.get("horizonMonths"), int):
            block["horizon_months"] = t["horizonMonths"]
        if (inc := _str_list(t.get("include"))) is not None:
            block["include"] = inc
        if (exc := _str_list(t.get("exclude"))) is not None:
            block["exclude"] = exc
        out["terms"] = block

    r = prefs.get("rules")
    if isinstance(r, dict):
        rules = dict(out.get("term_rules") or {})
        for season, preset in r.items():
            if season in terms.SEASON_START and isinstance(preset, str):
                rules[season] = preset
        out["term_rules"] = rules

    p = prefs.get("priority")
    if isinstance(p, dict):
        block = dict(out.get("priority") or {})
        if (companies := _str_list(p.get("companies"))) is not None:
            block["companies"] = companies
        for src, dst in (("fromTracker", "from_tracker"),
                         ("emailImmediately", "email_immediately"),
                         ("subjectNames", "subject_names")):
            if isinstance(p.get(src), bool):
                block[dst] = p[src]
        out["priority"] = block

    loc = prefs.get("location")
    if isinstance(loc, dict) and isinstance(loc.get("remoteCounts"), bool):
        block = dict(out.get("location") or {})
        block["remote_counts"] = loc["remoteCounts"]
        out["location"] = block

    e = prefs.get("email")
    if isinstance(e, dict):
        notify = out.setdefault("notify", {})
        email = notify.get("email")
        if isinstance(email, dict):
            hours = e.get("sendAtLocal")
            if isinstance(hours, list) and all(isinstance(h, int) for h in hours):
                email["send_at_local"] = sorted({h for h in hours if 0 <= h < 24})
            if isinstance(e.get("timezone"), str) and e["timezone"].strip():
                email["timezone"] = e["timezone"].strip()
            if (to := _str_list(e.get("to"))) is not None and to:
                email["to"] = ", ".join(to)
    return out


def tracker_companies(user: str, data_root: Path) -> dict[str, str]:
    """{normalized name: display name} for every employer in the user's
    applications ledger - a record exists once they applied, and it carries
    every later status (OA, interview, offer). Reads the committed backup
    file, which both store drivers keep current."""
    book = ledger.load_ledger(ledger.ledger_path(data_root)).get(user, {})
    out: dict[str, str] = {}
    for rec in book.values():
        company = str(rec.get("company") or "").strip()
        norm = norm_company(company)
        if norm and norm not in out:
            out[norm] = company
    return out


def watch_report(cfg: dict, today: dt.date, now: dt.datetime,
                 tracker: dict[str, str], legacy_rules: bool) -> dict:
    """The resolved preferences this run used, for the settings page."""
    cfg_terms = cfg.get("terms") if isinstance(cfg.get("terms"), dict) else None
    lead = int((cfg_terms or {}).get("lead_weeks", terms.DEFAULT_LEAD_WEEKS))
    horizon = int((cfg_terms or {}).get("horizon_months",
                                        terms.DEFAULT_HORIZON_MONTHS))
    if cfg_terms is not None and cfg_terms.get("rolling", True):
        rows = terms.rows_as_dicts(terms.term_rows(cfg_terms, today))
        rolling = True
    else:
        rows = [{"term": t, "start": (terms.term_start(t) or today).isoformat(),
                 "wanted": True, "status": "included", "added_on": "",
                 "drops_on": ""}
                for t in terms.wanted_terms(cfg, today)]
        rolling = False
    pri = cfg.get("priority") or {}
    loc = cfg.get("location") or {}
    email = (cfg.get("notify") or {}).get("email") or {}
    to_raw = email.get("to") or ""
    return {
        "reported_at": now.isoformat(),
        "terms": {
            "rolling": rolling, "lead_weeks": lead, "horizon_months": horizon,
            "include": list((cfg_terms or {}).get("include") or []),
            "exclude": list((cfg_terms or {}).get("exclude") or []),
            "rows": rows,
        },
        "rules": {"legacy": legacy_rules, **(cfg.get("term_rules") or {})},
        "priority": {
            "companies": list(pri.get("companies") or []),
            "from_tracker": bool(pri.get("from_tracker", False)),
            "tracker_companies": sorted(tracker.values(), key=str.casefold),
            "email_immediately": bool(pri.get("email_immediately", False)),
            "subject_names": bool(pri.get("subject_names", True)),
        },
        "location": {"metro": METRO_NAME, "radius_miles": METRO_RADIUS_MILES,
                     "remote_counts": bool(loc.get("remote_counts", True))},
        "email": {
            "send_at_local": list(email.get("send_at_local")
                                  or email.get("send_at_utc") or []),
            "timezone": email.get("timezone") or "UTC",
            "to": [a.strip() for a in to_raw.split(",") if a.strip()],
        },
    }
