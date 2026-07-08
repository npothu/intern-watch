# Browserbase / shared browser sessions

Any feature that needs to drive a real browser — auto-apply, and others to
come — goes through one helper: `src/browser/session.py`. It opens either a
**Browserbase** hosted browser (connected over CDP) or a **local Chromium**, and
optionally persists login state between runs. It has no feature-specific
knowledge, so multiple features share it without coupling.

## The session helper

```python
from src.browser import BrowserConfig, browser_session

cfg = BrowserConfig(provider="browserbase")          # or "local"
with browser_session(cfg, storage_path="state/sessions/site.json") as page:
    page.goto("https://example.com")
    ...                                               # page is a Playwright Page
```

- `provider="browserbase"` connects over CDP using credentials from the env vars
  named by `cfg.api_key_env` / `cfg.project_id_env` (defaults below). The
  credentials are read from the environment — never passed in code or config.
- `provider="local"` launches a local Chromium (`headless` honored); handy for
  hands-on debugging.
- `storage_path` (optional): load/save Playwright `storage_state` so a one-time
  interactive login is reused on later runs.

## Credentials

| Env var                  | Purpose                                  |
|--------------------------|------------------------------------------|
| `BROWSERBASE_API_KEY`    | Browserbase API key                      |
| `BROWSERBASE_PROJECT_ID` | Browserbase project id                   |
| `GEMINI_API_KEY`         | Model key for AI automation (Stagehand)  |

**Locally:** put them in a gitignored `.env` (see `.env.example`); each feature's
CLI loads it at startup.

**In GitHub Actions:** they are stored as **repository secrets** of the same name
(set once via `gh secret set <NAME>`). A workflow makes them available by wiring
each into the run step's `env:` block — only then does the secret reach the
process:

```yaml
    steps:
      - run: python -m src.<feature>
        env:
          BROWSERBASE_API_KEY: ${{ secrets.BROWSERBASE_API_KEY }}
          BROWSERBASE_PROJECT_ID: ${{ secrets.BROWSERBASE_PROJECT_ID }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

The cron watcher (`watch.yml`) does **not** need these — browser features run
on-demand / in their own workflows, never in the 2h discovery cron.

## AI browser automation (Stagehand)

For perception + actions on pages (read field state, fill, click), pair the
session with [Stagehand](https://stagehand.dev) (`stagehand` on PyPI). It exposes
`observe` / `act` / `extract` over a Browserbase session; `extract` returns
schema-validated data, which is the reliable way to verify *what is actually
filled* rather than inferring it from a screenshot.
