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
3. **Term**: the wanted terms -- rolling from today's date via the `terms:`
   block (`src/terms.py`; lead_weeks / horizon_months / include / exclude),
   or the legacy static `terms_wanted` list. Unknown term → LLM infers it.
   If even the LLM returns null, the job is accepted only if it passes the
   rules under EVERY wanted term (most restrictive assumption); otherwise
   rejected `term-unresolved`.
4. **Rules**: a per-season preset in `term_rules:` (`top_atl_remote` /
   `priority_only` / `anything`, expanded by `filters.rules_from_presets`)
   or the legacy per-term `rules:` list: company list match, metro-area
   match, remote, or accept-always. A **priority company**
   (`priority.companies`, widened by the alias groups in
   `data/top_companies.txt`, plus ledger employers when `from_tracker`) is
   accepted for any wanted term before the rules run, tagged `[PRIORITY]`,
   sorted first everywhere, and with `email_immediately` emailed on the run
   that found it (`main._send_priority_alert`; a failed send leaves it in
   the outbox for the digest).
   The hosted app's Settings > Watch page stores these knobs in the Convex
   `settings` row; `src/prefs.py` overlays that object on the yaml at the
   start of `process_user` (store wins) and pushes the resolved config back
   (`put_watch_report`). With STORE=github the yaml is the whole config.
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
is `state/seen.json` on **origin/main of the data repo** (Actions commits it
every run; the local checkout is usually stale — `git fetch origin main &&
git show origin/main:state/seen.json` there). For an instance that is the
private data repo, not this one. Per job entry:
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
notifying or writing state; against an instance's real config and state,
prefix it with `INTERN_WATCH_DATA_DIR=<path to the data repo checkout>`
(same for `src.webui`, `src.dashboard`, `src.resume`, `src.apply`).
`ruff check .`, `python -m mypy`, `pytest -q` and `python -m src.config_check`
must all stay green (see Code review).

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
- Prefer branch + PR over pushing straight to main.
- **Code vs data.** `src/paths.py` splits the tree in two: `ROOT` (this
  checkout: `src/`, `sources.yaml`, `data/`) and `DATA_ROOT` (`users/`,
  `state/`, `resumes/`, `out/`, and the git repo whose `origin/main` the
  webui and GitHubStore read). `DATA_ROOT` is `INTERN_WATCH_DATA_DIR` when
  set, else `ROOT`. The template runs with both equal; an instance keeps its
  private data in a separate repo and points the env var at it. Every new
  path must go through one of the two - never recompute
  `Path(__file__).parents[n]`.
- **Reusable workflows.** `watch`, `dashboard-write`, `resume`,
  `resume-batch` and `resume-ondemand` all carry a `workflow_call` trigger
  next to their own. A data repo calls them with `secrets: inherit`; the job
  checks out the caller (data) at the workspace root and this repo under
  `code/`, runs from `code/` with `INTERN_WATCH_DATA_DIR` set, and commits
  state back to the caller. Inputs `code_ref` / `data_ref` / `environment`
  pick the code ref, the data branch and the GitHub environment (e.g. a
  `staging` environment that overrides `STORE`). Anything that changes a
  workflow's env var list or checkout layout must be made in the reusable
  body, not the thin caller.

## Code review

Two layers. The automated gates catch mechanical defects so review attention
goes to judgment; the review loop runs before the PR is opened.

### Layer 1 - automated gates (`test.yml`)

`ruff check .` then `python -m mypy` then `src.config_check` then `pytest -q`,
cheapest first.
Install the tooling with `pip install -r requirements-dev.txt` (kept out of
`requirements.txt` so the six cron workflows don't install tools they never
run); both tools are configured in `pyproject.toml`.

mypy covers `src/` only.
`tests/` and `scripts/` are not yet clean and are deliberately out of scope -
if you bring one to zero errors, add it to `files` in `pyproject.toml` rather
than leaving it uncovered.

Ruff's `E501` is exempted per-file for `src/apply/fillers/agent.py` and
`tests/test_apply_auth.py`, which embed JS and HTML in triple-quoted literals
where a `# noqa` would become part of the embedded source.
Prefer fixing a long line over widening that list.

### Layer 2 - review before the PR

Run `/code-review` on the branch diff before opening a PR: it has the session
context for *why* the change was made, which a fresh reviewer lacks.
For changes touching `src/filters.py`, `src/state.py`, `src/ledger.py`, or
anything that writes `state/`, follow with `/codex-review` for an independent
model - two models disagreeing is the signal worth reading.

### What review must check in this repo

