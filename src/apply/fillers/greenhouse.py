"""Greenhouse application filler.

Greenhouse forms need no login, but beyond the basic contact fields they carry
many custom dropdowns/questions (Country, Degree, Discipline, GPA, graduation
dates, security clearance, internship duration, ...). Rather than hard-code a
fixed field list (which silently skips all the custom ones), Greenhouse runs the
general agent engine — scrape every field -> answer book + LLM -> fill with
scroll/verify/label-fallback, handling text, selects, radios and checkboxes —
and relabels the result to the greenhouse family. The agent already attaches the
resume and gates captchas to submit mode only.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from ..base import ApplyContext, ApplyResult, ATSFamily
from .agent import AgentFiller

if TYPE_CHECKING:
    from playwright.sync_api import Page


class GreenhouseFiller:
    family: ATSFamily = ATSFamily.greenhouse

    def apply(self, page: "Page", ctx: ApplyContext) -> ApplyResult:
        res = AgentFiller().apply(page, ctx)
        res.family = self.family            # relabel from the agent's "unknown"
        return res
