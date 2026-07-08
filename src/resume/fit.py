"""Deterministic single-page fitting.

Estimates the rendered height of a ResumePlan using embedded Times font
metrics (Adobe core Times-Roman/Times-Bold AFM widths — Times New Roman is
metrically near-identical), then applies condense/drop moves until the plan
fits one page:

  1. condense community entries to their shortest variant
  2. condense projects to their shortest variant, least relevant first
  3. drop the least relevant project (down to MIN_PROJECTS)

The old builder had no fitting step at all — page count was checked by hand
after the fact, which is why resumes sometimes shipped at 1.5 pages.
"""

from __future__ import annotations

import math

from .select import MIN_PROJECTS, PlannedEntry, ResumePlan
from .spec import (BULLET_INDENT_TW, CONTENT_H_TW, CONTENT_W_TW,
                   LINE_HEIGHT_EM, SECTION_SPACE_AFTER_PT, SZ_BODY,
                   SZ_CONTACT, SZ_EDU, SZ_NAME, SZ_SECTION, tw_to_pt)

# Width tables: units per 1000 em, chars 32..126.
_ROMAN = [
    250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333,
    250, 278,
    500, 500, 500, 500, 500, 500, 500, 500, 500, 500,
    278, 278, 564, 564, 564, 444, 921,
    722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722,
    722, 556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611,
    333, 278, 333, 469, 500, 333,
    444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500,
    500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444,
    480, 200, 480, 541,
]
_BOLD = [
    250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333,
    250, 278,
    500, 500, 500, 500, 500, 500, 500, 500, 500, 500,
    333, 333, 570, 570, 570, 500, 930,
    722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722,
    778, 611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667,
    333, 278, 333, 581, 500, 333,
    500, 556, 444, 556, 444, 333, 500, 556, 278, 333, 556, 278, 833, 556,
    500, 556, 556, 444, 389, 333, 556, 500, 722, 500, 500, 444,
    394, 220, 394, 520,
]
_EXTRA = {"–": 500, "—": 1000, "‘": 333, "’": 333,
          "“": 444, "”": 444, "●": 604, "·": 250}
_DEFAULT_MILLE = 550
_FUDGE = 1.03          # AFM vs real TNR + ignored kerning, err wide
FILL_FACTOR = 0.98     # require estimates to clear 98% of the page
BUDGET_PT = tw_to_pt(CONTENT_H_TW) * FILL_FACTOR   # 720pt * 0.98


def _mille(ch: str, bold: bool) -> int:
    code = ord(ch)
    if 32 <= code <= 126:
        return (_BOLD if bold else _ROMAN)[code - 32]
    return _EXTRA.get(ch, _DEFAULT_MILLE)


def text_width_pt(text: str, size_pt: float, bold: bool = False) -> float:
    return sum(_mille(c, bold) for c in text) / 1000.0 * size_pt * _FUDGE


def wrap_lines(text: str, avail_pt: float, size_pt: float,
               bold: bool = False) -> int:
    """Greedy word-wrap line count, the same way Word breaks lines."""
    if not text.strip():
        return 1
    space_w = text_width_pt(" ", size_pt, bold)
    lines, cur = 1, 0.0
    for word in text.split():
        w = text_width_pt(word, size_pt, bold)
        if w > avail_pt:                       # over-long word: hard-break
            lines += math.ceil((cur + w) / avail_pt) - 1
            cur = (cur + w) % avail_pt
            continue
        if cur == 0.0:
            cur = w
        elif cur + space_w + w <= avail_pt:
            cur += space_w + w
        else:
            lines += 1
            cur = w
    return lines


def _line(sz: float) -> float:
    return sz * LINE_HEIGHT_EM


def _heading_lines(entry: PlannedEntry, content_w: float) -> int:
    left = sum(text_width_pt(r.text, SZ_BODY, r.bold)
               for r in entry.heading_runs)
    date_w = text_width_pt(entry.date, SZ_BODY)
    min_gap = 18.0   # smallest acceptable gap before the right-tabbed date
    return 1 if left + min_gap + date_w <= content_w else 2


