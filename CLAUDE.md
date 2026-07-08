# intern-watch

Internship alert pipeline, one user per `users/*.yaml` config. A GitHub
Actions cron (`watch.yml`, every 2h) polls public internship lists, dedupes,
filters per user, asks a cheap LLM about ambiguous cases, and delivers
matches by batched email plus a "📋 intern-watch matches" GitHub issue
dashboard. This repo is a template: fork/copy it, set a few secrets, edit
one YAML (see the README's fork checklist).

## How a job gets decided (order matters)

`src/main.py` orchestrates; per job and user, `src/filters.py` runs:

1. **Role filter** (title, case-folded SUBSTRING matching): any
   `exclude_keywords` hit rejects; then at least one `include_keywords` hit is
   required. Jobs from `strict_sources` (jobright-eng, jobright-data — repos
   that mix in hardware/business roles) additionally need a
   `strict_include_keywords` hit (bare "engineer" doesn't count there).
   Substring gotcha: "data science" does NOT match "Data Scientist" — that's
   why both keywords exist.
2. **Eliminations**: country allowlist (unknown locations kept), unpaid,
   grad-only (MS/PhD-only), active-clearance-required (obtainable kept),
   veteran-only. Titles and (for ATS jobs) JD bodies, separate patterns.
3. **Term**: `terms_wanted` in the user yaml. Unknown term → LLM infers it.
   If even the LLM returns null, the job is accepted only if it passes the
   rules under EVERY wanted term (most restrictive assumption); otherwise
   rejected `term-unresolved`.
4. **Rules** (per-term accept conditions in the user yaml): company list
   match, metro-area match, remote, or accept-always.
5. **LLM facts** for ambiguous cases (term, metro, top-company), batched,
   cost-capped per run, verdicts cached in state. "Top company" is judged
   **per employer** (normalized company name), per user, cached in
   `state["companies"]` — first verdict wins and sticks (~120 days), so word
   the prose definition in the user yaml carefully.

Accepted matches go to the email outbox + dashboard; **rejected jobs are
final** — they are only evaluated when first seen (or while "pending"), so a
filter fix does NOT retroactively deliver previously rejected jobs.

## Sources (`sources.yaml`)

jobright-ai GitHub README mirrors (SWE / Engineer / PM / **Data-Analysis** —
Data Scientist roles appear ONLY in Data-Analysis), SimplifyJobs, vanshb03,
speedyapply, and `ats-boards` (direct Greenhouse/Lever/Ashby JSON APIs for
~90 boards in `data/ats_boards.yaml`, refreshed monthly by
`refresh-boards.yml`). Known coverage limits:
- jobright's GitHub mirrors are a SUBSET of jobright.ai; some postings never
  appear in any repo. The full feed is auth-only and jobright's ToS
  disallows crawling — this template only consumes the public GitHub mirrors
  and public per-job JSON.
- jobright README rows can be added and removed within ~5 hours (hence the
  2h cron), and repos retain only ~7 days.
- Employers with proprietary ATSes have no ats-boards backstop.

## Debugging "why did job X (not) show up"

The jobright URL hex id is the dedup key: `jr:<24-hex>`. Authoritative state
is `state/seen.json` on **origin/main** (Actions commits it every run; the
local checkout is usually stale — `git fetch origin main && git show
origin/main:state/seen.json`). Per job entry:
- `notified_for: ["<user>"]` → delivered. Empty + `llm_top`/companies verdict
  false → LLM rejected the company. No `llm` key at all → rejected before the
  LLM (role filter / elimination / term-not-wanted — simulate the title
  against the user yaml to find which).
- Key absent entirely → never ingested: grep the id in the subscribed repos'
  raw READMEs, and in earlier commits the same day
  (`gh api repos/jobright-ai/<repo>/commits`, then fetch the README at each
  sha) to check whether it appeared and vanished between runs.
- `state["companies"][<norm name>]["top"]` holds the per-employer verdict; an
  unwanted sticky verdict can be fixed by editing the definition in the user
  yaml and deleting that entry.

`python -m src.main --dry-run` runs the full pipeline locally without
notifying or writing state. `pytest -q` and `python -m src.config_check`
must stay green.

## Local web UI (`python -m src.webui`)

Localhost application manager: matches read from origin/main's seen.json
with the dashboard issue's checkboxes overlaid. Applied toggles and hide
(dismiss) toggles WRITE THROUGH the issue (the cron persists them — needs
GITHUB_TOKEN or `gh auth token`); "build resume" runs the local src.resume
pipeline into out/. Hidden rows live in a collapsed section on the issue.
Rows outside the issue's byte-budgeted window, and all tracker-status
updates, go through the `dashboard-write` workflow instead (dispatched by
the webui; Actions commits state). Local-only, never in the watcher cron.

## Applications ledger (`state/applications.json`)

seen.json is a prunable cache (120 days); the ledger is the permanent
record. One entry per application (keyed by user + 12-hex short key),
created when a match is marked applied, carrying a display snapshot plus
`status`/`history` (statuses in src/ledger.py; "ghosted" is auto-detected,
never stored). Synced from applied ticks on every watcher/dashboard-write
run; a record whose tick is undone is dropped only while it never
progressed past "applied". NEVER pruned — do not "clean it up".

## Repo conventions

- `.gitattributes` forces LF (seen.json churns otherwise).
- `state/seen.json` and `state/applications.json` are written by Actions —
  avoid committing local edits to them; branch from origin/main.
- Prefer branch + PR over pushing straight to main: Actions commits state to
  main between your pull and your push, so direct pushes race it.
