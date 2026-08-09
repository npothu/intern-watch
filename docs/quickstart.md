# Quickstart: your own intern-watch watcher

This gets a fresh fork to a **working watcher**: a GitHub Actions cron that
polls internship lists every 2 hours, filters them to your rules, and emails
you a digest of new matches a few times a day. Nothing else is required for
that - no Convex, no Browserbase, no Gmail push, no Next.js.

Plan: about 20 minutes, one off, then the cron runs the watcher forever.

Auto-apply and mail-sync are appendices at the bottom, clearly marked. The
README's "Setup" section is the full reference for both tiers; this page is
the REQUIRED tier only, start to finish.

## What you need

- A GitHub account (a fresh repository is created in step 1, private is fine).
- A Gmail account to send (and receive) the digest from, with 2-Step
  Verification on.
- A Gemini API key (free tier is fine) from https://aistudio.google.com/apikey
  for the shipped config's LLM judgments.

## 1. Create the repo

Open this repository on GitHub and click *Use this template* -> *Create a new
repository*, or push this directory up to a new repo directly.
Private is fine - the watcher only needs Actions and your own login.
Clone it locally so you can tune the config and run the preflight.

## 2. One Gmail app password

Google Account -> Security -> enable 2-Step Verification, then
https://myaccount.google.com/apppasswords -> create one named "intern-watch"
-> copy the 16-character password. This is the only password the watcher
stores, and it goes in as a GitHub secret, never in the repo.

## 3. Repo settings (one-time)

In your new repo: Settings -> Actions -> General, then enable:

- *Workflow permissions: Read and write*
- *Allow GitHub Actions to create and approve pull requests*

The second one is for the monthly *refresh-boards* workflow that opens a PR;
without the first, the watcher can't commit its state back.

## 4. Secrets

Settings -> Secrets and variables -> Actions -> New repository secret, three
times. Use exactly these names - the shipped `watch.yml` already wires them;
`config_check` verifies the wiring.

- `GMAIL_ADDRESS` - your Gmail address
- `GMAIL_APP_PASSWORD` - the app password from step 2
- `GEMINI_API_KEY` - your Gemini API key

That is the whole required secret set: a store (the default GitHub driver
needs nothing), an email sender, and the LLM key.

## 5. Your config

Edit `users/example.yaml`, or copy it to `users/<you>.yaml` and delete the
example. Things you actually want to change for yourself:

- `notify.email.to:` if the digest should go somewhere other than the sender
- `role_filter.include_keywords` / `exclude_keywords` for the kinds of roles
  you want
- `terms_wanted` for the terms you are applying to
- `rules` (company lists, Atlanta radius, remote)
- the prose `llm.top_company_definition` - this is the definition the LLM
  judges "top company" by

The shipped `users/example.yaml` is the reference for a complete config; most
keys have inline comments.

Global filters live in `data/top_companies.txt` and
`data/atlanta_companies.txt` (one company per line; `|` separates aliases).
Swap in your own lists if you don't live near Atlanta.

## 6. Validate locally

On your machine, from the repo root:

```
pip install -r requirements.txt
python -m src.config_check
pytest -q
```

`python -m src.config_check` prints two things: a per-user PASS/FAIL report
(config schema + secret wiring) and a feature table like this:

```
features (REQUIRED = the minimum for a working watcher):
  [REQUIRED] store                ENABLED   GitHub driver (STORE unset) - no vars needed
  [REQUIRED] email digest         DISABLED  - set GMAIL_ADDRESS, GMAIL_APP_PASSWORD
  [REQUIRED] llm classifier       DISABLED  - set GEMINI_API_KEY
  [OPTIONAL] ...                  DISABLED  - ...
```

The REQUIRED row says DISABLED until the matching vars are present in your
local `.env` (export them, or copy `.env.example` to `.env` and fill it in).
That is expected - it is telling you exactly what to set. The DISABLED
OPTIONAL rows (jobright, auto-apply, mail-sync, the web app) are fine; the
watcher does not need them.

The exit code of `config_check` only reflects config validity and secret
wiring, never whether the values are present locally, so a fresh checkout
with no `.env` at all still exits 0 as long as the config is valid. `pytest`
must pass before you proceed.

You can also do a full local reality check with a dry run:

```
python -m src.main --dry-run
```

This runs the entire pipeline, prints the digest it would send, and writes
nothing.

## 7. First run in Actions

In your repo: Actions -> *watch* -> Run workflow (manual dispatch).

The first run **seeds**: it marks every currently-listed job as seen without
notifying anything, so you don't get a 500-job blast. Every run after that
notifies new jobs only. The workflow then runs automatically every 2 hours.

## 8. Verify it's live

- Actions -> *watch*: the run should complete green. The run commits
  `state/seen.json` back to the repo after each run - that commit is the
  heartbeat that proves it works.
- The first new match goes out as an email digest at the next send slot
  (the shipped config sends at 8am / 12pm / 6pm ET).
- If nothing matches for a while, that's the filters working, not a fault.
  Check coverage by searching the sources for a posting you'd expect to match,
  then run `python -m src.main --dry-run --explain <dedup-key>` or look at why
  a job was rejected (`--explain jr:<24-hex>` prints the decision trace).

You now have a working watcher. The cron runs unattended; your only ongoing
job is ticking "applied" checkboxes on the dashboard issue and editing the
filters when your goals change.

---

## Appendix A: Auto-apply (fill and submit applications)

Optional, on-demand, and gated: nothing here ever runs in the cron. It drives
a browser to fill and (only after you approve) submit applications for your
matched jobs.

Setup, in brief (full detail in `docs/apply.md`):

1. Copy `users/apply.example.yaml` to `users/<you>_apply.yaml` and replace
   every placeholder with your real details (this is the answer book that
   fills forms deterministically).
2. Copy `users/logins.example.yaml` to `users/<you>_logins.yaml` for ATS
   accounts you want it to sign into (gitignored - it holds passwords).
3. Set `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` (cloud browser), or
   run with `--provider local` against a local Chromium
   (`playwright install chromium`).
4. The LLM fallback reuses the `llm`/`resume_llm` key in your watcher yaml.

Try the dress rehearsal first - it never touches a live form:

```
python -m src.apply coverage --user <you> --key <dedup-key>
```

## Appendix B: Mail-sync (statuses from recruiter email)

Optional, Convex-only: recruiter emails (rejections, OAs, interviews, offers)
update your application tracker automatically, with an Inbox action queue in
the webui for the ambiguous ones. It needs the Convex store backend
(`STORE=convex`) plus a Google Cloud OAuth client and a Pub/Sub topic.

The full setup is its own page, `docs/mail-sync.md`, including the one-time
GCP console work and the local authorization step
(`python -m src.mail_auth`). Add it after the watcher is working and you have
applications worth tracking.

## Appendix C: The other optional bits

Everything else from the README's OPTIONAL tier, in roughly the order a
self-hoster would add them:

- **Discord channel** - instant message per new match instead of (or in
  addition to) the email digest: set `notify.discord_webhook_env` in your user
  yaml and add the `DISCORD_WEBHOOK_<NAME>` secret.
- **Jobright URL resolution** - `JOBRIGHT_EMAIL` / `JOBRIGHT_PASSWORD` turn
  jobright links in your digest into the real employer apply URL.
- **Resume auto-build** - enable `resume_build` in your user yaml and add
  `users/<you>_resume.json`; see `docs/resume-auto.md` for the honest
  limitations.
- **A Convex database backend / the hosted web app** - swap the state store to
  a Convex deployment, then optionally run the browser-based UI in `web/`.
  See the README's "Database backend" and "Hosted web app (optional)".