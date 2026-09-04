"""Resume bank: every project/bullet variant a user can draw from.

One JSON file per user (users/<name>_resume.json), never edited per-job.
The selector picks projects, variants, and skill orderings from it; the
bank itself stays the single source of truth for what the user has done.
"""

from __future__ import annotations

import json
from pathlib import Path

from pydantic import BaseModel, Field, model_validator


class Link(BaseModel):
    text: str
    url: str


class Header(BaseModel):
    name: str
    contact_line: str
    citizen_prefix: str = ""
    links: list[Link] = Field(default_factory=list)


class StudyAbroad(BaseModel):
    text: str
    date: str


class GraduateDegree(BaseModel):
    degree: str
    grad_date: str


class Education(BaseModel):
    institution: str
    grad_date: str
    degree: str
    threads: str = ""
    gpa: str = ""
    graduate_degree: GraduateDegree | None = None
    study_abroad: StudyAbroad | None = None


class SkillItem(BaseModel):
    """One entry on a skills line. `keywords` are the JD phrases that argue
    for surfacing it; they default to the (lowercased) name."""

    name: str
    keywords: list[str] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _coerce_str(cls, v):
        if isinstance(v, str):
            return {"name": v}
        return v

    def match_keywords(self) -> list[str]:
        return self.keywords or [self.name.lower()]


class Skills(BaseModel):
    coursework: list[SkillItem]
    languages: list[SkillItem]
    tools: list[SkillItem]
    certifications: list[str] = Field(default_factory=list)


class HeadingRun(BaseModel):
    text: str
    bold: bool = False
    italics: bool = False


class Project(BaseModel):
    tech: list[str]
    date: str
    tags: list[str] = Field(default_factory=list)   # JD concepts this maps to
    bullets: dict[str, list[str]]                   # variant name -> bullets
    # Quality prior multiplied into the JD-match score (select.score_project).
    # <1 keeps a weak entry from out-ranking flagships on tag overlap alone.
    priority: float = 1.0

    @model_validator(mode="after")
    def _has_base(self):
        if "base" not in self.bullets:
            raise ValueError("every project needs a 'base' bullet variant")
        if any(not v for v in self.bullets.values()):
            raise ValueError("bullet variants must be non-empty")
        return self

    def shortest_variant(self) -> str:
        return min(self.bullets, key=lambda k: sum(map(len, self.bullets[k])))


class WorkExperience(BaseModel):
    """A paid role. Renders as two dated lines (company|location, then
    role|date) above its bullets — distinct from a project's single line."""

    location: str = ""
    role: str
    date: str
    bullets: dict[str, list[str]]                   # variant name -> bullets

    @model_validator(mode="after")
    def _has_base(self):
        if "base" not in self.bullets:
            raise ValueError("every work entry needs a 'base' bullet variant")
        if any(not v for v in self.bullets.values()):
            raise ValueError("bullet variants must be non-empty")
        return self

    def shortest_variant(self) -> str:
        return min(self.bullets, key=lambda k: sum(map(len, self.bullets[k])))


class CommunityEntry(BaseModel):
    heading_runs: list[HeadingRun]
    date: str
    bullets: dict[str, list[str]]

    @model_validator(mode="after")
    def _has_base(self):
        if "base" not in self.bullets:
            raise ValueError("every community entry needs a 'base' variant")
        return self

    def shortest_variant(self) -> str:
        return min(self.bullets, key=lambda k: sum(map(len, self.bullets[k])))


class Bank(BaseModel):
    header: Header
    education: Education
    skills: Skills
    work_experience: dict[str, WorkExperience] = Field(default_factory=dict)
    projects: dict[str, Project]
    community: dict[str, CommunityEntry] = Field(default_factory=dict)


def load_bank(path: str | Path) -> Bank:
    return Bank.model_validate(json.loads(Path(path).read_text(encoding="utf-8")))
