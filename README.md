# intern-watch

Automated internship discovery. A GitHub Actions cron polls public GitHub
internship lists every 2 hours, normalizes and dedupes the postings, applies
your filter rules (with a small LLM assist for ambiguous cases), and delivers
**only new matching jobs** — as a batched email digest ~3x/day and/or an
instant Discord webhook message. Multi-user by design: each user is one YAML
file plus a secret or two.

No servers, no database — state is a JSON file committed back to the repo.

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

## Setup

1. **Create the repo.** Push this directory to a (private is fine) GitHub repo.
2. **Gmail app password** (for the email channel): Google Account → Security →
   enable 2-Step Verification → then myaccount.google.com/apppasswords →
   create one named "intern-watch" → copy the 16-character password.
3. **Repo secrets** (Settings → Secrets and variables → Actions):
   - `GMAIL_ADDRESS` — the Gmail account that sends (and receives) the digest
   - `GMAIL_APP_PASSWORD` — the app password from step 2
   - the API key for your `llm.provider` (e.g. `GEMINI_API_KEY` or
     `ANTHROPIC_API_KEY`) — optional; without it the tool runs
     deterministic-only
   - (`DISCORD_WEBHOOK_<NAME>` — only if a user enables the Discord channel)
   - `JOBRIGHT_EMAIL` / `JOBRIGHT_PASSWORD` — optional; when set, accepted
     matches whose link is still a jobright.ai URL get resolved to the real
     employer apply URL at match time (session cookies persist across runs via
     an Actions cache); without them the watcher keeps the jobright link —
     everything else works. This logs into jobright.ai with your account —
     enable it only with your own account and your own judgment on their terms
     of service.
4. **Tune your config.** Edit `users/example.yaml` (terms, keywords, rules,
   the prose "top company" definition) and `data/top_companies.txt` /
   `data/atlanta_companies.txt` (one company per line, `|` separates aliases).
5. **First run.** Actions → *watch* → Run workflow. The first run **seeds**:
   it marks every currently-listed job as seen without notifying, so you don't
   get a 500-job blast. Every run after that notifies new jobs only.
   (Run `python -m src.main --backfill` locally instead if you *do* want the
   initial blast.)

### Fork checklist

Everything a fresh copy of this repo needs, in one place:

1. **Repo**: create your copy (GitHub *Use this template* on the template
   repo, or push this tree to a new repo — private is fine).
2. **Secrets** (Settings → Secrets and variables → Actions):
   `GMAIL_ADDRESS`, `GMAIL_APP_PASSWORD`, and your LLM key
   (`GEMINI_API_KEY` or `ANTHROPIC_API_KEY` — optional, deterministic-only
   without it). Add `JOBRIGHT_EMAIL`/`JOBRIGHT_PASSWORD` (optional — see
   Setup step 3) to resolve jobright links to real employer apply URLs.
3. **Repo settings**: Settings → Actions → General →
   *Workflow permissions: Read and write* and
   *Allow GitHub Actions to create and approve pull requests* (the monthly
   *refresh-boards* workflow opens a PR).
4. **Watcher config**: edit `users/example.yaml` (or copy it to
   `users/<you>.yaml` and delete the example) — terms, keywords, rules, the
   prose "top company" definition — plus `data/top_companies.txt` /
   `data/atlanta_companies.txt` (swap in your own metro list).
5. **Validate**: `python -m src.config_check`, then `pytest -q`.
6. **First run**: Actions → *watch* → Run workflow (seeds silently — see
   Setup above).
7. **Optional — resume builds**: create `users/<you>_resume.json`
   (schema: `docs/resume.md`; structure reference:
   `tests/fixtures/resume_bank.json`).
8. **Optional — auto-apply**: copy `users/apply.example.yaml` →
   `users/<you>_apply.yaml` and `users/logins.example.yaml` →
   `users/<you>_logins.yaml` (the latter is gitignored — it holds
   passwords); see `docs/apply.md`.
9. **Optional — mail sync** (Convex tracker only): recruiter emails update
   application statuses automatically, with an Inbox action queue in the
   webui for ambiguous ones; see `docs/mail-sync.md`.

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

### Run locally

```
pip install -r requirements.txt
python -m src.config_check     # validate users/*.yaml + secret wiring
python -m src.main --dry-run     # full pipeline, prints the digest, writes nothing
python -m pytest tests -q
```

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