The failure modes here are silent, so check these explicitly. Generic review
will not find them:

- **Rejected jobs are final.** A job is evaluated only when first seen (or
  while pending), so a filter fix does NOT retroactively deliver previously
  rejected jobs. Any change claiming to "fix" a filter must say what happens
  to the jobs already rejected by the old one - usually nothing.
- **Top-company verdicts stick.** `state["companies"][<norm>]["top"]` is
  per-employer, per-user, first-verdict-wins for ~120 days. Editing the prose
  definition in a user yaml does not re-judge cached employers; the entry has
  to be deleted.
- **Filter order is load-bearing.** Role filter → eliminations → term → rules
  → LLM. Moving a check earlier or later changes which jobs reach the
  cost-capped LLM step, not just whether they pass.
- **Substring matching, not word matching.** "data science" does not match
  "Data Scientist"; `strict_sources` additionally require a
  `strict_include_keywords` hit. New keywords need both forms considered.
- **`state/applications.json` is never pruned.** Reject anything that prunes,
  compacts, or "cleans up" the ledger. seen.json is the prunable cache.
- **`state/*.json` belongs to Actions.** Local edits to those files in a diff
  are a mistake; branches come from origin/main.
- **The webui is local-only.** It must never be reachable from the watcher
  cron.

## Shipping a change (code repo → deployed)

This repo is the CODE. All the code, for the template and for every instance.
An instance is a separate private DATA repo (users/, state/, secrets, the
dashboard issue) whose workflows call the reusable ones here; nothing in this
repo names an instance (no deployment names, team names, personal config or
real URLs). Shipping is:

1. **Branch + PR here.** Worktree, tests green, no Claude/Co-Authored-By
   trailers. CI: `test`, `convex-test`, `web` (`web` only when `web/**`
   changed).
2. **Test it end to end from the data repo before merging.** Dispatch the
   instance's `watch` with `code_ref=<this branch>`, `data_ref=staging`,
   `environment=staging`. The staging environment sets `STORE=github`, the
   staging data branch has its own users/ and state/ and emails only the
   owner, so the run is real (fetch, filter, LLM, email, state commit) and
   touches nothing in production. Web changes: every PR gets a Vercel
   preview with its OWN Convex preview deployment (the branch's schema and
   functions, seeded from the data repo's `convex-seed` release), built by
   `scripts/vercel-build.sh`; a schema change is therefore exercised on real-
   shaped data before merge. Refresh the seed with
   `scripts/publish-convex-seed.sh`.
3. **Merge.** Watcher instances pick up `main` on their next cron tick (their
   callers are pinned to `@main`). `deploy-convex.yml` pushes `convex/` to
   production on the same merge when `CONVEX_DEPLOY_KEY` is set. Vercel
   builds production from `main`.
4. **Verify the deployed path**, not the deploy log: one real call against
   the changed Convex function (`npx convex run <fn> '<json>' --prod`, clean
   up any test row) and a look at the production web app. Convex validates a
   schema change against live data at deploy time, so exercise it on dev
   before merging.

A manual production web deploy, if ever needed, is `npx vercel --prod` from
the repo root (Root Directory is `web`; inside `web/` it resolves `web/web`).

### The web build only ever installs `web/package.json`

Vercel builds with Root Directory `web`, so the root `node_modules` does not
exist there. Anything under `web/` that `next build` type-checks must resolve
against `web/package.json` alone. Colocated `*.test.ts` files import `vitest`
(a ROOT devDependency) and are therefore excluded in `web/tsconfig.json`; the
root vitest suite still runs them. Do not "fix" a missing-module error in the
web build by installing the root deps in CI — that makes CI pass and leaves
Vercel broken, which is precisely the trap: **web CI must mirror Vercel's
install, not your laptop's.** And never add `vitest` to `web/package.json` — a
second copy shadows the root one and breaks the root runner.

### Deployment env vars are per-deployment and do NOT travel

`npx convex env list` / `--prod` shows what each one has. A new
`process.env.X` in `convex/` is a deploy blocker until it is set on BOTH:
`npx convex env set X <value>` and `npx convex env set --prod X <value>`.
Check this BEFORE deploying — a missing var surfaces as a runtime throw in
whatever feature reads it, not as a failed deploy.

`CREDENTIALS_KEY` is the AES root for `credentials` (see `credentials.ts`).
Generate a DIFFERENT random key per deployment so a dev leak cannot decrypt
prod, e.g.
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
It is an encryption root, not a rotatable setting: change or lose it and every
credential stored under it becomes permanently undecryptable — record both
values somewhere durable before setting them.