def _entry_height(entry: PlannedEntry, content_w: float) -> float:
    h = _heading_lines(entry, content_w) * _line(SZ_BODY)
    bullet_w = content_w - tw_to_pt(BULLET_INDENT_TW)
    for b in entry.bullets:
        h += wrap_lines(b, bullet_w, SZ_BODY) * _line(SZ_BODY)
    return h


def _work_height(job, content_w: float) -> float:
    """Two heading lines (company|location, role|date) plus bullets."""
    h = 0.0
    for left_text, left_bold, right in ((job.company, True, job.location),
                                        (job.role, False, job.date)):
        left = text_width_pt(left_text, SZ_BODY, left_bold)
        right_w = text_width_pt(right, SZ_BODY)
        h += (1 if left + 18.0 + right_w <= content_w else 2) * _line(SZ_BODY)
    bullet_w = content_w - tw_to_pt(BULLET_INDENT_TW)
    for b in job.bullets:
        h += wrap_lines(b, bullet_w, SZ_BODY) * _line(SZ_BODY)
    return h


def estimate_height_pt(plan: ResumePlan) -> float:
    w = tw_to_pt(CONTENT_W_TW)    # 540pt
    h = 0.0
    # header
    h += wrap_lines(plan.header_name, w, SZ_NAME, bold=True) * _line(SZ_NAME)
    h += wrap_lines(plan.contact_line, w, SZ_CONTACT) * _line(SZ_CONTACT)
    links = plan.citizen_prefix + " | ".join(l["text"] for l in plan.links)
    h += wrap_lines(links, w, SZ_CONTACT) * _line(SZ_CONTACT)
    # education
    h += _line(SZ_SECTION) + SECTION_SPACE_AFTER_PT
    h += _line(SZ_EDU)                                    # institution+date
    for line in (plan.degree, plan.threads, plan.gpa):
        if line:
            h += wrap_lines(line, w, SZ_EDU) * _line(SZ_EDU)
    if plan.study_abroad_text:
        h += _line(SZ_EDU)
    h += wrap_lines(f"Coursework: {plan.coursework}", w, SZ_EDU) * _line(SZ_EDU)
    # work experience
    if plan.work_experience:
        h += _line(SZ_BODY)                              # separator
        h += _line(SZ_SECTION) + SECTION_SPACE_AFTER_PT
        for i, job in enumerate(plan.work_experience):
            h += _work_height(job, w)
            if i < len(plan.work_experience) - 1:
                h += _line(SZ_BODY)
    # projects
    h += _line(SZ_BODY)                                   # separator
    h += _line(SZ_SECTION) + SECTION_SPACE_AFTER_PT
    for i, p in enumerate(plan.projects):
        h += _entry_height(p, w)
        if i < len(plan.projects) - 1:
            h += _line(SZ_BODY)
    # community
    h += _line(SZ_BODY)                                   # separator
    h += _line(SZ_SECTION) + SECTION_SPACE_AFTER_PT
    for i, c in enumerate(plan.community):
        h += _entry_height(c, w)
        if i < len(plan.community) - 1:
            h += _line(SZ_BODY)
    # skills
    h += _line(SZ_BODY)                                   # separator
    h += _line(SZ_SECTION) + SECTION_SPACE_AFTER_PT
    for label, value in (("Languages:", plan.languages),
                         ("Systems & Tools:", plan.tools),
                         ("Certifications:", plan.certifications)):
        if value:
            h += wrap_lines(f"{label} {value}", w, SZ_EDU) * _line(SZ_EDU)
    return h


def estimate_pages(plan: ResumePlan) -> float:
    return estimate_height_pt(plan) / tw_to_pt(CONTENT_H_TW)


