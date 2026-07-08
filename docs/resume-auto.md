# Auto resume builder (JD acquisition + delivery)

Extends the existing `src/resume/` builder so that **matched jobs from the
watcher** get a tailored one-page `.docx` with no manual JD paste — and makes
the manual path easier for jobs that have no JD body. Two halves:

1. **JD acquisition** — get JD text for any `Job`, automatically.
2. **Delivery** — three config-selected modes for where the resume ends up.

The existing CLI (`python -m src.resume --jd jd.txt`) and the `resume` Actions
workflow keep working unchanged. Default config is **off** → the live watcher
behaves exactly as before until opted in.

Known limitations (blocked sites, SPA pages, ops caveats) and their
workarounds live in `docs/resume-auto-limitations.md`.

## Spine

### `src/resume/jd_source.py` — `acquire_jd(job, *, client=None, allow_scrape=True) -> str | None`

One function that returns JD text for a `Job`, trying in order (first hit wins):

1. `job.description` — already populated (free; it's in memory at notify time).
2. `job.jd_url` — Greenhouse content API: `GET`, `resp.json()["content"]`,
   `strip_html`, cap `JD_MAX_CHARS` (from `adapters.ats_boards`). Same call
   `main.enrich_jds` makes.
3. `job.jobright_id` — `adapters.jobright_page.fetch_description(client, id)`.
4. **generic scrape** of `job.url` (NEW, only if `allow_scrape`): browser-UA
   `GET` (reuse `jobright_page._PAGE_UA`), `follow_redirects=True`,
   `strip_html` (from `src.normalize`), collapse whitespace, cap
   `JD_MAX_CHARS`. Heuristic: if the page embeds `__NEXT_DATA__`/JSON-LD
   `description`, prefer that; else fall back to full stripped body.

Fail open at every step: any exception → try the next source; all miss → return
`None`. Accepts an optional shared `httpx.Client`; makes its own if `None`.
Cap result to `JD_MAX_CHARS`. A result shorter than ~200 chars is treated as a
miss (empty SPA shell).

### `src/resume/build.py` — shared build core + per-job entry point

Refactor the body of `__main__.main` into a reusable core; `__main__.main` then
calls it so the CLI output / report / exit code are **byte-identical**.

```python
@dataclass
class BuildResult:
    out_path: Path
    report: str
    pages: float
    used_llm: bool

def build_resume(jd_text, bank, *, company, out_path, llm_cfg,
                 use_llm=True, max_projects=select.MAX_PROJECTS) -> BuildResult
    # analyze -> build_plan -> (optional) tailor -> fit_plan -> render -> report

def resume_llm_cfg(user: str, root: Path) -> dict
    # the `resume_llm:` block, falling back to `llm:` — moved here from __main__

def out_name(bank, company, *, suffix="") -> str
    # f"{First}_{Last}_{Company}{suffix}.docx" (suffix = f"_{shortkey}" for jobs)

def build_for_job(job, user, *, out_dir, root, use_llm=True,
                  allow_scrape=True, client=None) -> BuildResult | None
    # load bank; jd = acquire_jd(job, ...); if not jd: return None (logged);
    # out = out_dir / out_name(bank, job.company, suffix="_"+short_key(job.dedup_key));
    # return build_resume(jd, bank, company=job.company, out_path=out, ...)
```

`short_key` is `dashboard.short_key`. Including it in the filename prevents two
jobs at the same company from colliding.

## Config (`users/<name>.yaml`)

```yaml
resume_build:
  enabled: false
  modes: []            # any subset of [commit, email, dashboard]
  use_llm: true
  allow_scrape: true
  max_per_run: 20      # cost guard on gemini-2.5-pro calls per run
```

Accessor `resume_build_cfg(user_cfg) -> dict` (in `build.py` or a small
`config.py`) returns the block merged over defaults. `enabled: false` or empty
`modes` ⇒ the watcher does nothing new.

## Auto build at accept time (`commit` + `email` modes)

In `main.process_user`, **after** `accepted` is finalized (after
`_drop_eliminated`) and **before** the outbox/matches dicts are written:

- If `enabled` and `modes ∩ {commit, email}`: for each accepted `(job,
  reasons)`, call `build_for_job(job, name, out_dir=ROOT/"resumes"/name, ...)`,
  honoring `max_per_run` (log deferrals). Record `dedup_key -> relative .docx
  path` for jobs that built.
- `--dry-run`: do **not** build / call the LLM / write files; log the count of
  resumes that *would* be built.
- The built path (relative to repo root, POSIX separators) is stored on the
  match/outbox dict under key `"resume"` so both delivery modes can find it.
- Reuse `resume_llm_cfg`. Wrap each build in try/except — a build failure must
  never drop the match or block other users (log + continue, `resume` stays
  unset).

### Outbox / matches dict extension

`outbox_item` keeps its current keys (email display). The match dict
(`matches_add`) and outbox dict gain optional reacquisition + link fields:
`"resume"` (relative path, set after a successful build),
plus for on-demand rebuild: `"jobright_id"`, `"jd_url"`. Add a helper
`match_item(job, reasons, terms_order)` = `outbox_item(...)` + these fields,
used where the code currently builds the matches/outbox dicts. All new keys are
optional and ignored by existing readers.

## Mode: `commit`

- Builds land in `resumes/<user>/<file>.docx` (committed to the repo).
- `.github/workflows/watch.yml` commit step also does `git add resumes/`
  alongside `state/seen.json` (same commit; keeps the repo active).
- Dashboard `_row` renders a `📄 resume` link when the item has a `"resume"`
  path. Link is root-relative `/<repo>/blob/<branch>/<path>` — thread `repo`
  and `branch` (default `main`, from `GITHUB_REF_NAME`) from `sync_user` into
  `build_body`/`_row`. No `resume` key ⇒ no link (back-compatible).

## Mode: `email`

- The outbox decouples accept-time from send-time, so the `.docx` must persist
  to disk between runs — `email` mode therefore also writes to `resumes/<user>/`
  and relies on the same `git add resumes/` (i.e. enabling `email` implies the
  file is committed too). Document this.
- `notify.send_email` gains `attachments: list[Path] | None`. Each existing
  file is attached as
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document`.
- `_notify_email`: collect `Path(item["resume"])` that exist for outbox items,
  pass to `send_email`. Missing files are skipped silently (don't block send).

## Mode: `dashboard` (on-demand)

No build at accept time. Instead a new workflow builds on request.

### `src/resume/ondemand.py` — CLI

```
python -m src.resume.ondemand --user example --short <12-hex>
```

Loads `state/seen.json`, finds the match item whose `short_key(key)` matches
`--short`, reconstructs a minimal `Job(company, title, url, source="dashboard",
jobright_id=item.get("jobright_id"), jd_url=item.get("jd_url"))`, calls
`build_for_job(... out_dir=Path("out"))`, prints the resulting path (or a clear
"no JD found" message + nonzero exit).

### `.github/workflows/resume-ondemand.yml`

- `on: issue_comment` (types: `[created]`).
- Guard: `github.event.issue.title` contains `intern-watch matches` **and**
  the comment body starts with `/resume`. Parse the 12-hex short key arg.
- Steps mirror `resume.yml`: checkout, setup-python, pip install, run
  `python -m src.resume.ondemand --user <from title> --short <arg>`, **publish
  the `.docx` as an asset on a rolling `resumes` release** (`gh release upload
  resumes <file> --clobber`) so it downloads directly as a `.docx` rather than
  a zipped artifact, and post a reply comment (via `gh`) linking the asset's
  direct download URL. React 👀 on start. Needs `permissions: issues: write,
  contents: write, actions: read`.

## Mode: batch from the dashboard (click-to-build)

Zero typing: each dashboard row carries a `📄 build resume` sub-checkbox and the
issue has one top-level **Build selected resumes** trigger box. Tick the rows you
want, then tick the trigger; the build runs in seconds (commit mode), the rows
gain resume links, and the trigger resets itself.

### `src/resume/batch.py` — CLI

```
python -m src.resume.batch --user example --summary /tmp/comment.md   # body in $ISSUE_BODY
```

Reads the edited issue body (`$ISSUE_BODY` or `--body <file>`). No-ops unless the
trigger box is ticked. Builds each ticked row that has no `resume` yet (so
already-built rows are skipped — that's how "build only the not-yet-built ones"
falls out), into `resumes/<user>/` exactly like `commit` mode, records the
repo-relative path on the match item (survives the next dashboard rewrite), and
saves state. Honours the explicit click regardless of `resume_build.enabled`;
only `use_llm` / `allow_scrape` / `max_per_run` are read from config. Writes
`built=` / `failed=` to `$GITHUB_OUTPUT` and a markdown comment to `--summary`.

### `src/dashboard.py` parsing + repaint CLI

- `parse_build_selections(body)` → ticked `<!--iwb:<short>-->` boxes;
  `build_trigger_checked(body)` → the `<!--iw:build-->` box. Distinct markers, so
  neither collides with the applied box's `<!--iw:<short>-->`.
- `python -m src.dashboard --user <name>` repaints the issue from state
  (needs `GITHUB_REPOSITORY`/`GITHUB_TOKEN`; no-ops without them).

### `.github/workflows/resume-batch.yml`

- `on: issues` (types: `[edited]`).
- Guard: title contains `intern-watch matches` **and** body contains
  `[x] **Build selected resumes**`. The repaint always renders the trigger
  unchecked, so the bot's own edit can't re-fire the workflow (no loop); ordinary
  applied-box ticks fail the guard cheaply.
- Steps: react 👀, checkout, setup-python, pip install, run
  `python -m src.resume.batch`, commit `resumes/` + `state/seen.json`
  (`git pull --rebase` then push, mirroring `watch.yml`), repaint via
  `python -m src.dashboard`, then post the summary comment. Needs
  `permissions: issues: write, contents: write`.

## Tests (add; keep the whole suite green)

- `jd_source`: each tier (description short-circuit; jd_url json; jobright via
  monkeypatched `fetch_description`; generic scrape via a fake client) + the
  short-result-is-a-miss rule + fail-open. No real network.
- `build`: `build_resume` parity with the old `__main__` path (same plan/report
  on a fixture JD + fixture bank); `out_name` collision-avoidance; `build_for_job`
  returns `None` when JD acquisition fails.
- `config`: `resume_build_cfg` defaults + override merge.
- `process_user`: with `resume_build.enabled` and a stub `build_for_job`
  (monkeypatched), the match dict gets a `resume` path; `--dry-run` builds
  nothing; `max_per_run` caps; a build raising doesn't drop the match.
- `notify`: `send_email` attaches files (assert on the `EmailMessage` parts);
  `_notify_email` passes existing resume paths only.
- `dashboard`: `_row` emits the link when `resume` present, omits otherwise;
  `build_body` link uses `/<repo>/blob/<branch>/...`.
- `ondemand`: finds item by short key, reconstructs the Job, calls
  `build_for_job` (monkeypatched), prints the path; missing key → nonzero exit.

## Constraints for implementers (hard)

- **Never** `git commit`, `git push`, or change branches. Edit files only.
- **Never** add Co-Authored-By / Claude trailers anywhere.
- Keep `python -m pytest -q` green (246 baseline + your new tests).
- Default config off ⇒ no behavior change to the live watcher.
- Match the surrounding code's style (fail-open `# noqa: BLE001`, terse
  docstrings explaining *why*, type hints, `from __future__ import annotations`).
- Windows + Linux: build paths with `pathlib`, store relative paths with POSIX
  separators (`.as_posix()`).
</content>