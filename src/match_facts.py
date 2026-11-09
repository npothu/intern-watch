"""Display-only facts about an accepted match, for the web app's detail panel.

Nothing here decides anything. Every fact is read back from what the filter
pipeline already computed: the accept Verdict's reasons, the LLM facts the
final evaluation used, the cached per-employer "top company" verdict, and the
job's own fields. A fact the pipeline did not establish is left out rather
than guessed.

Storage (seen.json): the per-user facts live on the user's match item
(`state["matches"][user][i]["facts"]`), so they are pruned with the match
and never duplicated into the shared job entry. The job-level `sources` list
is not stored there: it already lives on `state["jobs"][key]["sources"]` and
is merged in at push time by `for_push`. Delivery is added later, at send
time, by `state.matches_set_delivery`.

Shape (the Convex `matches.item.facts` contract; every key is optional, and
`source` is always present on items recorded with facts. A legacy item -- no
stored facts -- carries `sources`, plus `source` only when it has exactly
one, since stored `sources` are sorted and say nothing about the producer):
  source        source id that produced the job (Job.source)
  sources       every source id it appeared in (push time, from state)
  postedAt      ISO date from the source's posting date (Job.date_posted)
  delivery      {"mode": "immediate"|"digest", "at": ISO-8601 UTC}
  termSource    "title" (source row or title, no LLM) | "llm" | "unresolved";
                omitted when the term was read from the JD body
                (Job.terms_from_jd) and not replaced by the LLM
  metro         {"name", "verdict", "source": "rules"|"llm"}
  topCompany    {"verdict", "judgedAt", "source": "list"|"llm"}
  clearanceObtainable  true when the JD mentions a clearance only as
                obtainable and the user eliminates active-clearance roles
  acceptedBy    "priority" | "rule" | "unresolved-all-terms"
  acceptedRule  the accepting condition's reason string(s)
"""

from __future__ import annotations

import datetime as dt

from . import state as st
from .filters import _METRO_MATCHES, TOP_COMPANIES, jd_clearance_obtainable
from .models import Job
from .recheck import RECHECK_REASON

METRO_NAME = "Atlanta, GA"   # the only metro the rule engine knows

# Rule-engine reasons that are a metro match (the preset radius check, or
# one of the preset's metro city patterns). Legacy hand-written rules may
# match any other location string; those are not a metro check.
_RULE_METRO_REASONS = {"location:atlanta-metro",
                       *(f"location:{p}" for p in _METRO_MATCHES)}


def _metro(reasons: list[str], llm_facts: dict | None) -> dict | None:
    for r in reasons:
        if r == "location:atlanta (LLM)":
            return {"name": METRO_NAME, "verdict": True, "source": "llm"}
    for r in reasons:
        if r in _RULE_METRO_REASONS:
            return {"name": METRO_NAME, "verdict": True, "source": "rules"}
    # Accepted by something else, but the LLM was asked about the metro.
    if llm_facts and isinstance(llm_facts.get("in_atlanta_metro"), bool):
        return {"name": METRO_NAME, "verdict": llm_facts["in_atlanta_metro"],
                "source": "llm"}
    return None


def _top_company(reasons: list[str], llm_facts: dict | None, state: dict,
                 job: Job, user: str, today: dt.date) -> dict | None:
    top_stem = TOP_COMPANIES.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    if "company:priority" in reasons or f"company:{top_stem}" in reasons:
        # On the user's priority list or the top-company alias list: matched
        # by name on the day it was accepted.
        return {"verdict": True, "judgedAt": today.isoformat(),
                "source": "list"}
    llm_used = (f"company:{top_stem} (LLM)" in reasons
                or (llm_facts is not None and "is_top_company" in llm_facts))
    if not llm_used:
        return None
    verdict = st.company_top_get(state, job.company, user)
    # Only this user's own judgement date; a legacy entry without one omits
    # the fact rather than report another user's date.
    judged = st.company_judged_get(state, job.company, user)
    if verdict is None or judged is None:
        return None
    return {"verdict": verdict, "judgedAt": judged, "source": "llm"}


def _accepted_by(reasons: list[str]) -> tuple[str, str | None]:
    # "recheck" marks how the job reached the rule engine, not a condition.
    rule = ", ".join(r for r in reasons
                     if r not in ("term-unknown", RECHECK_REASON)) or None
    if "company:priority" in reasons:
        return "priority", "company:priority"
    if "term-unknown" in reasons:
        return "unresolved-all-terms", rule
    return "rule", rule


def build(job: Job, reasons: list[str], *, user: str, state: dict,
          today: dt.date, llm_facts: dict | None = None,
          llm_termed: bool = False,
          elim_active_clearance: bool = False) -> dict:
    """Facts for one accepted (job, user). `reasons` is the accepting
    Verdict's reasons; `llm_facts` the merged facts the final evaluation ran
    with (None when the first, deterministic pass accepted); `llm_termed`
    whether this run's LLM step wrote the job's term."""
    facts: dict = {"source": job.source}
    if job.date_posted is not None:
        facts["postedAt"] = job.date_posted.isoformat()
    if "term-unknown" in reasons:
        facts["termSource"] = "unresolved"
    elif job.terms and llm_termed:
        facts["termSource"] = "llm"
    elif job.terms and not job.terms_from_jd:
        facts["termSource"] = "title"
    metro = _metro(reasons, llm_facts)
    if metro is not None:
        facts["metro"] = metro
    top = _top_company(reasons, llm_facts, state, job, user, today)
    if top is not None:
        facts["topCompany"] = top
    if elim_active_clearance and job.description \
            and jd_clearance_obtainable(job.description):
        facts["clearanceObtainable"] = True
    by, rule = _accepted_by(reasons)
    facts["acceptedBy"] = by
    if rule:
        facts["acceptedRule"] = rule
    return facts


def for_push(state: dict, items: list[dict]) -> list[dict]:
    """Copies of the match items with `facts.sources` filled from the shared
    job entry. Items recorded before facts existed get `facts.source` only
    when the job has exactly one source: `sources` is stored sorted, so with
    several the producer is unknown. Never mutates state: `sources` stays
    derived, not stored."""
    out: list[dict] = []
    for item in items:
        entry = state["jobs"].get(item.get("key", ""), {})
        sources = list(entry.get("sources") or [])
        stored = item.get("facts")
        if not stored and not sources:
            out.append(item)
            continue
        facts = dict(stored or {})
        if "source" not in facts and len(sources) == 1:
            facts["source"] = sources[0]
        if sources:
            facts["sources"] = sources
        out.append({**item, "facts": facts})
    return out
