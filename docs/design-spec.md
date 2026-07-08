# intern-watch — Project Spec

Automated internship discovery pipeline. Polls public GitHub internship lists on a GitHub Actions cron, normalizes and dedupes postings, applies per-user filter rules (with LLM assist for ambiguous cases), and pushes only *new matching* jobs to a Discord webhook digest. Multi-user by design: each user is a config file + webhook.

Target runtime: Python 3.12, GitHub Actions (free tier), no servers, no databases beyond a JSON state file committed back to the repo.

---

## 1. Sources (verified June 11, 2026)

| # | Source | URL (raw) | Branch | Format |
|---|--------|-----------|--------|--------|
| 1a | Simplify — Summer | `SimplifyJobs/Summer2026-Internships` → `.github/scripts/listings.json` | `dev` | **JSON** ✅ |
| 1b | Simplify — Off-Season (Fall 2026 / Spring 2027) | **same file as 1a**, filtered by `terms` | `dev` | **JSON** ✅ |
| 2 | jobright SWE | `jobright-ai/2026-Software-Engineer-Internship` → `README.md` | `master` | Markdown table |
| 3 | jobright Engineering | `jobright-ai/2026-Engineer-Internship` → `README.md` | `master` | Markdown table |
| 4 | jobright PM | `jobright-ai/2026-Product-Management-Internship` → `README.md` | `master` | Markdown table |
| 5 | vanshb03 Summer 2027 | `vanshb03/Summer2027-Internships` → `README.md` + `OFFSEASON_README.md` | `dev` | Markdown table |
| 6 | SpeedyApply SWE | `speedyapply/2026-SWE-College-Jobs` → `README.md` | `main` | Markdown table |

All fetched via `https://raw.githubusercontent.com/{org}/{repo}/{branch}/{path}` — no auth, no API rate-limit concerns at our volume (optionally send a GitHub token to be polite).

Sources are defined in `sources.yaml` so adding/removing one (e.g., a future `SimplifyJobs/Summer2027-Internships`) is config, not code.

### Verified format details per source

**Simplify `listings.json`** — array of objects (~17k entries as of Jun 11, 2026). Fields: `id`, `company_name`, `company_url`, `title`, `locations` (list), `terms` (list), `url`, `active`, `is_visible`, `date_posted` (unix), `date_updated`, `degrees`, `category`, `sponsorship`, `source`. **There is no separate off-season file** — this single JSON contains all terms; the repo's Off-Season README is just a rendered view of it. Verified term counts: Fall 2026 (1,538), Spring 2027 (210), Summer 2027 (219), plus Winter terms and even Fall 2027. Adapter: fetch once, filter to `active && is_visible`, emit one Job per listing with its `terms` list intact (a listing can carry multiple terms — match if any intersects the user's `terms_wanted`). Note `terms` can be `["N/A"]` → treat as unknown term. When `SimplifyJobs/Summer2027-Internships` launches, add it as a new row in `sources.yaml` with the same adapter.

**jobright repos (all three)** — README contains an HTML comment marker `TABLE_START (DO NOT CHANGE THIS LINE)`; the table follows. Columns:
`| Company | Job Title | Location | Work Model | Date Posted |`
Company and title are bold markdown links: `**[Title](https://jobright.ai/jobs/info/{24-hex-id}?utm_...)**`. The 24-hex id is the canonical jobright job ID — extract it. Date Posted is `Mon DD` (no year — infer year, handle Dec→Jan rollover). **Only the last 7 days of postings are retained** (stated in README), so the cron must run at least daily; we run every 6h.

**vanshb03** — columns: `| Company | Role | Location | Application/Link | Date Posted |`. Apply link is an HTML `<a href="..."><img ...></a>` button. The href frequently carries `jr_id={24-hex}` — the same jobright ID space as source 2–4. Extract it when present for cross-source dedup. Handle `↳` continuation rows (company carried from row above). Parse both `README.md` (Summer 2027) and `OFFSEASON_README.md` (Fall 2026 / Spring 2027 / co-ops).

**SpeedyApply** — columns: `| Company | Position | Location | Salary | Posting | Age |`. HTML anchors for company and apply button. `Age` is relative (`2d`) — convert to a date at parse time. README contains multiple table sections (FAANG+ vs. other); parse all of them. Already carries Fall 2026 and Summer 2027 roles.

---

## 2. Repo structure

