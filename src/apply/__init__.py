"""Auto-apply subsystem (separate from the read-only watcher pipeline).

Given an accepted match (company, title, apply URL) and a tailored resume,
this module drives a browser to fill — and, when gated, submit — the job
application. It is deliberately walled off from `src/main.py`: a bug here can
never corrupt discovery state.

Flow:  resolve URL -> classify ATS family -> pick a Filler -> fill (attach the
tailored .docx) -> pause for review (autofill mode) OR submit (gated submit
mode). The browser runs on a cloud platform (Browserbase) by default or a
local Playwright Chromium for the CLI; sessions persist per ATS so a one-time
interactive login is reused. Unknown/long-tail forms fall back to an LLM
browser agent.

Nothing in here runs in the 2h watcher cron — applying is on-demand (CLI) or a
separate gated runner.
"""

from __future__ import annotations
