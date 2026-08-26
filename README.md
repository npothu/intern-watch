# intern-watch

Automated internship discovery. A GitHub Actions cron polls public GitHub
internship lists every 2 hours, normalizes and dedupes the postings, applies
your filter rules (with a small LLM assist for ambiguous cases), and delivers
**only new matching jobs** — as a batched email digest ~3x/day and/or an
instant Discord webhook message. Multi-user by design: each user is one YAML
file plus a secret or two.

No servers, no database — state is a JSON file committed back to the repo.

New here? `docs/quickstart.md` takes a fresh fork to a working watcher end to
end, with auto-apply and mail-sync as clearly-marked appendices. The README
below is the full reference; setup is tiered into REQUIRED (the minimum for a
working watcher) and OPTIONAL (everything else).

## Sources

| Source | What |
|---|---|
| [SimplifyJobs/Summer2026-Internships](https://github.com/SimplifyJobs/Summer2026-Internships) | `listings.json` — all terms (Summer/Fall/Spring/Winter), ~17k entries |
| [jobright-ai/2026-Software-Engineer-Internship](https://github.com/jobright-ai/2026-Software-Engineer-Internship) | README table, 7-day rolling window |
| [jobright-ai/2026-Engineer-Internship](https://github.com/jobright-ai/2026-Engineer-Internship) | README table |
| [jobright-ai/2026-Product-Management-Internship](https://github.com/jobright-ai/2026-Product-Management-Internship) | README table |
| [vanshb03/Summer2027-Internships](https://github.com/vanshb03/Summer2027-Internships) | README + OFFSEASON_README |
| [speedyapply/2026-SWE-College-Jobs](https://github.com/speedyapply/2026-SWE-College-Jobs) | README, FAANG+/Quant/Other tables |
| ATS boards (Greenhouse / Lever / Ashby) | official public JSON APIs for ~90 boards of companies in your lists — catches postings the moment they go up; regenerate with `python scripts/discover_ats_boards.py` |

Sources live in `sources.yaml` — adding one is config, not code (pick an
existing adapter, or add a new one under `src/adapters/`).

## Database backend (optional)

Human state — the applied/saved/dismissed ticks, the applications ledger, and
the current match snapshot — is stored in the GitHub issue plus committed
`state/` files by default. You can instead serve it from a **Convex**
deployment so the watcher and the local webui read and write one hosted store
with no GitHub-issue plumbing. This is optional; it is off unless you set
`STORE=convex`.

The client is thin: `src/store.py`'s `ConvexStore` POSTs to Convex's HTTP
public API (`/api/query` and `/api/mutation`), so no Python package or OAuth
is involved. The server side lives in `convex/` in this repo — four tables
(`ticks`, `applications`, `matches`, `resumes`, each indexed by
`(user, short)`) and ten functions (`tracker.ts`), deployed with
`convex deploy`. These files are
inert in CI; there is no Node/npm step in any workflow.

Who needs what:

- **The watcher cron** picks the driver from `STORE`; with `convex` it reads
  and writes state through the API instead of the issue + `dashboard-write`
  workflow, and paints a read-only digest issue body (no checkboxes, since
  ticks are no longer read from it).
- **The local webui** (`python -m src.webui`) already talks to the store via
  the same seam; with `STORE=convex` tick and status writes go to the
  deployment instead of the issue/workflow.
- **Backfill existing state** with `python scripts/migrate_tracker_to_convex.py
  --dry-run` (prints what it would write), then without the flag to copy your
  current ticks, ledger, and match snapshot in. Safe to re-run (idempotent
  upserts).

Built resumes follow the same seam: with `convex`, a tailored `.docx` is
stored in Convex file storage (a `resumes` table keyed by `(user, short)`),
so nothing gets committed and the workflow's `git add resumes/` step finds
nothing new. On the default `github` backend the file is written under
`resumes/` and the existing commit step picks it up exactly as before.
Legacy committed resumes remain served from the repo on either backend.

Both the cron and the workflow repaints (the `dashboard-write` / resume
steps) read the driver from the repo **Actions variable** `STORE` (Settings →
Secrets and variables → Actions → Variables), defaulting to `github` when
unset; `CONVEX_URL` and `CONVEX_SECRET` are set as repo **Actions secrets**,
fed to the workflow env like any other secret. So flipping the backend is a
repo-settings change, not a code change.

Setting it up:

1. `npx convex dev` (or `npx convex deploy`) in this repo to create the
   deployment and push `convex/`.
2. Set a `TRACKER_SECRET` env var on the deployment (required — every
   mutation checks it against `TRACKER_SECRET`).
3. Set `STORE=convex`, `CONVEX_URL`, and `CONVEX_SECRET` (the secret, equal
   to `TRACKER_SECRET`) on the matching `env:` block of the workflow that
   runs you, plus `.env` for the local webui. See `.env.example`.

With `convex`, the dashboard issue still gets painted each run (a read-only
digest) so you keep the GitHub-native view, but it is no longer the source of
truth — edits there are overwritten.

## Hosted web app (optional)

`web/` is a hosted, multi-user Next.js sibling of the local Python webui:
Clerk sign-in, Tailwind/shadcn UI, and the same Convex store. It is a separate
Vercel deployment, never part of the watcher cron, and strictly optional. Its
secrets (`CLERK_SECRET_KEY`, `CONVEX_URL`, `CONVEX_SECRET`, and a
`TRACKER_USER_MAP` bridging Clerk emails to tracker users) live on Vercel and
the Convex deployment, not in this repo's `.env`.
Its backend functions live under `convex/` and share the deployment with the Python pipeline.
See `web/README.md` for the web reference and `docs/local-web-development.md` for complete local setup instructions.

Every pull request gets its own Convex backend.
`scripts/vercel-build.sh` is the Vercel build command: a preview build creates a Convex preview deployment named after the branch (the branch's schema and functions), seeds it from a snapshot, and builds the web app against it; a production build is a plain `next build`.
The snapshot is the `convex-seed.zip` asset on the `convex-seed` release of the private data repo; refresh it with `scripts/publish-convex-seed.sh <owner/data-repo> [snapshot.zip]`.
The Preview environment on Vercel needs `CONVEX_DEPLOY_KEY` (a preview deploy key), `PREVIEW_CREDENTIALS_KEY`, `CONVEX_SEED_REPO` and `CONVEX_SEED_TOKEN` (Contents: read on the data repo); the header of `scripts/vercel-build.sh` lists them.

## Setup

Everything splits into two tiers. **REQUIRED** is the minimum for a working
watcher: a state store (the default GitHub driver needs no setup), an email
sender, and an LLM classifier key. Everything else is **OPTIONAL** - mail-sync,
auto-apply, jobright authenticated resolution, a Discord channel, and the
hosted web app; a fork that skips all of them still gets a fully working
watcher. The preflight (`python -m src.config_check`) prints both tiers as a
per-feature ENABLED/DISABLED table, so it is always obvious what is left to
set up and whether it is required.

If you are forking this, `docs/quickstart.md` walks the REQUIRED tier start to
finish and defers the optional features to appendices. The reference for both
tiers follows.

### Required (the minimum for a working watcher)

1. **Create the repo.** Push this directory to a (private is fine) GitHub repo.
2. **Gmail app password** (the email sender): Google Account → Security →
   enable 2-Step Verification → then myaccount.google.com/apppasswords →
   create one named "intern-watch" → copy the 16-character password.
3. **Repo secrets** (Settings → Secrets and variables → Actions):
   - `GMAIL_ADDRESS` - the Gmail account that sends (and receives) the digest
   - `GMAIL_APP_PASSWORD` - the app password from step 2
   - the API key for your `llm.provider` (`GEMINI_API_KEY` for the shipped
     config) - the watcher's term / company / Atlanta judgments need it. A
     fork that genuinely wants no LLM calls can disable `llm.enabled` and set
     `unknown_term_policy: drop`; the preflight then marks the LLM OFF without
     failing.
4. **Tune your config.** Edit `users/example.yaml` (terms, keywords, rules,
   the prose "top company" definition) and `data/top_companies.txt` /
   `data/atlanta_companies.txt` (one company per line, `|` separates aliases).
5. **Validate.** `python -m src.config_check` (per-user PASS/FAIL plus the
   feature table), then `pytest -q` must stay green.
6. **First run.** Actions → *watch* → Run workflow. The first run **seeds**:
   it marks every currently-listed job as seen without notifying, so you don't
   get a 500-job blast. Every run after that notifies new jobs only.
   (Run `python -m src.main --backfill` locally instead if you *do* want the
   initial blast.)

### Optional features

Same wiring as the required ones (a repo secret plus an `env:` line in
`watch.yml`), each adding one capability. All of them can wait until the
REQUIRED tier works.

- **Discord (instant channel)** - set `notify.discord_webhook_env` in a user
  yaml and add `DISCORD_WEBHOOK_<NAME>` to the repo secrets and `watch.yml`.
- **Jobright authenticated resolution** - `JOBRIGHT_EMAIL` /
  `JOBRIGHT_PASSWORD`: accepted matches whose link is still a jobright.ai URL
  get resolved to the real employer apply URL at match time (session cookies
  persist across runs via an Actions cache). Without them the watcher keeps
  the jobright link - everything else works. This logs into jobright.ai with
  your account - enable it only with your own account and your own judgment on
  their terms of service.
- **Resume auto-build** - enable `resume_build` in a user yaml; needs
  `users/<you>_resume.json` (schema: `docs/resume.md`).
- **Auto-apply** - the gated CLI that fills and submits applications; it never
  runs in the cron. Needs `users/<you>_apply.yaml` plus
  `BROWSERBASE_API_KEY` / `BROWSERBASE_PROJECT_ID` for the cloud browser.
  See `docs/apply.md`.
- **Mail-sync** - recruiter emails update application statuses automatically.
  Convex store only (`STORE=convex`), with `GMAIL_CLIENT_ID` /
  `GMAIL_CLIENT_SECRET` and the push-topic secrets. See `docs/mail-sync.md`.
- **Convex database backend** - the alternative state store described under
  "Database backend": `STORE=convex` plus `CONVEX_URL` / `CONVEX_SECRET`.
- **Hosted web app** - the separate Next.js app in `web/`; see "Hosted web
  app (optional)".

### Fork checklist

Everything a fresh copy of this repo needs, in one place. Split into the two
tiers: do the REQUIRED set first (the watcher alone), then add OPTIONAL
features one at a time. The step-by-step happy path is `docs/quickstart.md`.

**REQUIRED (the watcher):**

1. **Repo**: create your copy (GitHub *Use this template* on the template
   repo, or push this tree to a new repo - private is fine).
2. **Secrets** (Settings → Secrets and variables → Actions):
   `GMAIL_ADDRESS`, `GMAIL_APP_PASSWORD`, and your LLM key
   (`GEMINI_API_KEY` for the shipped config - see Setup).
3. **Repo settings**: Settings → Actions → General →
   *Workflow permissions: Read and write* and
   *Allow GitHub Actions to create and approve pull requests* (the monthly
   *refresh-boards* workflow opens a PR).
4. **Watcher config**: edit `users/example.yaml` (or copy it to
   `users/<you>.yaml` and delete the example) - terms, keywords, rules, the
   prose "top company" definition - plus `data/top_companies.txt` /
   `data/atlanta_companies.txt` (swap in your own metro list).
5. **Validate**: `python -m src.config_check`, then `pytest -q`.
6. **First run**: Actions → *watch* → Run workflow (seeds silently - see
   Setup above).

**OPTIONAL (after the watcher works):**

7. **Resume builds**: create `users/<you>_resume.json` (schema:
   `docs/resume.md`; structure reference: `tests/fixtures/resume_bank.json`).
8. **Auto-apply**: copy `users/apply.example.yaml` →
   `users/<you>_apply.yaml` and `users/logins.example.yaml` →
   `users/<you>_logins.yaml` (the latter is gitignored - it holds
   passwords); see `docs/apply.md`.
9. **Mail sync** (Convex tracker only): recruiter emails update application
   statuses automatically, with an Inbox action queue in the webui for
   ambiguous ones; see `docs/mail-sync.md`.
10. **Jobright auth**: `JOBRIGHT_EMAIL`/`JOBRIGHT_PASSWORD` - see Setup.
11. **Convex store / hosted web app**: see "Database backend" and "Hosted
    web app (optional)".

### Separate data repo (recommended for a real instance)

The fork checklist above keeps code and private data in one repo.
The alternative is two repos: this one (public, code only) and a small private DATA repo that holds `users/`, `state/`, the secrets and the dashboard issue.
Nothing needs syncing between them, and a code branch can be tested end to end against the instance before it merges.

1. Create a private repo with `users/` (your config), an empty `state/`, and a copy of `.gitattributes`.
2. Add the same secrets and variables there that the checklist puts on a single repo.
3. Add one thin caller per workflow you use. `watch.yml`:

   ```yaml
   on:
     schedule: [{cron: "0 */2 * * *"}]
     workflow_dispatch:
       inputs:
         send_now: {type: boolean, default: false}
         code_ref: {type: string, default: ""}
         data_ref: {type: string, default: ""}
         environment: {type: string, default: ""}
   permissions: {contents: write, issues: write}
   jobs:
     watch:
       uses: <you>/intern-watch/.github/workflows/watch.yml@main
       with:
         send_now: ${{ inputs.send_now || false }}
         code_ref: ${{ inputs.code_ref || '' }}
         data_ref: ${{ inputs.data_ref || '' }}
         environment: ${{ inputs.environment || '' }}
       secrets: inherit
   ```

   `dashboard-write`, `resume`, `resume-batch` and `resume-ondemand` follow the same shape (keep their own triggers and `if:` guards; the bodies live here).
   The reusable job checks out the data repo at the workspace root and this repo under `code/`, runs from `code/` with `INTERN_WATCH_DATA_DIR` set, and commits state back to the data repo.
4. To test a code branch before merging: `gh workflow run watch.yml -f code_ref=<branch> -f data_ref=staging -f environment=staging` in the data repo, where `staging` is a data branch with a test `users/` and a GitHub environment whose `STORE` variable is `github`.

Locally, run every tool from this checkout with `INTERN_WATCH_DATA_DIR=<path to the data repo>`.
That directory owns `users/`, `state/`, `resumes/`, `out/` and its own `.env`; this checkout keeps `sources.yaml`, `data/` and the web UI.
When the variable is unset or blank, both live here, which is the single-repo layout above.

### Config & secrets model

The golden rule: **config files name secrets, they never hold secret values.**
A user yaml says *which env var* a credential lives in; the value lives only in
GitHub Actions secrets. That's what makes the repo safe to publish/fork.

The chain for any credential is:

```
secrets.GMAIL_APP_PASSWORD          # real value — GitHub Actions secret
  → env: GMAIL_APP_PASSWORD         # exposed in .github/workflows/watch.yml
    → smtp_pass_env: GMAIL_APP_PASSWORD   # referenced (by name) in users/<name>.yaml
      → os.environ["GMAIL_APP_PASSWORD"]  # read by the code at run time
```

So there are three kinds of thing, in three places:

- **User info & preferences** → `users/<name>.yaml` (one file per person; any
  `*.yaml` with a `name:` key is picked up automatically — no code change to
  add a user). The only data here is `name`, your filter rules, and the
  *env-var names* of your secrets under `notify:` (`smtp_user_env`,
  `smtp_pass_env`, optional `discord_webhook_env`) and `llm.api_key_env`.
- **Secret values** → repo secrets (Settings → Secrets and variables →
  Actions). Never in any tracked file.
- **The wiring** → the `env:` block of `.github/workflows/watch.yml` maps each
  `secrets.X` to the env var name `X` your yaml referenced.

Adding a secret a user references (e.g. a Discord webhook) is therefore two
edits: create the repo secret, and add one `X: ${{ secrets.X }}` line to
`watch.yml`'s `env:` block. Locally, just export the same env var names before
running (`$env:GEMINI_API_KEY="…"` in PowerShell; `export …` in bash) — the
code only ever reads `os.environ`, so local and CI behave identically.

**Validate your config.** Run `python -m src.config_check` after editing any
`users/*.yaml`. It checks each user file against an explicit schema (known
top-level keys, valid `llm.provider` / `unknown_term_policy` / `resume_build.modes`,
`company_in_file` paths that exist, well-formed env-var names) and cross-checks
that every `*_env` secret you reference is actually wired into `watch.yml`'s
`env:` block — for any that aren't, it prints the exact `NAME: ${{ secrets.NAME }}`
line to add. It prints a per-user PASS/FAIL report and exits nonzero on any
failure, so CI runs it before pytest.

Alongside the per-user report it prints a per-feature status table: every
feature tiered REQUIRED (store, email, LLM) or OPTIONAL (discord, jobright,
auto-apply, mail-sync, the hosted web app) and marked ENABLED or DISABLED,
with exactly the env vars a disabled one needs. DISABLED optional features are
fine - the exit code only reflects config validity and secret *wiring*, never
the presence of secret values in the process (CI's preflight step has none;
they exist only inside the watch job). The "required features: N/3 ready"
summary line at the bottom is the self-hoster's checklist.

### Run locally

```
pip install -r requirements.txt
python -m src.config_check     # validate users/*.yaml + wiring; prints the feature table
python -m src.main --dry-run     # full pipeline, prints the digest, writes nothing
python -m pytest tests -q
```

The preflight reads the gitignored `.env` (like the other local tooling), so
putting `GMAIL_*` and `GEMINI_API_KEY` there flips the REQUIRED rows to
ENABLED; exported env vars win over the file.

## How filtering works (per user)

Cost-ordered pipeline: dedupe → drop already-seen → keyword role filter →
term filter → company/location rules → LLM for the still-ambiguous survivors.

- **Role filter**: title must hit an `include_keywords` entry and no
  `exclude_keywords` entry.
- **Eliminations** (`eliminate:` block): hard requirements that drop a job
  even when it's a SWE match — `countries_allowed` (location-country
  allowlist; unrecognized locations are conservatively kept), `unpaid`,
  `grad_only` (PhD/Master's-only via Simplify's degrees field + title
  patterns; "BS/MS" and "Undergraduate" stay), `active_clearance`
  (already-held TS/SCI/poly/"cleared"; clearance-obtainable roles stay), and
  `veteran_only` (SkillBridge/active-duty/veteran programs).
- **Term filter**: `terms_wanted` vs. the posting's term (taken from Simplify's
  `terms` field, else regex-inferred from the title: explicit "Fall 2026" /
  "Summer '27", month patterns like "Jan 2027", a bare "2027" → Summer 2027).
  Unknown terms follow `unknown_term_policy: llm | drop | keep`.
- **Rules**: per-term accept conditions — company in `data/top_companies.txt`,
  company in `data/atlanta_companies.txt`, location in the Atlanta-metro
  allowlist, location/work-model "remote", or `always: true`.
- **JD deepening (ATS jobs only)**: Lever/Ashby postings carry their full
  description inline; Greenhouse postings get one extra per-job fetch (new
  jobs only, capped per run). The eliminations above then also scan the JD
  body with context-aware patterns — "active TS/SCI" eliminates while
  "ability to obtain TS/SCI" stays, "Master's required" eliminates only when
  no undergraduate track is mentioned anywhere, and EEO boilerplate
  ("veteran status") never triggers. Jobs from the README-table sources have
  no JD and behave exactly as before.
- **LLM stage** (one batched call per run, capped by `llm.max_jobs_per_run`):
  only jobs the rules couldn't decide — unknown term, or Fall/Spring at a
  company that *might* be "top" / *might* be Atlanta. Provider-agnostic:
  set `llm.provider` (`gemini` or `anthropic`), `llm.model`, and
  `llm.api_key_env` per user; new providers are one function in `src/llm.py`.
  Verdicts are cached in `state/seen.json` (term & Atlanta shared across
  users; "top company" cached per user) so nothing is billed twice. Jobs the
  cost guard defers are retried next run, not lost.
- **Digest tags**: `[TOP]` list match, `[TOP*]` LLM judgment, `[ATL]`/`[ATL*]`
  Atlanta, `[REMOTE]`.

## Delivery channels

- **Email (batched)**: accepted matches accumulate in an outbox inside
  `state/seen.json`; the first run after each `send_at_utc` slot flushes them
  as one HTML digest (grouped by term, `[TOP]`/`[ATL]` tags, clickable links).
  Slots are honored even when Actions runs late, and nothing is sent when the
  outbox is empty. Send failures keep the outbox for retry.
- **Discord (instant)**: every run posts new matches immediately. A message is
  only marked delivered after the webhook returns 2xx; failures retry next run.

Each user enables either or both under `notify:` in their yaml.

## Match dashboard (GitHub issue)

Users with `dashboard: true` in their yaml get a "📋 intern-watch matches"
issue in this repo, rewritten every run: all matches from the last 120 days,
grouped by term, newest first, each as a checkbox row. **Tick a box once
you've applied** — the next run reads the ticks back into `state/seen.json`
before rewriting, so they persist. Close the issue to pause updates (reopen
to resume); any other edit to the body is overwritten. Needs the
`issues: write` permission (already set in `watch.yml`); local runs without
`GITHUB_TOKEN`/`GITHUB_REPOSITORY` skip the dashboard quietly.

## Source health alerts

Consecutive fetch/parse failures are counted per source in
`state/seen.json`. After 3 failed runs (~6h at the 2h cadence) a
"⚠ Source health" section is appended to every outgoing digest, and —
because empty digests are normally silent — if a send slot passes with
nothing in the outbox, a one-off standalone warning email goes out instead
(once per outage per user; the counter resets when the source recovers).

## Adding a user

1. Copy `users/example.yaml` → `users/<name>.yaml`, set `name:` and pick
   channels under `notify:` (email `smtp_*_env` names and/or
   `discord_webhook_env`).
2. Add the matching secrets, and reference them in the `env:` block of
   `.github/workflows/watch.yml`.

Fetching/parsing/dedup happen once per run; filtering and notification run
per user.

## Maintenance notes

- `state/seen.json` is pruned of entries not seen for 120 days.
- A source that fails to fetch/parse (or suddenly parses 0 rows) is skipped
  with a warning; the run continues and state is never wiped.
- Parser fixtures: `python scripts/refresh_fixtures.py`, then update `TODAY`
  in `tests/conftest.py` and re-run pytest.
- When `SimplifyJobs/Summer2027-Internships` launches, add it to
  `sources.yaml` with the `simplify_json` adapter.
- After editing the company lists, re-run `scripts/discover_ats_boards.py` to
  pick up new boards (review the diff — short aliases can match the wrong
  company), then `python -m src.main --seed` if you don't want a one-time
  backlog email from the newly added boards.
- The *refresh-boards* workflow re-runs that discovery on the 3rd of each
  month and opens a PR with the diff (it requires the repo setting
  *Settings → Actions → General → "Allow GitHub Actions to create and
  approve pull requests"*). Merging it may add boards mid-stream; run
  `--seed` after merging if you'd rather not get the backlog email.

## v2 backlog

Geocoded radius matching, closed-posting detection.