```
intern-watch/
├── .github/workflows/watch.yml      # cron + manual dispatch
├── sources.yaml                      # source registry (url, branch, adapter, files)
├── users/
│   └── example.yaml                   # one config per user
├── data/
│   ├── top_companies.txt             # one name per line, '#' comments
│   └── atlanta_companies.txt         # optional explicit additions
├── state/
│   └── seen.json                     # { dedup_key: {first_seen, sources, notified_for: [user,...]} }
├── src/
│   ├── main.py                       # orchestrator
│   ├── models.py                     # Job dataclass / pydantic
│   ├── adapters/
│   │   ├── base.py                   # Adapter ABC: fetch() -> list[Job]
│   │   ├── simplify_json.py
│   │   ├── jobright_md.py            # shared by all 3 jobright repos
│   │   ├── vanshb03_md.py
│   │   └── speedyapply_md.py
│   ├── normalize.py                  # location/company/title cleanup, term inference
│   ├── dedupe.py
│   ├── filters.py                    # deterministic rule engine
│   ├── llm.py                        # Anthropic batch classify (ambiguous only)
│   └── notify.py                     # Discord webhook digest builder
├── tests/
│   ├── fixtures/                     # committed snapshot of each source's raw file
│   └── test_adapters.py              # parsers tested against fixtures
└── requirements.txt                  # httpx, pyyaml, pydantic, anthropic
```

---

## 3. Normalized Job model

```python
class Job:
    dedup_key: str          # see §5
    company: str            # normalized (strip Inc./LLC, casefold for matching)
    title: str
    locations: list[str]    # split multi-location strings
    terms: list[str]        # e.g. ["Fall 2026"]; can be multiple (Simplify); [] = unknown
    term_confidence: str    # "explicit" | "inferred" | "unknown"
    url: str                # apply/info link (utm params stripped)
    jobright_id: str | None # 24-hex when extractable
    work_model: str | None  # "On Site" | "Hybrid" | "Remote" | None
    salary: str | None      # SpeedyApply only
    date_posted: date | None
    source: str             # e.g. "jobright-swe"
    raw_title: str          # untouched, for LLM context
```

## 4. Term inference (`normalize.py`)

Regex pass over title (case-insensitive), in priority order:
1. Explicit `(Summer|Fall|Spring|Winter)\s*'?20(26|27)` → that term, `explicit`.
2. Month-range patterns (`Jan(uary)?\s*20?27`, `Sept?ember 2026`, `Aug(ust)? - Dec`, `8 months`, `co-?op`) → map to nearest term, `inferred`.
3. Simplify's `terms` field wins over title regex when present.
4. No signal → `term = None`, `unknown` → goes to the LLM stage **only if** it survives the cheap pre-filters (see §6 ordering).

## 5. Dedup (`dedupe.py`)

Same posting will appear in 2–4 sources. Compute `dedup_key` by first match:
1. `jr:{jobright_id}` — covers jobright repos **and** vanshb03 (via `jr_id` param).
2. `url:{normalized_url}` — lowercase host, strip query params/utm, strip trailing slash. For Workday/Greenhouse/Lever URLs, keep the job-ID path segment.
3. `hash:{sha1(company_norm + '|' + title_norm + '|' + (term or ''))}`.

Merge duplicate Jobs (union of sources; prefer the record with explicit term / richer fields). `state/seen.json` keys on `dedup_key`; a job is "new" if its key is absent.

## 6. Filter engine (`filters.py` + `llm.py`)

Per-user config drives everything. **Pipeline order matters for cost:** dedupe → drop already-seen → keyword/role pre-filter → term filter → company/location rules → LLM only for survivors that are still ambiguous.

### `users/example.yaml`

```yaml
name: example
notify:
  discord_webhook_env: DISCORD_WEBHOOK_EXAMPLE   # secret name, not the URL

role_filter:
  include_keywords: [software, swe, developer, engineer, backend, full stack,
                     fullstack, cloud, platform, devops, infrastructure, ml,
                     machine learning, data engineer, embedded, firmware, systems,
                     product manag, apm]
  exclude_keywords: [civil, mechanical, electrical engineer, chemical, hardware
                     design, manufacturing, quality engineer, sales engineer,
                     construction, hvac, hr, recruiting, marketing]
  # jobright "Engineer" repo is mostly non-software — this filter does heavy lifting there

terms_wanted: ["Fall 2026", "Spring 2027", "Summer 2027"]
unknown_term_policy: llm        # llm | drop | keep

rules:
  - when: { term: ["Fall 2026", "Spring 2027"] }
    accept_if_any:
      - company_in_file: data/top_companies.txt
      - location_within: { center: "Atlanta, GA", radius_miles: 35 }   # covers Alpharetta, Marietta, etc.
      - location_matches: [atlanta, alpharetta, sandy springs, marietta, "remote"]
  - when: { term: ["Summer 2027"] }
    accept_if_any:
      - always: true

llm:
  enabled: true
  model: claude-haiku-4-5-20251001
  max_jobs_per_run: 40            # cost guard
  tasks: [term_inference, top_company_judgment, atlanta_metro_judgment]
```

