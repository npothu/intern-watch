"""Answer-book coverage preflight - a "dress rehearsal" for the auto-apply
answer book.

Before spending a metered Browserbase session mid-application, this discovers
which of a form's questions the answer book already covers. It opens the apply
form READ-ONLY (no filling, no submitting, no account creation, no inbox),
harvests the field list with the same `_extract_fields` the agent filler uses,
and classifies each field by who would answer it:

  book  the deterministic answer book resolves it now (no LLM needed),
  llm   the book left it blank, so the LLM pass WOULD attempt it,
  none  it is on the user's do-not-fill list (never attempted by either).

The LLM attribution is deliberately CHEAP and honest: we never call the LLM.
`map_fields(fields, profile, llm_cfg=None)` is already a pure answer-book pass
returning exactly the fields the book resolves; every other fillable field is
one the real LLM pass would try (map_fields sends ALL fillable fields to the
LLM and lets it answer what it can). So "llm" here means "the LLM path would
attempt this", not "the LLM produced an answer" - the point is to find
recurring UNCOVERED questions cheaply, and any field the book misses is a
candidate for a new answer-book entry regardless of whether the LLM later
guesses it.

Workday has no field-list extraction entrypoint (its filler drives a
multi-step authenticated wizard), so Workday-family jobs are reported
unsupported with no browser session - never faked.

The reports accumulate under `state/apply_coverage/<date>/<short-key>.json`
into a corpus of recurring uncovered questions.
"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .. import dashboard
from .base import ATSFamily
from .dom import advance_to_application_form
from .fillers.agent import _extract_fields, map_fields

if TYPE_CHECKING:
    from playwright.sync_api import Page

    from .profile import ApplyProfile

ROOT = Path(__file__).resolve().parents[2]
COVERAGE_ROOT = ROOT / "state" / "apply_coverage"


def _skip_labels(profile: "ApplyProfile") -> list[str]:
    """The do-not-fill substrings, lower-cased - the same set map_fields drops
    before BOTH the answer book and the LLM see a field."""
    return [s.lower() for s in getattr(profile, "do_not_fill", []) if s]


def _is_skipped(field: dict, skip: list[str]) -> bool:
    lab = (field.get("label") or "").lower()
    return any(s in lab for s in skip)


def attribute_fields(form_fields: list[dict],
                     profile: "ApplyProfile") -> list[dict[str, Any]]:
    """Classify each extracted field as resolved_by book / llm / none.

    Pure: mirrors map_fields' own book pass (llm_cfg=None) and its do-not-fill
    skip, so no LLM is called and no tokens are spent. A field the book
    resolves is "book"; a do-not-fill field is "none"; every other field is
    one the LLM pass WOULD attempt, so it is "llm". Rows carry the extracted
    `required` flag (the submit-gate lower bound) for the report.
    """
    skip = _skip_labels(profile)
    # The answer-book-only pass: this is exactly the set the book resolves.
    book_map, _notes = map_fields(form_fields, profile, llm_cfg=None)
    booked = set(book_map)

    rows: list[dict[str, Any]] = []
    for f in form_fields:
        ref = f.get("ref")
        if not ref:
            continue
        if ref in booked:
            resolved_by = "book"
        elif _is_skipped(f, skip):
            resolved_by = "none"        # never attempted by book OR llm
        else:
            resolved_by = "llm"         # book missed it; the LLM pass would try
        rows.append({"label": (f.get("label") or "").strip(),
                     "ref": ref,
                     "required": bool(f.get("required")),
                     "resolved_by": resolved_by})
    return rows


def build_report(key: str, final_url: str, family: ATSFamily,
                 rows: list[dict[str, Any]] | None,
                 supported: bool = True) -> dict[str, Any]:
    """Assemble the coverage report dict. `rows` is None for unsupported
    families (Workday), which short-circuit before any browser visit."""
    rows = rows or []
    counts = {"book": 0, "llm": 0, "none": 0}
    required_uncovered = 0
    for r in rows:
        counts[r["resolved_by"]] = counts.get(r["resolved_by"], 0) + 1
        # A required field the book cannot resolve is the expensive gap: it
        # would gate a submit and force human intervention mid-session.
        if r["required"] and r["resolved_by"] != "book":
            required_uncovered += 1
    return {
        "key": key,
        "final_url": final_url,
        "family": family.value,
        "supported": supported,
        "fields_total": len(rows),
        "counts": counts,
        "required_uncovered": required_uncovered,
        "fields": rows,
    }


def report_path(key: str, today: dt.date | None = None,
                root: Path | None = None) -> Path:
    """Where a report is written: <root>/<YYYY-MM-DD>/<short-key>.json."""
    today = today or dt.datetime.now(dt.timezone.utc).date()
    root = root or COVERAGE_ROOT
    return root / today.isoformat() / f"{dashboard.short_key(key)}.json"


def write_report(report: dict[str, Any], key: str,
                 today: dt.date | None = None,
                 root: Path | None = None) -> Path:
    """Persist the report as JSON (mkdir parents). Returns the path written."""
    path = report_path(key, today=today, root=root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8")
    return path


def format_table(report: dict[str, Any]) -> str:
    """A compact fixed-width table of the per-field rows plus a summary line."""
    if not report.get("supported", True):
        return (f"family {report['family']} is unsupported for coverage "
                f"(no field-list extraction) - no browser session opened.")
    rows = report.get("fields", [])
    if not rows:
        return "(no fillable form fields found)"
    lines = [f"{'BY':<5} {'REQ':<4} {'REF':<28} LABEL"]
    for r in rows:
        req = "req" if r["required"] else "-"
        ref = str(r["ref"])
        if len(ref) > 28:
            ref = ref[:25] + "..."
        label = (r["label"] or "")[:60]
        lines.append(f"{r['resolved_by']:<5} {req:<4} {ref:<28} {label}")
    c = report["counts"]
    lines.append("")
    lines.append(f"{report['fields_total']} fields: "
                 f"book {c.get('book', 0)}, llm {c.get('llm', 0)}, "
                 f"none {c.get('none', 0)}; "
                 f"required uncovered: {report['required_uncovered']}")
    return "\n".join(lines)


def coverage_for_page(page: "Page", key: str, final_url: str,
                      family: ATSFamily,
                      profile: "ApplyProfile") -> dict[str, Any]:
    """Extract the live form's fields and attribute them - the browser-touching
    half. Read-only apart from Apply-style navigation clicks: when the URL is a
    job POSTING rather than the form, we advance to the form exactly like the
    agent filler does (never a submit click), then re-extract."""
    form_fields = _extract_fields(page)
    if not form_fields and advance_to_application_form(page):
        try:
            page.wait_for_timeout(1500)     # let a late SPA form render
        except Exception:
            pass
        form_fields = _extract_fields(page)
    rows = attribute_fields(form_fields, profile)
    return build_report(key, final_url, family, rows, supported=True)


def run_coverage(key: str, final_url: str, family: ATSFamily,
                 profile: "ApplyProfile",
                 today: dt.date | None = None,
                 root: Path | None = None) -> tuple[dict[str, Any], Path]:
    """The whole preflight for one job: Workday short-circuits BEFORE any
    browser session; everything else gets a read-only page visit. Returns
    (report, path written)."""
    if family is ATSFamily.workday:
        report = build_report(key, final_url, family, None, supported=False)
        return report, write_report(report, key, today=today, root=root)

    from .driver import browser_session    # lazy: needs Playwright

    with browser_session(profile, family) as page:
        page.goto(final_url, wait_until="domcontentloaded")
        try:
            page.wait_for_timeout(1000)     # SPA boards render after DOM-ready
        except Exception:
            pass
        report = coverage_for_page(page, key, final_url, family, profile)
    return report, write_report(report, key, today=today, root=root)
