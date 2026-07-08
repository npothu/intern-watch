"""Optional LLM pass: rewrite selected bullets to surface JD keywords.

This is the only non-deterministic step in the pipeline and the build works
without it (bank variants are the fallback at every failure point: missing
API key, API error, malformed response, over-length rewrite). Reuses the
provider plumbing from src.llm.

Guardrails, enforced in code rather than trusted to the prompt:
  * a rewrite may not exceed its per-bullet char cap (page fit would break)
  * bullet counts per project must match; extras/missing -> keep originals
  * unknown project names in the response are ignored
"""

from __future__ import annotations

import json
import logging
import os
import re

from ..llm import _PROVIDERS, DEFAULT_MODEL, api_key_env_for, provider_of
from .select import PlannedEntry, ResumePlan

log = logging.getLogger(__name__)

JD_EXCERPT_CHARS = 6000
CAP_SLACK = 15          # rewrites may run this many chars past the original
CAP_FLOOR = 140         # ...but short bullets still get room to grow

_SYSTEM = (
    "You are a resume bullet editor. You rewrite existing bullet points to "
    "surface keywords from a specific job description. You NEVER invent "
    "experience: no new tools, frameworks, metrics, or accomplishments that "
    "are not in the original bullet or the project's listed tech stack. "
    "Respond with ONLY a JSON array -- no prose, no markdown, no code fences."
)

_INSTRUCTIONS = """\
Rewrite the resume bullets below so they emphasize this job description's \
vocabulary and priorities. Rules:

- Keep every fact, metric, and tool from the original bullet. You may \
reorder, rephrase, and swap synonyms toward the JD's wording (e.g. say \
"REST API" if the JD does, where the original already describes one).
- Never add a skill, tool, or claim that is not already in the original \
bullet or that project's tech list.
- Each rewrite must be at most its "max_chars" (hard limit, resume must \
stay one page). If the original is already on target, return it unchanged.
- Strong action verbs, no first person, no trailing periods... match the \
original style.

Output: a JSON array, one object per project, exactly:
  {{"name": "<copy project name exactly>", "bullets": ["<rewrite 1>", ...]}}
with the same number of bullets per project, in the same order.

Job description:
---
{jd}
---

Projects and bullets:
{payload}
"""


def _parse_array(text: str) -> list:
    text = re.sub(r"```(?:json)?", "", text)
    start, end = text.find("["), text.rfind("]")
    if start == -1 or end <= start:
        raise ValueError("no JSON array in model response")
    return json.loads(text[start:end + 1])


def _cap(bullet: str) -> int:
    return max(len(bullet) + CAP_SLACK, CAP_FLOOR)


def _apply(entry: PlannedEntry, rewrites: list, notes: list[str]) -> None:
    if (not isinstance(rewrites, list)
            or len(rewrites) != len(entry.bullets)
            or not all(isinstance(b, str) and b.strip() for b in rewrites)):
        notes.append(f"llm: bad rewrite shape for '{entry.name}', kept bank text")
        return
    new = []
    changed = False
    for orig, rw in zip(entry.bullets, rewrites):
        rw = rw.strip()
        if len(rw) > _cap(orig):
            notes.append(f"llm: over-length rewrite in '{entry.name}', "
                         f"kept original bullet")
            new.append(orig)
        else:
            changed = changed or rw != orig
            new.append(rw)
    entry.bullets = new
    entry.llm_rewritten = changed


def tailor(plan: ResumePlan, jd_text: str, llm_cfg: dict) -> ResumePlan:
    """Mutate plan.projects' bullets via the configured LLM. Never raises:
    any failure leaves the deterministic plan intact and logs a note."""
    provider = provider_of(llm_cfg)
    call = _PROVIDERS.get(provider)
    if call is None:
        plan.notes.append(f"llm: unknown provider '{provider}', skipped")
        return plan
    key_env = api_key_env_for(llm_cfg)
    api_key = os.environ.get(key_env)
    if not api_key:
        plan.notes.append(f"llm: {key_env} not set, deterministic bullets used")
        return plan
    model = llm_cfg.get("model") or DEFAULT_MODEL[provider]

    payload = [{
        "name": p.name,
        "tech": next((r.text for r in p.heading_runs if r.italics), ""),
        "bullets": [{"text": b, "max_chars": _cap(b)} for b in p.bullets],
    } for p in plan.projects]
    user_msg = _INSTRUCTIONS.format(
        jd=jd_text[:JD_EXCERPT_CHARS],
        payload=json.dumps(payload, ensure_ascii=False, indent=1))

    try:
        text = call(model, _SYSTEM, user_msg, api_key)
        items = _parse_array(text)
    except Exception as exc:        # noqa: BLE001 — any failure -> fallback
        log.warning("resume tailor failed: %s", exc)
        plan.notes.append(f"llm: call failed ({type(exc).__name__}), "
                          f"deterministic bullets used")
        return plan

    by_name = {p.name: p for p in plan.projects}
    seen = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        entry = by_name.get(item.get("name"))
        if entry is None or entry.name in seen:
            continue
        seen.add(entry.name)
        _apply(entry, item.get("bullets"), plan.notes)
    missing = by_name.keys() - seen
    if missing:
        plan.notes.append(
            "llm: no rewrite returned for: " + ", ".join(sorted(missing)))
    return plan
