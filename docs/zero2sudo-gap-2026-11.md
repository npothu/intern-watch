# Gap diagnosis: postings found outside the pipeline (2026-11)

**Question.** Some internships were applied to from links an Instagram creator
(zero2sudo) posted, or were added to the ledger by hand as `[MANUAL]`.
This doc asks why the pipeline did not deliver them first.

**Scope.** 49 applications: the hand-added ledger entries plus the applied-log
lines tagged `(source: zero2sudo)`. We will not scrape Instagram. It is
auth-gated, it would need an unofficial client, and the platform's terms
forbid it. That is the same stance this repo takes on jobright's full feed.
Every fix below targets the public employer and list data.

**Method.** We used the CLAUDE.md debugging recipe, run against the instance's
`origin/main` `state/seen.json` on 2026-11-08:

- Look up each application URL by dedup key, then by `canonical_url`, then by
  ATS requisition id, then by company plus title.
- If the job is in seen.json, read `first_seen`, `sources`, `notified_for` and
  the `llm` facts.
- Replay the real source row (title, terms, degrees, locations from that day's
  Simplify `listings.json`, which still holds inactive rows) through
  `filters.UserFilter`. Use the user config **as it was on the job's
  `first_seen` date**, from the data repo's git history.
- If the job is not in seen.json, look for it in the zshah101 automated list's
  history (`data/jobs.json`, closed rows included). Check its ats-boards
  coverage. Fetch the posting URL once to see whether it is still live.

Only aggregate counts by failure class and ATS appear here, plus synthetic
examples. No individual application, posting or employer is listed.

Workstream letters refer to the parallel scraping-input work started on
2026-11-08: **A** Workday listing adapter; **B** SmartRecruiters, Oracle CX,
Avature, Eightfold, Phenom and iCIMS listing adapters; **C** JD acquisition
for those ATSes; **E** term inference from JD text; **F** closed-posting
liveness probe; **G** manual-add → suggested ats-boards row, gap report and
link intake; **H** first-sight seeding of newly added sources.

## Headline

| class | n | meaning |
|---|---:|---|
| **b-grad**: rejected as grad-only by a config that has since changed | **22** | Ingested, then eliminated under `grad_only: true`. The user later loosened it to `grad_only: phd`. Rejections are final, so nothing re-evaluated them. |
| **b-role**: rejected by the role filter | 7 | 5 are a keyword-matching bug (`" ai "`). 2 follow the keyword lists as configured. |
| **b-term**: rejected on term | 5 | 3 got LLM term = null and fell to `term-unresolved`. 2 carried a wrong explicit term from Simplify. |
| **delivered**: not a miss (a class added to a-d) | 7 | Delivered before the manual add. The manual add used another URL for the same posting, so the ledger did not link it to the match. |
| **c**: latency | 1 | Ingested and delivered the day after it was applied to. |
| **a**: never ingested | 7 | The employer's own career site or a small board. No list carried the posting, and there is no ats-boards row. |
| **d**: genuinely private/unlisted | 0 | Every link was a public posting. Three are now closed (404/410), so their original status cannot be checked. |

**The main finding is not about sources.** 35 of the 49 postings (b + c) were
in `seen.json`, and 7 more were delivered. Only 7 were never ingested. Most
misses are **filter decisions that are final**, and most of those come from
one config change.

### b-grad scale beyond these 49

We replayed every live Simplify row first seen before the config change that
was never delivered. 266 were rejected as grad-only under the old config. **94 of
those pass the current config.** 69 of the 94 are at the user's priority employers. The most affected are
large tech, semiconductor and quant employers with Master's-eligible programs. 22 of the 94 have a delivered company+title sibling, so about 72 are
true silent misses. Simplify rows are only one source, so this is a lower
bound.

## Breakdown by failure stage and ATS

This public template does not carry the individual application history. Below
are counts only. ATS is the host of the URL that was applied to.

| ATS | n | b-grad | b-role | b-term | delivered | c | a |
|---|---:|---:|---:|---:|---:|---:|---:|
| Oracle CX (incl. custom-domain fronts) | 12 | 10 | 1 | | | 1 | |
| Workday (incl. Radancy fronts backed by Workday) | 12 | 4 | 5 | | 3 | | |
| Greenhouse (incl. EU, embeds, own-domain `gh_jid`) | 9 | 5 | 1 | | 2 | | 1 |
| Ashby | 3 | | | 3 | | | |
| SmartRecruiters | 2 | 2 | | | | | |
| other (own career sites, Phenom, Eightfold, Avature, SuccessFactors, Rippling, Workable) | 11 | 1 | | 2 | 2 | | 6 |
| **total** | **49** | **22** | **7** | **5** | **7** | **1** | **7** |

