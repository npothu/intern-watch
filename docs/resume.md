# Resume builder

Takes a job description and produces a tailored, ATS-friendly, **one-page**
`.docx` resume from a per-user bank of projects and bullet variants.

The pipeline is deterministic end-to-end except one optional LLM step:

```
JD text ──> analyze (keyword lexicon, requirements blocks weighted 2x)
        ──> select  (score projects, order them, pick bullet variants,
                     reorder skills lines, list keyword gaps)
        ──> tailor  (OPTIONAL: LLM rewrites bullets toward JD wording;
                     every failure falls back to bank text)
        ──> fit     (estimate height from Times font metrics; condense
                     variants / drop weakest project until one page)
        ──> render  (.docx via python-docx)
```

Same bank + same JD + `--no-llm` ⇒ byte-identical decisions, every time.

## Run it

```bash
python -m src.resume --jd jd.txt --company Stripe            # LLM rewrite on
python -m src.resume --jd jd.txt --company Stripe --no-llm   # fully deterministic
```

Output goes to `resumes/<First>_<Last>_<Company>.docx` plus a report on
stdout: project order with scores, top JD keywords, **keyword gaps** (skills
the JD wants that the bank can't honestly claim — never fake these), and
every condense/drop decision the fitter made. Exit code is 1 if the result
still doesn't fit one page.

Or run it from GitHub: **Actions → resume → Run workflow**, paste the JD,
download the `.docx` artifact. The report appears in the run summary.

## The bank (`users/<name>_resume.json`)

One file per user, never edited per-job. Projects carry:

- `tags` — JD concepts the project maps to (strongest scoring signal)
- `tech` — stack list; reordered per-JD so matched tools lead
- `bullets` — named variants (`base` required; `condensed`, `extended`,
  `mlFocused`, ... optional). The selector picks the variant whose text
  hits the most JD weight; the fitter switches to the shortest variant
  when the page overflows.

Skill-line entries (`coursework` / `languages` / `tools`) are either plain
strings or `{"name": ..., "keywords": [...]}`; keywords drive per-JD
reordering (e.g. ML JD ⇒ "Machine Learning" leads the coursework line).

## LLM step

Uses the `resume_llm:` block from `users/<name>.yaml`, falling back to the
watcher's `llm:` block if absent (same provider plumbing: `anthropic` or
`gemini`). The two are separate on purpose: the watcher batch-classifies up
to 40 jobs 3×/day on a cheap model (`gemini-flash-lite-latest`), while a
resume build is one call per application and wants a strong writing model —
The example profile's is `gemini-2.5-pro`.

Guardrails are enforced in code, not just in the prompt: a rewrite that
exceeds its per-bullet length cap, changes the bullet count, or names an
unknown project is discarded and the bank text is kept. No API key ⇒ the
build silently runs deterministic-only and says so in the report.

## Why not LLM-everything (what the old `job` repo did)?

The previous generation pipeline asked an LLM to do selection, rewriting,
formatting, and page-count policing. Selection and layout are better
deterministic: testable, free, reproducible — and the two recurring bugs
(dates drifting off the right edge, resumes spilling past one page) were
formatting/fit problems an LLM can't reliably police. Here:

- dates are right-aligned with a single right tab stop at the right text
  edge (`src/resume/spec.py`), immune to heading length
- section rules are paragraph bottom borders, not underlined tab characters
- the fitter (`src/resume/fit.py`) measures text with embedded Times font
  metrics and condenses/drops until the estimate clears 98% of one page,
  before the file is ever written