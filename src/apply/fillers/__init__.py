"""Filler registry: maps an ATSFamily to the object that drives its form.

Deterministic fillers handle the two families we target directly (Greenhouse,
Workday). Everything else — Lever, Ashby, and `unknown` (the long tail behind
aggregator redirects) — falls back to the LLM browser agent, used sparingly.

Imports are lazy so a half-built tree (or a missing optional filler) degrades
to "unsupported" at runtime instead of breaking import of the whole package.
"""

from __future__ import annotations

import importlib
import logging

from ..base import ATSFamily, Filler

log = logging.getLogger(__name__)

# family -> (module under src.apply.fillers, class name)
_DETERMINISTIC = {
    ATSFamily.greenhouse: ("greenhouse", "GreenhouseFiller"),
    ATSFamily.workday: ("workday", "WorkdayFiller"),
}
# Families with no deterministic filler route to the LLM agent.
_AGENT = ("agent", "AgentFiller")


def get_filler(family: ATSFamily) -> Filler | None:
    """Return a Filler for `family`, or None if its module isn't available."""
    mod_name, cls_name = _DETERMINISTIC.get(family, _AGENT)
    try:
        mod = importlib.import_module(f".{mod_name}", __package__)
    except ImportError as exc:                  # filler not built yet / dep missing
        log.warning("filler '%s' unavailable: %s", mod_name, exc)
        return None
    cls = getattr(mod, cls_name, None)
    if cls is None:
        log.warning("filler module '%s' has no %s", mod_name, cls_name)
        return None
    return cls()
