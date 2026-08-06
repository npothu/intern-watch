"""Score bank projects against a JD profile and assemble a ResumePlan.

Everything here is deterministic: same bank + same JD -> same plan.
The plan is the single intermediate representation consumed by both the
page-fit estimator (fit.py) and the renderer (render.py).
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from . import jd as jdmod
from .bank import (Bank, CommunityEntry, HeadingRun, Project, SkillItem,
                   WorkExperience)

# match-strength multipliers: where in the project a JD skill was found
W_TAG = 3.0      # explicit tags (maps-to) are the strongest signal
W_TECH = 2.0     # listed tech stack
W_TEXT = 1.0     # bullet prose

MAX_PROJECTS = 6
MIN_PROJECTS = 4
MAX_TECH_ITEMS = 6
MAX_LINE_ITEMS = 12      # skills-line cap; JD-matched entries always survive


class PlannedEntry(BaseModel):
    name: str
    heading_runs: list[HeadingRun]      # everything left of the date
    date: str
    bullets: list[str]
    variant: str
    score: float = 0.0
    # variant -> bullets, for fit.py's condense step (LLM rewrites are not
    # reflected here on purpose: condensing falls back to bank text)
    available_variants: dict[str, list[str]] = Field(default_factory=dict)
    llm_rewritten: bool = False


class WorkEntry(BaseModel):
    """A paid role: two heading lines (company|location, role|date) then
    bullets. Always kept (never dropped for page-fit), but condensable."""
    name: str
    company: str
    location: str
    role: str
    date: str
    bullets: list[str]
    variant: str = "base"
    available_variants: dict[str, list[str]] = Field(default_factory=dict)
    llm_rewritten: bool = False


class ResumePlan(BaseModel):
    header_name: str
    contact_line: str
    citizen_prefix: str
    links: list[dict]
    institution: str
    grad_date: str
    degree: str
    threads: str
    gpa: str
    graduate_degree_text: str = ""
    graduate_degree_date: str = ""
    study_abroad_text: str = ""
    study_abroad_date: str = ""
    coursework: str
    languages: str
    tools: str
    certifications: str = ""
    work_experience: list[WorkEntry] = Field(default_factory=list)
    projects: list[PlannedEntry]
    community: list[PlannedEntry]
    gaps: list[str] = Field(default_factory=list)      # JD skills user lacks
    notes: list[str] = Field(default_factory=list)     # build decisions log


def _searchable(project: Project) -> tuple[str, str, str]:
    tags = " ".join(project.tags)
    tech = " ".join(project.tech)
    text = " ".join(b for v in project.bullets.values() for b in v)
    return tags, tech, text


def score_project(project: Project, profile: jdmod.JDProfile) -> float:
    tags, tech, text = _searchable(project)
    total = 0.0
    for skill, weight in profile.weights.items():
        if jdmod.matches(skill, tags):
            strength = W_TAG
        elif jdmod.matches(skill, tech):
            strength = W_TECH
        elif jdmod.matches(skill, text):
            strength = W_TEXT
        else:
            continue
        total += weight * strength
    return total


def pick_variant(project: Project, profile: jdmod.JDProfile) -> str:
    """Variant whose text hits the most JD weight; ties go to 'base'."""
    def variant_score(name: str) -> float:
        text = " ".join(project.bullets[name])
        return sum(w for s, w in profile.weights.items()
                   if jdmod.matches(s, text))
    return max(sorted(project.bullets, key=lambda v: v != "base"),
               key=variant_score)


def reorder_tech(tech: list[str], profile: jdmod.JDProfile) -> list[str]:
    """JD-matched tech first (heavier first), bank order otherwise."""
    def key(item: str):
        hit = max((w for s, w in profile.weights.items()
                   if jdmod.matches(s, item)), default=0.0)
        return (-hit, tech.index(item))
    return sorted(tech, key=key)[:MAX_TECH_ITEMS]


def reorder_skills(items: list[SkillItem], profile: jdmod.JDProfile,
                   cap: int = MAX_LINE_ITEMS) -> list[str]:
    """Skill-line entries: JD-matched first by weight, bank order otherwise,
    truncated to `cap`. An item matches if any of its keywords is hit by any
    JD skill alias."""
    def jd_weight(item: SkillItem) -> float:
        text = " ".join(item.match_keywords())
        return max((w for s, w in profile.weights.items()
                    if jdmod.matches(s, text)), default=0.0)
    ordered = sorted(items, key=lambda it: (-jd_weight(it), items.index(it)))
    return [it.name for it in ordered[:cap]]


def find_gaps(bank: Bank, profile: jdmod.JDProfile) -> list[str]:
    """JD skills that match nothing in the bank — never fabricate these."""
    inventory = " ".join(
        [" ".join(it.match_keywords())
         for group in (bank.skills.languages, bank.skills.tools,
                       bank.skills.coursework) for it in group]
        + [" ".join(_searchable(p)) for p in bank.projects.values()])
    return [s for s in profile.ranked() if not jdmod.matches(s, inventory)]


def _project_entry(name: str, project: Project, profile: jdmod.JDProfile,
                   score: float) -> PlannedEntry:
    variant = pick_variant(project, profile)
    tech = ", ".join(reorder_tech(project.tech, profile))
    return PlannedEntry(
        name=name,
        heading_runs=[HeadingRun(text=f"{name} | ", bold=True),
                      HeadingRun(text=tech, italics=True)],
        date=project.date,
        bullets=list(project.bullets[variant]),
        variant=variant,
        score=score,
        available_variants=project.bullets,
    )


def _work_entry(name: str, entry: WorkExperience) -> WorkEntry:
    return WorkEntry(
        name=name,
        company=name,
        location=entry.location,
        role=entry.role,
        date=entry.date,
        bullets=list(entry.bullets["base"]),
        available_variants=entry.bullets,
    )


def _community_entry(name: str, entry: CommunityEntry) -> PlannedEntry:
    return PlannedEntry(
        name=name,
        heading_runs=entry.heading_runs,
        date=entry.date,
        bullets=list(entry.bullets["base"]),
        variant="base",
        available_variants=entry.bullets,
    )


def build_plan(bank: Bank, profile: jdmod.JDProfile,
               max_projects: int = MAX_PROJECTS) -> ResumePlan:
    names = list(bank.projects)
    scored = sorted(names,
                    key=lambda n: (-score_project(bank.projects[n], profile),
                                   names.index(n)))
    chosen = scored[:max_projects]

    edu = bank.education
    plan = ResumePlan(
        header_name=bank.header.name,
        contact_line=bank.header.contact_line,
        citizen_prefix=bank.header.citizen_prefix,
        links=[link.model_dump() for link in bank.header.links],
        institution=edu.institution,
        grad_date=edu.grad_date,
        degree=edu.degree,
        threads=edu.threads,
        gpa=edu.gpa,
        graduate_degree_text=(edu.graduate_degree.degree
                              if edu.graduate_degree else ""),
        graduate_degree_date=(edu.graduate_degree.grad_date
                              if edu.graduate_degree else ""),
        study_abroad_text=edu.study_abroad.text if edu.study_abroad else "",
        study_abroad_date=edu.study_abroad.date if edu.study_abroad else "",
        coursework=", ".join(reorder_skills(bank.skills.coursework, profile)),
        languages=", ".join(reorder_skills(bank.skills.languages, profile)),
        tools=", ".join(reorder_skills(bank.skills.tools, profile)),
        certifications=", ".join(bank.skills.certifications),
        work_experience=[_work_entry(n, e)
                         for n, e in bank.work_experience.items()],
        projects=[_project_entry(n, bank.projects[n], profile,
                                 score_project(bank.projects[n], profile))
                  for n in chosen],
        community=[_community_entry(n, e) for n, e in bank.community.items()],
        gaps=find_gaps(bank, profile),
    )
    for name in scored[max_projects:]:
        plan.notes.append(f"dropped (low relevance): {name}")
    return plan