def _condense(entry: PlannedEntry) -> bool:
    """Switch to the shortest bank variant; True if that changed anything."""
    shortest = min(entry.available_variants,
                   key=lambda k: sum(map(len, entry.available_variants[k])))
    new = entry.available_variants[shortest]
    if entry.bullets == new:
        return False
    entry.bullets = list(new)
    entry.variant = shortest
    entry.llm_rewritten = False
    return True


def _expand(plan: ResumePlan, snapshots: dict) -> None:
    """Once the plan fits, hand back space to the most relevant entries:
    restore their pre-fit bullets (incl. LLM rewrites) where they still fit."""
    order = (list(plan.work_experience)
             + sorted(plan.projects, key=lambda p: -p.score)
             + list(plan.community))
    for entry in order:
        snap = snapshots.get(id(entry))
        if snap is None or entry.bullets == snap["bullets"]:
            continue
        saved = (entry.bullets, entry.variant, entry.llm_rewritten)
        entry.bullets = list(snap["bullets"])
        entry.variant = snap["variant"]
        entry.llm_rewritten = snap["llm_rewritten"]
        if estimate_height_pt(plan) > BUDGET_PT:
            entry.bullets, entry.variant, entry.llm_rewritten = saved
        else:
            plan.notes.append(
                f"restored '{entry.variant}' (room left): {entry.name}")


def fit_plan(plan: ResumePlan) -> ResumePlan:
    """Mutate plan with condense/drop moves until it fits one page, then
    re-expand the highest-scoring entries into any space left over."""
    if estimate_height_pt(plan) <= BUDGET_PT:
        return plan

    snapshots = {id(e): {"bullets": list(e.bullets), "variant": e.variant,
                         "llm_rewritten": e.llm_rewritten}
                 for e in plan.work_experience + plan.projects + plan.community}

    fitted = False
    moves = []
    for c in plan.community:
        moves.append(("condense community", c))
    for p in sorted(plan.projects, key=lambda p: p.score):
        moves.append(("condense project", p))

    for kind, entry in moves:
        if _condense(entry):
            plan.notes.append(f"{kind} to '{entry.variant}': {entry.name}")
            if estimate_height_pt(plan) <= BUDGET_PT:
                fitted = True
                break

    # Shed extra community entries before cutting into the project list:
    # they are the lowest-signal content (the human-made reference keeps
    # only the most relevant one). Keep at least the first.
    while not fitted and len(plan.community) > 1:
        dropped = plan.community.pop()
        plan.notes.append(f"dropped community (page fit): {dropped.name}")
        fitted = estimate_height_pt(plan) <= BUDGET_PT

    while not fitted and len(plan.projects) > MIN_PROJECTS:
        dropped = min(plan.projects, key=lambda p: p.score)
        plan.projects.remove(dropped)
        plan.notes.append(f"dropped (page fit): {dropped.name}")
        fitted = estimate_height_pt(plan) <= BUDGET_PT

    # Last resort before failing the build: shed individual trailing bullets
    # rather than giving up. A marginal overflow (e.g. 1.01 pages after the
    # shortest variants are already in use and the project list is down to
    # MIN_PROJECTS) is usually one bullet too many, and cutting a whole
    # project would be too blunt. Trim lowest-signal first — community, then
    # projects by ascending score — and always leave >=1 bullet so no entry
    # renders as a headless heading.
    while not fitted:
        candidate = next(
            (e for e in sorted(plan.community, key=lambda e: e.score)
                       + sorted(plan.projects, key=lambda p: p.score)
             if len(e.bullets) > 1),
            None)
        if candidate is None:
            break
        candidate.bullets.pop()
        candidate.llm_rewritten = False
        plan.notes.append(f"trimmed a bullet (page fit): {candidate.name}")
        fitted = estimate_height_pt(plan) <= BUDGET_PT

    if fitted:
        _expand(plan, snapshots)
        return plan

    plan.notes.append(
        f"WARNING: still ~{estimate_pages(plan):.2f} pages after all "
        f"condense/drop moves — trim the bank or lower max_projects")
    return plan
