# Auto-apply (`src/apply/`)

Turns accepted matches into job applications by driving a browser. Walled off
from the watcher pipeline (`src/main.py`) — a bug here can't corrupt discovery
state — and it never runs in the 2h cron. Applying is on-demand (CLI) or a
separate gated runner.

## Flow

```
match (state["matches"][user])
  -> resolve(url)              follow redirects to the real ATS  (resolve.py)
  -> classify -> ATSFamily     greenhouse | workday | lever | ashby | unknown
  -> get_filler(family)        deterministic for GH/Workday; LLM agent for rest
  -> browser_session(...)      Browserbase (cloud) or local Chromium (driver.py)
  -> filler.apply(page, ctx)   fill + attach tailored .docx
       autofill mode -> PAUSE before submit (filled_paused)
       submit mode   -> submit, confirm (submitted)   [only if approved]
```

Aggregator links (jobright/Simplify trackers) redirect into the real ATS, so
`resolve()` makes a live request per job. Unknown destinations route to the LLM
agent fallback (`fillers/agent.py`), which scrapes the form, fills everything it
can from the **answer book** (`answers.py`), then asks the model once to map the
remaining fields — the LLM never drives clicks.

## The answer book (`answers.py`)

`users/<user>_apply.yaml` is a comprehensive set of answers: contact, address,
work authorization, EEO, education, compensation, experience, logistics,
screening (18+, background-check/drug-test consent, driver's license), referral,
plus a freeform `questions:` map for essays and oddly-worded prompts.
`answer_for(field)` matches a form field's label against a broad rule table and,
for selects/radios, maps the answer onto the field's real options — so most
standard questions are filled **without an LLM**. The LLM only covers the rest.

## Two modes & the gate

- **autofill** (default): fill, attach the resume, screenshot, stop before submit.
- **submit**: fill *and* submit — only for matches you've **approved**
  (`approved_to_apply`). The gate that keeps unreviewed applications from going out.

## CLI

```bash
python -m src.apply list   --user example
python -m src.apply apply  --user example --key jr:abc --provider local   # fill one, pause
python -m src.apply approve --user example --key jr:abc
python -m src.apply apply  --user example --key jr:abc --mode submit       # gated submit
python -m src.apply drain  --user example --limit 5
```

`scripts/apply_batch.py` runs a fixed list of arbitrary URLs (not just state
matches), screenshotting every page into `state/apply_artifacts/<date>/<slug>/`.

## Config & secrets

- `users/<user>_apply.yaml` — the answer book (schema in `src/apply/profile.py`).
- **Cloud browser (Browserbase):** `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID`.
- **LLM agent:** reuses the `resume_llm`/`llm` block in `users/<user>.yaml`.
- **ATS logins / account creation:** `users/<user>_logins.yaml` (GITIGNORED —
  passwords; copy from `*_logins.example.yaml`). For Workday the filler signs in
  or **creates** an account; set `method: google` to use "Continue with Google".
- **Email inbox** (`inbox.py`): verification links + OTP codes are polled over
  IMAP and resolved automatically. Reuses `GMAIL_ADDRESS` / `GMAIL_APP_PASSWORD`.
- All secrets load from a gitignored `.env` at CLI startup.
- **Persistent logins:** `browser_session` saves/loads Playwright `storage_state`
  per ATS under `state/apply_sessions/` (gitignored — auth cookies). Screenshots
  land in `state/apply_artifacts/` (gitignored).

## Limits (honest)

- Login/MFA: Workday returns `blocked_login` when it can't proceed; emailed
  verification/OTP auto-resolve, but app/SMS MFA needs a one-time interactive login.
- CAPTCHA: only a *visible* widget blocks (`dom.has_visible_captcha`) — invisible
  reCAPTCHA (e.g. Ashby) doesn't, but a challenge on submit returns `blocked_captcha`.
- Some sites bot-block the cloud IP (e.g. Tesla "Access Denied") — needs stealth/
  proxy or isn't automatable. Some "Apply" buttons lead off-page (Phenom/ABB).
- The LLM agent (Lever/Ashby/unknown) is less reliable than the deterministic
  fillers — review autofill output before submitting.
- Setup: `pip install -r requirements.txt && playwright install chromium`.