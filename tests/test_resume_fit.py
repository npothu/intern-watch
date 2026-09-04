"""Width estimation and the single-page fit loop."""

from src.resume import fit, jd, select
from src.resume.bank import load_bank

BANK = load_bank("tests/fixtures/resume_bank.json")


def _plan(fixtures, name="jd_ml_intern.txt", **kw):
    profile = jd.analyze((fixtures / name).read_text(encoding="utf-8"))
    return select.build_plan(BANK, profile, **kw)


# ---- text metrics ----

def test_width_narrow_vs_wide_glyphs():
    assert fit.text_width_pt("iiii", 11) < fit.text_width_pt("MMMM", 11)


def test_width_bold_wider_than_roman():
    s = "Hello world"
    assert fit.text_width_pt(s, 11, bold=True) > fit.text_width_pt(s, 11)


def test_width_scales_with_size():
    assert fit.text_width_pt("abc", 22) > 1.9 * fit.text_width_pt("abc", 11)


def test_wrap_line_counts_plausible():
    # ~100 chars of 11pt Times fit a 504pt bullet column; 1000 chars of
    # average prose should land near 10 lines, certainly 8-14
    text = ("Implemented a data processing service handling concurrent "
            "requests with caching and retries across regions " * 10).strip()
    lines = fit.wrap_lines(text, 504.0, 11.0)
    assert 8 <= lines <= 14


def test_wrap_short_text_is_one_line():
    assert fit.wrap_lines("Reduced overhead by 25%", 504.0, 11.0) == 1


def test_wrap_empty_is_one_line():
    assert fit.wrap_lines("", 504.0, 11.0) == 1


# ---- page estimation & fitting ----

def test_default_plan_fits_one_page(fixtures):
    plan = _plan(fixtures)
    fit.fit_plan(plan)
    assert fit.estimate_pages(plan) <= 1.0


def test_all_three_jds_fit(fixtures):
    for name in ("jd_ml_intern.txt", "jd_backend_intern.txt",
                 "jd_embedded_intern.txt"):
        plan = _plan(fixtures, name)
        fit.fit_plan(plan)
        assert fit.estimate_pages(plan) <= 1.0, name


def test_condense_prefers_shortest_variant(fixtures):
    plan = _plan(fixtures)
    entry = plan.projects[0]
    entry.bullets = entry.available_variants["base"]
    fit._condense(entry)
    total = sum(map(len, entry.bullets))
    for variant in entry.available_variants.values():
        assert total <= sum(map(len, variant))


def test_overfull_plan_gets_condensed_or_dropped(fixtures, monkeypatch):
    # Build past the default cap so fit has projects to condense or drop
    # regardless of select.MAX_PROJECTS.
    plan = _plan(fixtures, max_projects=6)
    before = [(p.name, p.variant) for p in plan.projects]
    # shrink the page so the default plan can't possibly fit
    monkeypatch.setattr(fit, "BUDGET_PT", 300.0)
    fit.fit_plan(plan)
    after = [(p.name, p.variant) for p in plan.projects]
    assert after != before
    assert len(plan.projects) >= select.MIN_PROJECTS
    assert plan.notes  # decisions were logged


def test_impossible_budget_warns_not_loops(fixtures, monkeypatch):
    plan = _plan(fixtures, max_projects=6)
    monkeypatch.setattr(fit, "BUDGET_PT", 10.0)
    fit.fit_plan(plan)   # must terminate
    assert any(n.startswith("WARNING") for n in plan.notes)
    assert len(plan.projects) == select.MIN_PROJECTS


def test_marginal_overflow_trims_bullets_instead_of_failing(fixtures,
                                                            monkeypatch):
    """A sliver over budget (the real-world ~1.01-page failure) must be
    resolved by shedding trailing bullets, not left over-budget. After the
    shortest variants and project drops, the trim step is the last resort."""
    # Height reachable by condense+drop ALONE (shortest variants, projects at
    # MIN_PROJECTS, one community entry) — the floor of the old ladder.
    plan = _plan(fixtures)
    for c in plan.community:
        fit._condense(c)
    for p in plan.projects:
        fit._condense(p)
    while len(plan.projects) > select.MIN_PROJECTS:
        plan.projects.remove(min(plan.projects, key=lambda p: p.score))
    while len(plan.community) > 1:
        plan.community.pop()
    floor_h = fit.estimate_height_pt(plan)

    # Budget just below that floor: condense+drop cannot close the gap, so the
    # bullet trim is the only path to a fit.
    plan = _plan(fixtures)
    monkeypatch.setattr(fit, "BUDGET_PT", floor_h - 15.0)
    fit.fit_plan(plan)

    assert fit.estimate_height_pt(plan) <= fit.BUDGET_PT      # actually fits
    assert any(n.startswith("trimmed a bullet") for n in plan.notes)
    assert not any(n.startswith("WARNING") for n in plan.notes)
    assert len(plan.projects) == select.MIN_PROJECTS          # no project cut
    assert all(p.bullets for p in plan.projects)              # none headless


def test_fit_does_not_leave_page_too_empty(fixtures):
    """The condense/drop loop must hand unused space back to top projects:
    a fitted page should be reasonably full, not over-trimmed."""
    plan = _plan(fixtures)
    fit.fit_plan(plan)
    pages = fit.estimate_pages(plan)
    assert pages <= 1.0
    assert pages >= 0.85


def test_expand_restores_top_project_first(fixtures, monkeypatch):
    plan = _plan(fixtures)
    fit.fit_plan(plan)
    restored = [n.split(": ", 1)[1] for n in plan.notes
                if n.startswith("restored")]
    scores = {p.name: p.score for p in plan.projects}
    restored_projects = [n for n in restored if n in scores]
    if restored_projects:   # expansion happened: highest-scored came back first
        vals = [scores[n] for n in restored_projects]
        assert vals == sorted(vals, reverse=True)


def test_estimate_decreases_when_condensing(fixtures):
    plan = _plan(fixtures)
    h_before = fit.estimate_height_pt(plan)
    for p in plan.projects:
        fit._condense(p)
    assert fit.estimate_height_pt(plan) <= h_before


def test_long_heading_counts_two_lines():
    from src.resume.bank import HeadingRun
    from src.resume.select import PlannedEntry
    short = PlannedEntry(name="x", heading_runs=[HeadingRun(text="Short", bold=True)],
                         date="Jan 2026", bullets=["b"], variant="base",
                         available_variants={"base": ["b"]})
    long_title = "A Very Long Project Title " * 4
    long = short.model_copy(update={"heading_runs": [
        HeadingRun(text=long_title, bold=True),
        HeadingRun(text="Python, Docker, Kubernetes, Terraform", italics=True)]})
    assert fit._heading_lines(short, 540.0) == 1
    assert fit._heading_lines(long, 540.0) == 2
