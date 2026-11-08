# Gap diagnosis: postings found outside the pipeline (2026-11)

**Question.** Some internships were applied to from links an Instagram creator
(zero2sudo) posted, or were added to the ledger by hand as `[MANUAL]`.
This doc asks why the pipeline did not deliver them first.

**Scope.** 49 applications: the 46 `[MANUAL]` ledger entries plus 3 applied-log
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

Only company and ATS names appear here. No personal data is included.

## Headline

| class | n | meaning |
|---|---:|---|
| **b-grad**: rejected as grad-only by a config that has since changed | **22** | Ingested, then eliminated under `grad_only: true`. The config moved to `grad_only: phd` on 2026-10-05. Rejections are final, so nothing re-evaluated them. |
| **b-role**: rejected by the role filter | 7 | 5 are a keyword-matching bug (`" ai "`). 2 follow the keyword lists as configured. |
| **b-term**: rejected on term | 5 | 3 got LLM term = null and fell to `term-unresolved`. 2 carried a wrong explicit term from Simplify. |
| **delivered**: not a miss | 7 | Delivered before the manual add. The manual add used another URL for the same posting, so the ledger did not link it to the match. |
| **c**: latency | 1 | Ingested and delivered the day after it was applied to. |
| **a**: never ingested | 7 | The employer's own career site or a small board. No list carried the posting, and there is no ats-boards row. |
| **d**: genuinely private/unlisted | 0 | Every link was a public posting. Three are now closed (404/410), so their original status cannot be checked. |

**The main finding is not about sources.** 35 of the 49 postings (b + c) were
in `seen.json`, and 7 more were delivered. Only 7 were never ingested. Most
misses are **filter decisions that are final**, and most of those come from
one config change.

### b-grad scale beyond these 49

We replayed every live Simplify row first seen before 2026-10-05 that was
never delivered. 266 were rejected as grad-only under the old config. **94 of
those pass the current config.** 69 of the 94 are at priority employers (Waymo
12, AMD 9, ByteDance 6, Marvell 6, TikTok 4, GE Vernova 4, Intel 3, BlackRock
3, ...). 22 of the 94 have a delivered company+title sibling, so about 72 are
true silent misses. Simplify rows are only one source, so this is a lower
bound.

## Per-application table

ATS is the host of the URL that was applied to.

