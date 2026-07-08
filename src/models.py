"""Normalized Job model and source-registry config models."""

from __future__ import annotations

import datetime as dt
from typing import Literal

from pydantic import BaseModel, Field

TermConfidence = Literal["explicit", "inferred", "unknown"]


class Job(BaseModel):
    """One internship posting, normalized across sources."""

    dedup_key: str = ""              # computed in dedupe.py
    company: str
    title: str
    locations: list[str] = Field(default_factory=list)
    terms: list[str] = Field(default_factory=list)   # e.g. ["Fall 2026"]; [] = unknown
    term_confidence: TermConfidence = "unknown"
    url: str                          # apply/info link, tracking params stripped
    jobright_id: str | None = None    # 24-hex id when extractable
    work_model: str | None = None     # "On Site" | "Hybrid" | "Remote" | None
    salary: str | None = None
    date_posted: dt.date | None = None
    degrees: list[str] = Field(default_factory=list)  # Simplify only, e.g. ["Bachelor's"]
    description: str | None = None    # plain-text JD snippet (ATS sources only);
                                      # transient -- never persisted to state
    jd_url: str | None = None         # per-job content API (Greenhouse), fetched
                                      # lazily in main.enrich_jds for new jobs only
    source: str                       # e.g. "jobright-swe"
    sources: list[str] = Field(default_factory=list)  # union after dedup merge
    raw_title: str = ""               # untouched, for LLM context

    def model_post_init(self, __context) -> None:
        if not self.sources:
            self.sources = [self.source]
        if not self.raw_title:
            self.raw_title = self.title


class SourceConfig(BaseModel):
    name: str
    adapter: str
    repo: str = ""                    # github-raw sources only
    branch: str = ""
    files: list[str] = Field(default_factory=list)
    boards_file: str | None = None    # ats_boards adapter only
    default_terms: dict[str, list[str]] = Field(default_factory=dict)

    def raw_url(self, path: str) -> str:
        return f"https://raw.githubusercontent.com/{self.repo}/{self.branch}/{path}"
