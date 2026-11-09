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
    # The terms came from the JD body (main.infer_terms_from_jds), not the
    # source's own title/URL data. Such a term may only ACCEPT at the term
    # stage: one outside the wanted set is treated as unknown (LLM decides),
    # never as a term-not-wanted rejection. Transient, like `description`.
    terms_from_jd: bool = False
    # Set by main.infer_terms_from_jds (JD body or URL slug); transient. A
    # recheck keeps such a term on its record (src/recheck.py), since a
    # later run's fresh Job may not carry it.
    terms_inferred: bool = False
    # Set on the copy main._delivered hands out when a job was accepted
    # while its JD term was not wanted: the snapshot shows "Unknown term",
    # but `terms` keeps the JD guess so the content-dedup signature stays
    # specific (an "Unknown term" signature wildcards in content_dedup).
    term_display_unknown: bool = False
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
    board: str | None = None          # "<ats>:<slug>" for rows from a multi-board
                                      # source (ats-boards); first-sight seeding
                                      # keys on it (src/seeding.py)
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
    backfill: bool = False            # first sight: deliver the backlog
                                      # instead of seeding it (src/seeding.py)
    default_terms: dict[str, list[str]] = Field(default_factory=dict)

    def raw_url(self, path: str) -> str:
        return f"https://raw.githubusercontent.com/{self.repo}/{self.branch}/{path}"