Takeaway: **Oracle CX and Workday account for 24 of the 49**, and in every
one of those 24 the job *was* ingested. More ATS coverage alone would
not have delivered them.

Sub-stages:

- **b-grad (22):** 21 were `eliminated:grad-only-degrees` from a source
  `degrees` list of Master's and/or PhD. 1 was `eliminated:grad-only-title`.
  In 13 of the 22, the URL applied to was an alias of the ingested URL: an
  Oracle CX custom domain, a Radancy front or a SmartRecruiters slug. That
  hides the match from a URL lookup but does not change the outcome.
- **b-role (7):** 5 were `no-role-keyword` caused by the `" ai "` padding
  bug (Fix 2). 1 had no include keyword at all (an analytics title). 1 hit
  an exclude keyword as configured.
- **b-term (5):** 3 were `term-unresolved` after the LLM returned null. 2
  were `term-not-wanted` because the source's "explicit" term disagreed with
  the posting.
- **a (7):** 6 were own-site-only employers (Eightfold, Avature,
  SuccessFactors x2, a Radancy front, a custom site). 1 was a small
  Greenhouse board with no ats-boards row. 3 of the 7 are now closed (404/410).

### Synthetic examples of each failure

These are invented postings (fictional employer, `.invalid` hosts) that
reproduce each mechanism:

| example | mechanism | class |
|---|---|---|
| Example Corp "Widget Systems Intern", Simplify `degrees: ["Master's"]`, first seen under `grad_only: true`; config later set to `phd` | eliminated once, never re-evaluated | b-grad |
| `careers.example.invalid/en/sites/CX_1/job/1234` (front) vs `abcd.fa.us2.oraclecloud.com/.../sites/CX_1/job/1234` (ingested) | same req, two URLs; lookup misses | b-grad (alias) |
| "Gizmo Tuning Intern - Applied AI" | `" ai "` never matches a title-final "AI" | b-role |
| Ashby posting titled "Summer 2027 Gadget Builder Internship"; the list row says "Gadget Builder Intern" with term "Winter 2026" | source term overrides the posting | b-term |
| "Widget Platform Intern" with no term in the title; LLM returns `term: null` | most-restrictive fallback rejects | b-term |
| Delivered via `example.wd1.myworkdayjobs.com/.../Intern_R12345`; manual add uses `example.invalid/jobs/12345` | manual add not linked to the match | delivered |
| Employer on SuccessFactors only, no list carries it | no adapter, no list | a |

## Fixes

Ordered by recovered postings per unit of work.

### Fix 1: re-evaluate rejected jobs when the filter config loosens (new; no workstream owns it)

The invariant "rejected jobs are final" exists to save LLM cost and avoid
re-delivery churn. But it has no escape hatch, even for a config change the
user made on purpose. Proposal:

- Store a `cfg_hash` per user in state: a stable hash of `role_filter`,
  `eliminate`, `terms` and `term_rules`, plus the priority list. Also store a
  `reject_reason` on each rejected entry. Today `--explain` can only re-derive
  the reason.
- When the hash changes, re-run the **deterministic** first pass for jobs that
  are still listed (their `last_seen` is today). Deliver the ones that now
  pass, and queue the newly ambiguous ones for the normal cost-capped LLM step
  over the next runs. Jobs no longer listed stay final.
- Also expose this as a one-off `python -m src.main --reevaluate-rejected`
  (dry-run by default), so a user can backfill after a manual config edit.

Expected effect: the 22 b-grad rows here, plus about 72 other live Simplify
postings, 69 of them at priority employers. Review notes, per CLAUDE.md:
- This deliberately changes "rejected jobs are final". Re-delivery is bounded
  to jobs still listed.
- More jobs reach the LLM. Keep the per-run cap.
- It touches `src/main.py` and `src/state.py`, so it needs `/codex-review`.

Workstream E's term backfill is a special case of the same mechanism: it
re-evaluates `term-unresolved` jobs once JD-based term inference exists. One
shared re-evaluation path should serve both.

### Fix 2: role-filter keyword padding (`src/filters.py`; proposed here, not changed in this PR)

