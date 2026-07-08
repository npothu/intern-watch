# Auto resume builder — known limitations

Honest list of where the auto resume builder (`docs/resume-auto.md`) can't
deliver a resume on its own, and the workaround for each. None of these are
bugs; they're the boundaries of what's reachable without a human in the loop.

## JD acquisition

### 1. Anti-bot–protected employers (e.g. Tesla)
Some career sites return **403 to every non-browser request** — the rendered
page *and* their JSON API — via Akamai/Imperva-style bot protection. Observed
on `tesla.com/careers` (2026-06-17): both the page and `cua-api/careers/job/<id>`
answer `403 Access Denied`. A headless browser from GitHub Actions' datacenter
IPs would almost certainly be blocked the same way, so this isn't worth an
arms race.
**Workaround:** paste the JD under the `/resume <key>` comment — `build_for_job`
uses pasted text verbatim and skips acquisition entirely.

### 2. JavaScript-rendered SPA career pages (Workday, iCIMS, …)
The generic scrape is a plain `httpx` GET; it sees the server HTML only. Pages
that render the JD client-side (most `*.myworkdayjobs.com`, iCIMS, some Lever
mirrors) return an empty shell, so the scrape finds no JD.
**Workaround:** same paste path. (A per-ATS JSON endpoint or a headless-browser
tier could extend coverage later — see "Possible future work".)

### 3. Sources that carry no JD body and no fetch handle
ATS-board jobs ship a `description` or `jd_url`; jobright jobs expose their JD
via the info page (`jobright_id`). But some sources dedupe on the URL alone
(`url:` keys) with **no JD body, no `jd_url`, no `jobright_id`** — the Tesla
match was one of these. For those, the only automatic tier is the generic
scrape, so #1/#2 hit hardest here.

### 4. Pre-existing dashboard matches lack rebuild handles
Matches added to the dashboard **before this feature** were stored by the old
`outbox_item` and don't carry `jobright_id`/`jd_url`. On-demand rebuilds of
those fall straight to the generic scrape even when the job *is* a jobright/ATS
posting. New matches (via `match_item`) carry the handles and rebuild cleanly.

### 5. Denial-page guard is heuristic
The scrape rejects bodies matching anti-bot/"Access Denied"/JS-shell markers so
a block page never becomes a resume. It's a fixed pattern list: a novel block
page could slip through, and a real JD that literally contains one of those
phrases could be falsely rejected (rare; the paste path covers it).

### 6. jobright JD fetch tracks jobright's page shape
Tier 3 parses jobright's `__NEXT_DATA__` blob. If jobright changes that
structure, the fetch returns nothing (fail-open) and the job falls to the
scrape tier — same as any other JD miss.

## Delivery & ops

### 7. On-demand workflow only fires from the default branch
GitHub runs `issue_comment`-triggered workflows from the **default branch**
only. So `/resume` comments and the visible row hint take effect **after merge**,
not from the PR branch.

### 8. `email` mode implies committing the `.docx`
The email outbox decouples accept-time from send-time (sends fire at the next
0/12/18 UTC slot, often a later run). The attachment must survive that gap, so
`email` mode relies on the same `git add resumes/` as `commit` mode — enabling
email commits the resume to the repo too.

### 9. Per-build LLM cost
Each auto-build is one `gemini-2.5-pro` call. `max_per_run` (default 20) caps
the spend per watcher run; matches beyond the cap defer to a later run. With
`--no-llm`/`use_llm: false` the build is deterministic and free but unpolished.

### 10. On-demand resumes live on a shared `resumes` release
The `/resume` workflow (and the manual `resume` workflow) publish the `.docx`
as an asset on one rolling `resumes` GitHub Release, so it downloads directly
as a `.docx` (no artifact-zip wrapper) and persists until deleted. Same-named
assets are `--clobber`ed, so re-building the same match replaces its asset
rather than keeping every version. The reply comment links the asset directly;
it isn't linked from the dashboard the way `commit`-mode resumes are.

## Possible future work
- Per-ATS JSON endpoints (Workday/iCIMS/Tesla) behind a host lookup, to lift
  coverage on #2 without a browser.
- A headless-browser (Playwright) acquisition tier for the on-demand path,
  where one-at-a-time rendering cost is acceptable (won't beat #1's IP blocks).
- Backfill `jobright_id`/`jd_url` onto pre-existing matches (#4) by deriving the
  jobright id from a `jr:` dedup key when present.
</content>
