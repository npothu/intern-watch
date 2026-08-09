"""Shared resume build core + per-job entry point.

`__main__.main` (the manual CLI) and the watcher's auto-build both want the
exact same pipeline: analyze JD -> select -> (optional) LLM rewrite -> page-fit
-> render -> report. That core lives here so the CLI stays a thin wrapper and
the watcher can build a resume from a bare `Job` with no manual JD paste.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path

import yaml

from .. import dashboard
from . import fit, jd, render, select, tailor
from .bank import Bank, load_bank
from .jd_source import acquire_jd

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[2]

# Default config keeps the watcher's auto-build OFF: an absent/empty
# `resume_build` block must mean "behave exactly as before" so enabling is
# always an explicit opt-in.
_RESUME_BUILD_DEFAULTS = {
    "enabled": False,
    "modes": [],            # subset of {commit, email, dashboard}
    "use_llm": True,
    "allow_scrape": True,
    "max_per_run": 20,
}
_VALID_MODES = frozenset({"commit", "email", "dashboard"})


def resume_build_cfg(user_cfg: dict | None) -> dict:
    """The `resume_build:` block merged over defaults. Unknown modes are
    dropped (not an error) so a typo can't silently enable an unintended
    delivery path — the watcher only acts on modes it understands."""
    merged = dict(_RESUME_BUILD_DEFAULTS)
    block = (user_cfg or {}).get("resume_build") or {}
    merged.update(block)

    # `modes` comes from user YAML: a scalar or mapping there must degrade to
    # "no modes", not blow up the iteration below.
    raw_modes = merged.get("modes") or []
    modes = raw_modes if isinstance(raw_modes, list) else []
    valid: list[str] = []
    for m in modes:
        if m in _VALID_MODES:
            valid.append(m)
        else:
            log.warning("resume_build: ignoring unknown mode %r", m)
    merged["modes"] = valid
    return merged


@dataclass
class BuildResult:
    out_path: Path
    report: str
    pages: float
    used_llm: bool


def resume_llm_cfg(user: str, root: Path) -> dict:
    """Resume builds prefer a dedicated `resume_llm:` block over the watcher's
    `llm:` block — rewriting prose wants a stronger model than the watcher's
    cheap classification calls, and the two shouldn't have to share one
    setting."""
    user_yaml = root / "users" / f"{user}.yaml"
    if not user_yaml.exists():
        return {}
    data = yaml.safe_load(user_yaml.read_text(encoding="utf-8")) or {}
    return data.get("resume_llm") or data.get("llm") or {}


def _report(plan: select.ResumePlan, profile: jd.JDProfile,
            out_path: Path, used_llm: bool) -> str:
    lines = [f"# Resume build: {out_path.name}", ""]
    lines.append(f"- estimated length: **{fit.estimate_pages(plan):.2f} pages**")
    lines.append(f"- LLM bullet rewrite: {'on' if used_llm else 'off'}")
    lines.append("")
    lines.append("## Project order (score)")
    for p in plan.projects:
        marker = " *(LLM-rewritten)*" if p.llm_rewritten else ""
        lines.append(f"1. {p.name} — {p.score:.0f}, variant `{p.variant}`{marker}")
    lines.append("")
    lines.append("## Top JD keywords")
    top = ", ".join(f"{s} ({profile.weights[s]:.0f})"
                    for s in profile.ranked()[:12])
    lines.append(top or "(none recognized)")
    if plan.gaps:
        lines.append("")
        lines.append("## Keyword gaps (JD asks, bank lacks — do NOT fake)")
        lines.append(", ".join(plan.gaps))
    if plan.notes:
        lines.append("")
        lines.append("## Build notes")
        lines.extend(f"- {n}" for n in plan.notes)
    return "\n".join(lines) + "\n"


def build_resume(jd_text: str, bank: Bank, *, company: str, out_path: Path,
                 llm_cfg: dict, use_llm: bool = True,
                 max_projects: int = select.MAX_PROJECTS) -> BuildResult:
    """Run the full deterministic+LLM pipeline and render to `out_path`.
    Returns the report string and page estimate so callers (CLI, watcher)
    can decide what to print / how to exit."""
    profile = jd.analyze(jd_text)
    plan = select.build_plan(bank, profile, max_projects=max_projects)

    used_llm = False
    if use_llm:
        tailor.tailor(plan, jd_text, llm_cfg)
        used_llm = any(p.llm_rewritten for p in plan.projects)

    fit.fit_plan(plan)
    render.render(plan, out_path)

    report = _report(plan, profile, out_path, used_llm)
    pages = fit.estimate_pages(plan)
    return BuildResult(out_path=out_path, report=report, pages=pages,
                       used_llm=used_llm)


def bank_path(user: str, root: Path) -> Path:
    """users/<user>_resume.json, falling back to the SOLE *_resume.json when
    the exact name is absent. The template rename left the watcher user
    (`example`) without a bank of its own while the real bank kept its
    owner's name -- without the fallback every dashboard/on-demand build for
    the renamed user dies on FileNotFoundError. Ambiguity (several banks,
    none matching) falls through to the exact path so load_bank raises the
    honest error instead of guessing."""
    exact = root / "users" / f"{user}_resume.json"
    if exact.exists():
        return exact
    banks = sorted((root / "users").glob("*_resume.json"))
    if len(banks) == 1:
        log.info("resume bank %s missing; falling back to %s",
                 exact.name, banks[0].name)
        return banks[0]
    return exact


def out_name(bank: Bank, company: str) -> str:
    """`First_Last_Company.docx` -- exactly what an employer sees when the
    file is uploaded, so no hashes or counters in here. Two jobs at the same
    company are kept apart by build_for_job's per-job subdirectory instead."""
    first = bank.header.name.split()[0]
    surname = bank.header.name.split()[-1]
    slug = re.sub(r"[^A-Za-z0-9]+", "", company) or "Tailored"
    return f"{first}_{surname}_{slug}.docx"


def build_for_job(job, user: str, *, out_dir: Path, root: Path,
                  use_llm: bool = True, allow_scrape: bool = True,
                  client=None, jd_text: str | None = None) -> BuildResult | None:
    """Build a tailored resume for `job` into `out_dir`. A caller-supplied
    `jd_text` (e.g. pasted into a `/resume` comment) is used verbatim and
    bypasses acquisition entirely — the escape hatch for employers that block
    scraping (Tesla et al.). Otherwise the JD is acquired automatically.
    Returns None (logged) when no JD is available at all."""
    text = jd_text.strip() if jd_text else ""
    if not text:
        text = acquire_jd(job, client=client, allow_scrape=allow_scrape) or ""
    if not text:
        log.info("resume: no JD acquired for %s (%s), skipping",
                 job.dedup_key, job.company)
        return None
    jd_text = text

    bank = load_bank(bank_path(user, root))
    # uniqueness lives in the per-job subdir (the dashboard short key), NOT
    # the filename: the .docx name is employer-facing and must stay clean
    out_path = (out_dir / dashboard.short_key(job.dedup_key)
                / out_name(bank, job.company))
    llm_cfg = resume_llm_cfg(user, root)
    return build_resume(jd_text, bank, company=job.company, out_path=out_path,
                        llm_cfg=llm_cfg, use_llm=use_llm)