### Deterministic first, LLM second
- **Company matching:** normalize both sides (casefold, strip suffixes, alias map for things like "Google" / "Alphabet"). Exact/alias match against `top_companies.txt`.
- **Location:** string-match against an Atlanta-metro allowlist; no geocoding API needed for v1 (`location_within` can be implemented as the allowlist; keep the radius syntax for a future geocode upgrade).
- **LLM (`llm.py`):** one batched Haiku call per run with the ambiguous survivors (unknown term, or company not in list but plausibly "top", or fuzzy location). Prompt returns strict JSON: `[{dedup_key, term, is_top_company, in_atlanta_metro, reason}]`. Parse defensively (strip code fences). User's "top company" criteria live as a prose block in the user yaml and get interpolated into the prompt — this is the subjective knob.
- Cache LLM verdicts in `state/seen.json` under the dedup_key so re-runs never re-bill.

## 7. Notification (`notify.py`)

Discord webhook, one digest message per user per run (only if there are new matches). Group by term, then by reason matched:

```
🆕 intern-watch — 5 new matches (Jun 11, 6:00 PM)
── Summer 2027 ──
• NVIDIA — Cloud Software Intern (Santa Clara) [$62/hr] → <url>
── Fall 2026 ──
• [TOP] Stripe — SWE Intern (Remote) → <url>
• [ATL] NCR Voyix — Software Engineer Co-op (Atlanta) → <url>
```

Discord limits: 2000 chars/message → chunk; embed format optional v2. Failures must not poison state: only mark `notified_for: [user]` in seen.json **after** a 2xx from the webhook.

## 8. GitHub Actions (`watch.yml`)

```yaml
on:
  schedule: [{cron: "0 */6 * * *"}]   # every 6h; jobright's 7-day window makes daily the floor
  workflow_dispatch: {}
permissions: { contents: write }
concurrency: { group: watch, cancel-in-progress: false }
jobs:
  watch:
    runs-on: ubuntu-latest
    steps:
      - checkout
      - setup-python 3.12 + pip install
      - run: python -m src.main
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          DISCORD_WEBHOOK_EXAMPLE: ${{ secrets.DISCORD_WEBHOOK_EXAMPLE }}
      - commit & push state/seen.json if changed   # also keeps the repo "active"
        # use stefanzweifel/git-auto-commit-action or plain git commands
```

Notes: scheduled workflows are best-effort (can run late); the state-commit step doubles as the keep-alive that prevents GitHub's 60-day scheduled-workflow disable. `seen.json` should be pruned of entries older than ~120 days to keep the diff small.

## 9. Multi-user support

`main.py` loops over `users/*.yaml`. Fetch/parse/dedupe once per run; filter + LLM + notify per user. New user = drop in a yaml + add their webhook secret + reference its env name. LLM verdict cache is shared where the question is objective (term, Atlanta metro) and per-user where subjective (top company — cache under `{user}:{dedup_key}`).

## 10. Failure & quality rules

- Any single source failing (fetch error, table marker not found, zero rows parsed when previously >0) → log warning, **skip that source, continue run**. Never wipe state because a source came back empty.
- Adapters validated against committed fixtures in `tests/fixtures/`; refresh fixtures with a `make fixtures` script. Parsers must tolerate: `↳` rows, HTML in cells, multi-location strings ("Atlanta, GA / NYC"), missing dates.
- Strip all `utm_*`/`jr_id` params before storing/displaying URLs (keep `jr_id` separately for dedup).
- `--dry-run` flag: full pipeline, print digest to stdout, no webhook, no state write. First-run behavior: seed mode marks everything seen without notifying (avoid a 500-job blast), unless `--backfill` is passed.

## 11. Milestones (suggested Claude Code order)

1. **M1:** models + simplify_json adapter + jobright_md adapter + dedupe + seen.json + dry-run printing new jobs. (End-to-end skeleton, no filters.)
2. **M2:** vanshb03 + speedyapply adapters, fixtures + tests for all four parser types.
3. **M3:** filter engine + example.yaml + term regex inference.
4. **M4:** Haiku classification with caching + cost guard.
5. **M5:** Discord digest + Actions workflow + state commit + seed mode.
6. **v2 backlog:** ATS adapters (Greenhouse `boards-api.greenhouse.io/v1/boards/{co}/jobs`, Lever, Ashby) seeded from company lists — covers Atlanta companies absent from community lists; email channel; geocoded radius matching; web dashboard.

## 12. Open decisions for the template

- Top-companies list: maintain it (start ~50 names + aliases) and write the 2–3 sentence prose definition of "top" for the LLM prompt.
- Is "Remote" acceptable for Fall/Spring at non-top companies? (Current config: yes — remove `"remote"` from `location_matches` if not.)
- PM repo: keep `product manag`/`apm` keywords, or PM only at top companies? Could be a rule.