`evaluate()` checks `kw in title.casefold()`. Keywords written with spaces
(`" ai "`, `" hr "`) therefore never match at the start or end of a title, or
next to punctuation ("AI Widget Intern", "... Gizmo Tuning - Applied AI",
"(AI)", "AI/ML" at the
start). Proposal: match against
`" " + re.sub(r"[^a-z0-9+#&]+", " ", title.casefold()) + " "`. Every
keyword's substring semantics stay the same; we only add word boundaries
where the yaml asked for them. Apply the same padding to `exclude_keywords`
(`" hr "` has the mirror bug) and to `strict_include_keywords`.

Measured on 2026-11-08: **163 live rows** across simplify, speedyapply-ai and
zshah-2027 are rejected `no-role-keyword` today and would pass with padding.
The affected shapes are titles that start with "AI" and titles that end in
"- AI" (for example, a made-up "AI Widget Intern" or "Gadget Systems Intern -
AI"). Some are non-SWE (an "AI ... Analyst" shape), and those will now
reach the term/rules/LLM steps. Expect more top-company LLM calls per run
while the backlog clears.
Previously rejected jobs: nothing happens to them unless Fix 1 lands.
Also consider adding `autonomy` to `include_keywords`/`strict_include_keywords`
(titles naming an autonomy team).

### Fix 3: config, not code

- `data analytics`: decide whether analytics internships are wanted. One
  ingested row was rejected for lacking it, and one never-ingested row would
  have been.
- `supply chain` in the exclude list blocks any "Supply Chain ... AI" title. If wanted,
  replace the bare exclude with a narrower one.

### Fix 4: canonical identity for Oracle CX and SmartRecruiters aliases (B/C)

- Oracle CX: `.../hcmUI/CandidateExperience/<lang>/sites/<site>/job/<id>` on
  `*.fa.*.oraclecloud.com`, and the same `/sites/<site>/job/<id>` path on an
  employer's vanity domain, are one posting.
  `canonical_url` should emit `ats:oraclecx:<tenant>:<id>`, with a small
  `custom host → tenant` alias map (seeded from the zshah101
  `data/companies.json`, which maps 5,354 companies to an ATS/slug/host).
  Without this, a front-site manual add or a second list with the vanity URL
  is a new key.
- SmartRecruiters: `jobs.smartrecruiters.com/<Company>/<id>[-slug]` →
  `ats:sr:<company>:<id>`. **Done in this PR** (canonical v4), together with
  Workday numeric and short-prefix reqids (`_2642004-1`, `_UNI4670`) and a
  case-insensitive Workday fallback path.
- Radancy/TalentBrew fronts (an employer's `careers.<domain>`) link to the
  backing Workday req (`..._R123456/apply`). An alias resolver for
  manual adds can follow that one link.

Workstream B (Oracle CX listing adapter) should own the Oracle canonical
form, so its new keys and these aliases agree from day one.

### Fix 5: link manual adds to existing matches (G)

7 of the 49 "misses" were delivered. They went into the ledger as `[MANUAL]`
because the manual URL differed from the delivered one. A manual add should
first resolve against `url_index` (by canonical) and the content signature.
On a hit it should attach to the existing match, which marks it applied, and
should not create a `[MANUAL]` record. This also stops these from inflating
G's gap report.

### Fix 6: sources (this PR)

This PR adds the `zshah-2027` (automated, open postings, direct ATS URLs) and
`speedyapply-ai` lists. On 2026-11-08, 208 zshah rows and about 129 AI-list
rows were in no other source, and the zshah rows were mostly Workday / Oracle
CX / SmartRecruiters.

Their current backlog is **seed-marked, not delivered**: the first-sight
seeding change (workstream H) merges first and marks every row a newly added
source lists on its first run as seen. Only postings that appear later are
delivered. Like any other rejection, the seeded rows are not re-evaluated.
New sources therefore improve future latency and coverage. They do not
recover b-grad, b-role or b-term misses; those need Fixes 1-3.

### What other workstreams already cover

| fix | workstream |
|---|---|
| Workday breadth | A. Note that every Workday miss here was ingested, so A adds latency and coverage but would not have changed these outcomes. |
| Oracle CX / SmartRecruiters / Avature / Eightfold / Phenom listing adapters; canonical forms (Fix 4) | B |
| JD fetch for Oracle/Avature/Phenom/Eightfold (needed for JD-based term and grad-only) | C |
| `term-unresolved` and wrong-source-term (the 5 b-term rows) | E |
| closed-posting probe (the 3 closed class-a postings) | F |
| manual add → existing match / suggested ats-boards row, gap report (Fix 5) | G |
| re-evaluation on config change (Fix 1), keyword padding (Fix 2) | **none yet** |