| company | ATS | class | stage / detail | fixed by |
|---|---|---|---|---|
| American Express (x10) | Oracle CX (custom domain + `egug.fa.us2`) | b-grad | Simplify degrees `["Master's"]`, first seen Aug-Sep → `eliminated:grad-only-degrees`. The manual URL `careers.americanexpress.com/.../job/<id>` is the same req as the ingested `egug.fa.us2.oraclecloud.com/.../job/<id>`, but `canonical_url` does not join them. | Fix 1 (re-evaluate); Fix 4 (Oracle alias) |
| BlackRock (x3) | Workday (2 via the `careers.blackrock.com` front) | b-grad | `degrees ["Master's"]`, first seen 09-15. The front-site URL has its own id; the Workday req (R2664xx) was ingested. | Fix 1; Fix 4 |
| Veeam (AI/ML, Kasten) | Greenhouse EU | b-grad | Master's/PhD degrees, first seen 09-12 | Fix 1 |
| Solidigm | SmartRecruiters | b-grad | Master's/PhD, 09-05. The manual URL has a slug suffix (`/<id>-<slug>`) and the ingested one doesn't, so the SmartRecruiters canonical form misses it. | Fix 1; Fix 4 |
| Western Digital | SmartRecruiters | b-grad | Master's, 09-14 | Fix 1 |
| HP IQ | Greenhouse | b-grad | Master's/PhD, 09-01 | Fix 1 |
| Intel | Workday | b-grad | Master's/PhD, 09-03 | Fix 1 |
| Waymo | Greenhouse (`gh_jid` on own domain) | b-grad | MS/PhD, 09-17 | Fix 1 |
| TWG Global | Workable | b-grad | Master's/PhD, 09-01 | Fix 1 |
| SpaceX | Greenhouse (ats-boards) | b-grad | `eliminated:grad-only-title` ("Graduate Engineer Internship"), 08-03 | Fix 1 |
| General Motors (x4) | Workday | b-role | Simplify titles "Seam Intern - Embodied AI" / "Onboard Autonomy Intern - Embodied AI" → `no-role-keyword`. The `" ai "` keyword needs a space after it, so it never matches a title that ends in AI. | Fix 2 |
| Mayo Clinic | Oracle CX | b-role | "Undergraduate Intern - Neurology AI": same `" ai "` bug | Fix 2 |
| Veeam (Data Analytics & Programs) | Greenhouse EU | b-role | no include keyword ("data analytics" is not in the list); config choice | Fix 3 (config) |
| Danaher | Workday | b-role | "Supply Chain AI Co-op" → `excluded-keyword:supply chain` (works as configured) | Fix 3 (config) |
| Cisco | Phenom (`careers.cisco.com`), via jobright-eng | b-term | LLM term null → `term-unresolved` | E |
| OpenGov | Ashby | b-term | no term in title, LLM term null → `term-unresolved` | E |
| TensorWave | Ashby | b-term | LLM term null; Simplify later labelled it "Summer 2026" | E |
| Armadin | Ashby | b-term | the posting says Summer 2027, but Simplify's row says **Winter 2026** with the term stripped from the title → `term-not-wanted` | E (JD term should override a source's "explicit" term) |
| Root Insurance | Rippling | b-term | Simplify said Winter 2026 → `term-not-wanted`; ingested the day after the apply | E |
| Texas Instruments | Oracle CX | c | ingested (Simplify) and delivered the day after it was applied to from the zero2sudo link | this PR (`zshah-2027` lists TI's Oracle CX reqs) |
| Khan Academy, Stripe, Muon Space, T-Mobile, Datadog, General Motors (x2) | Greenhouse / Workday / own site | delivered | `notified_for` holds the user (Datadog via a content-signature sibling key) | G (link manual adds to existing matches) |
| Tenet3 | Greenhouse | a | no list carried it, no ats-boards row, posting now gone | G (suggested ats-boards row) |
| Sephora | Eightfold (`join.sephora.com`) | a | own site only | B (Eightfold listing) |
| IBM | Avature (`ibm.com/careers`) | a | own site only (the manual entry's title was the search page) | B (Avature listing) |
| CNH | SuccessFactors (`join.cnh.com`) | a | own site only | none (no SuccessFactors adapter planned) |
| Entergy | SuccessFactors (`jobs.entergy.com`) | a | own site only; the title would also fail the role filter (no keyword) | none |
| L3Harris | Radancy front (`careers.l3harris.com`) | a | own site only, now 404. Other L3Harris postings do arrive via the lists (83 delivered). | A/B if the backing ATS is identified |
| Shopify | own site (`shopify.com/careers`) | a | own site only, now 410 | none |

### Counts per ATS (host applied to)

| ATS | n | classes |
|---|---:|---|
| Oracle CX (incl. a custom-domain front) | 12 | b-grad 10, b-role 1, c 1 |
| Workday (incl. Radancy fronts) | 12 | b-grad 4, b-role 5, delivered 3 |
| Greenhouse (incl. EU, embeds, own-domain `gh_jid`) | 9 | b-grad 5, b-role 1, delivered 2, a 1 |
| Ashby | 3 | b-term 3 |
| SmartRecruiters | 2 | b-grad 2 |
| other: own site (6), Phenom, Rippling, Workable, Stripe/Datadog own sites | 11 | a 6, b-term 2, b-grad 1, delivered 2 |

Takeaway: **Oracle CX and Workday account for 24 of the 49**, and in every
one of those 24 the job *was* ingested. More ATS coverage alone would
not have delivered them.

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
next to punctuation ("AI Intern", "... Embodied AI", "(AI)", "AI/ML" at the
start). Proposal: match against
`" " + re.sub(r"[^a-z0-9+#&]+", " ", title.casefold()) + " "`. Every
keyword's substring semantics stay the same; we only add word boundaries
where the yaml asked for them. Apply the same padding to `exclude_keywords`
(`" hr "` has the mirror bug) and to `strict_include_keywords`.

Measured on 2026-11-08: **163 live rows** across simplify, speedyapply-ai and
zshah-2027 are rejected `no-role-keyword` today and would pass with padding.
Examples: "AI Intern", "AI Agent Builder Intern", "Solutions Architecture
Intern - AI". Some are non-SWE ("AI Analyst Intern"), and those will now
reach the term/rules/LLM steps. Expect more top-company LLM calls per run
while the backlog clears.
Previously rejected jobs: nothing happens to them unless Fix 1 lands.
Also consider adding `autonomy` to `include_keywords`/`strict_include_keywords`
("Onboard Autonomy Intern").

### Fix 3: config, not code

- `data analytics`: decide whether analytics internships are wanted. 2 of the
  49 (Veeam, Entergy) were rejected for lacking it.
- `exclude_keywords: supply chain` blocks "Supply Chain AI Co-op". If wanted,
  replace the bare exclude with a narrower one.

### Fix 4: canonical identity for Oracle CX and SmartRecruiters aliases (B/C)

- Oracle CX: `.../hcmUI/CandidateExperience/<lang>/sites/<site>/job/<id>` on
  `*.fa.*.oraclecloud.com`, and the same `/sites/<site>/job/<id>` path on an
  employer domain (`careers.americanexpress.com`), are one posting.
  `canonical_url` should emit `ats:oraclecx:<tenant>:<id>`, with a small
  `custom host → tenant` alias map (seeded from the zshah101
  `data/companies.json`, which maps 5,354 companies to an ATS/slug/host).
  Without this, a front-site manual add or a second list with the vanity URL
  is a new key.
- SmartRecruiters: `jobs.smartrecruiters.com/<Company>/<id>[-slug]` →
  `ats:sr:<company>:<id>`.
- Radancy/TalentBrew fronts (`careers.blackrock.com`, `careers.l3harris.com`)
  link to the backing Workday req (`..._R266473/apply`). An alias resolver for
  manual adds can follow that one link.

Workstream B (Oracle CX / SmartRecruiters listing adapters) should own the
canonical form, so its new keys and these aliases agree from day one.

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
CX / SmartRecruiters. In a dry run against the instance's state, the new
sources added +689 new jobs, +57 priority alerts and +198 digest matches
(deterministic pass only; no LLM key locally). Of the misses above, they
would have caught TI (latency). They also re-surface 12 previously rejected
priority postings under a new URL key, which are then evaluated under today's
config (see the PR body). They do not fix b-grad, b-role or b-term. Those
need Fixes 1-3.

### What other workstreams already cover

| fix | workstream |
|---|---|
| Workday breadth (GM, Intel, T-Mobile, Danaher, BlackRock tenants) | A. Note that every Workday miss here was ingested, so A adds latency and coverage but would not have changed these outcomes. |
| Oracle CX / SmartRecruiters / Avature / Eightfold / Phenom listing adapters; canonical forms (Fix 4) | B |
| JD fetch for Oracle/Avature/Phenom/Eightfold (needed for JD-based term and grad-only) | C |
| `term-unresolved` and wrong-source-term (Cisco, OpenGov, TensorWave, Armadin, Root) | E |
| closed-posting probe (would mark Shopify/L3Harris/Tenet3 closed) | F |
| manual add → existing match / suggested ats-boards row (Tenet3), gap report (Fix 5) | G |
| re-evaluation on config change (Fix 1), keyword padding (Fix 2) | **none yet** |
