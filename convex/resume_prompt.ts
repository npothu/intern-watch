// Pure LLM-prompt assembly + response parsing for the Convex-native resume
// builder. This is a faithful TypeScript port of src/resume/tailor.py: the
// system prompt, the instruction template (JD excerpt + payload), the cap
// rule, and the JSON-array parsing all mirror the Python. It imports nothing
// from ./_generated so it is directly unit-testable.
//
// The model/provider call itself lives in convex/resume.ts (runBuild); this
// module is the deterministic, testable surface around it.

const JD_EXCERPT_CHARS = 6000;   // tailor.py JD_EXCERPT_CHARS
const CAP_SLACK = 15;            // tailor.py CAP_SLACK
const CAP_FLOOR = 140;           // tailor.py CAP_FLOOR

const SYSTEM =
  "You are a resume bullet editor. You rewrite existing bullet points to " +
  "surface keywords from a specific job description. You NEVER invent " +
  "experience: no new tools, frameworks, metrics, or accomplishments that " +
  "are not in the original bullet or the project's listed tech stack. " +
  "Respond with ONLY a JSON array -- no prose, no markdown, no code fences.";

const INSTRUCTIONS = `Rewrite the resume bullets below so they emphasize this job description's vocabulary and priorities. Rules:

- Keep every fact, metric, and tool from the original bullet. You may reorder, rephrase, and swap synonyms toward the JD's wording (e.g. say "REST API" if the JD does, where the original already describes one).
- Never add a skill, tool, or claim that is not already in the original bullet or that project's tech list.
- Never displace the lead: when the original opens with an outcome verb and a number, the rewrite keeps that number in the first clause.
- When shortening, cut adjectives and filler first; never drop a number, proper noun, product or domain name, or URL.
- A JD keyword may replace a synonym, never a concrete fact: a frequency, count, or named tool always survives the rewrite.
- Each rewrite must be at most its "max_chars" (hard limit, resume must stay one page). If the original is already on target, return it unchanged.
- Strong action verbs, no first person, no trailing periods... match the original style.

Output: a JSON array, one object per project, exactly:
  {"name": "<copy project name exactly>", "bullets": ["<rewrite 1>", ...]}
with the same number of bullets per project, in the same order.

Job description:
---
{jd}
---

Projects and bullets:
{payload}
`;

/** A project as sent to the LLM: name, tech string, and cap-carrying bullets. */
export type ProjectPayload = {
  name: string;
  tech: string;
  bullets: { text: string; max_chars: number }[];
};

/** tailor.py _cap: rewrites may run CAP_SLACK over the original (floor 140). */
export function capFor(bullet: string): number {
  return Math.max(bullet.length + CAP_SLACK, CAP_FLOOR);
}

/** Build the payload array for a set of selected projects (tailor.py). */
export function buildProjectPayload(
  projects: { name: string; tech: string; bullets: string[] }[],
): ProjectPayload[] {
  return projects.map((p) => ({
    name: p.name,
    tech: p.tech,
    bullets: p.bullets.map((b) => ({ text: b, max_chars: capFor(b) })),
  }));
}

/** The (system, user) prompt pair for a JD excerpt + payload (tailor.py). */
export function assemblePrompt(
  jdText: string,
  payload: ProjectPayload[],
): { system: string; user: string } {
  const user = INSTRUCTIONS.replace("{jd}", jdText.slice(0, JD_EXCERPT_CHARS)).replace(
    "{payload}",
    JSON.stringify(payload, null, 1),
  );
  return { system: SYSTEM, user };
}

/** Strip code fences and extract the JSON array (mirrors _parse_array). */
export function parseRewrites(text: string): unknown[] {
  const cleaned = text.replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end <= start) {
    throw new Error("no JSON array in model response");
  }
  return JSON.parse(cleaned.slice(start, end + 1)) as unknown[];
}

export type RewriteResult = {
  projects: { name: string; bullets: string[]; llmRewritten: boolean }[];
  notes: string[];
};

/**
 * Apply a parsed rewrite array back onto the selected projects, enforcing the
 * same guardrails as tailor.py._apply: matching bullet count, non-empty
 * strings, and the per-bullet cap. Over-length or malformed rewrites fall
 * back to the original bullet. Never throws - returns notes instead.
 */
export function applyRewrites(
  projects: { name: string; bullets: string[] }[],
  rewrites: unknown[],
  // Optional metric hook (resume_renderers/pdf.endsInWidow): a rewrite that
  // introduces a widow line the original didn't have wastes a printed line,
  // so it falls back to the original bullet like an over-length one.
  widowCheck?: (text: string) => boolean,
): RewriteResult {
  const notes: string[] = [];
  const byName = new Map(projects.map((p, i) => [p.name, i]));
  const result = projects.map((p) => ({
    name: p.name,
    bullets: [...p.bullets],
    llmRewritten: false,
  }));
  const seen = new Set<string>();
  for (const item of rewrites) {
    if (typeof item !== "object" || item === null) continue;
    const name = (item as { name?: unknown }).name;
    const bullets = (item as { bullets?: unknown }).bullets;
    if (typeof name !== "string" || !byName.has(name) || seen.has(name)) continue;
    seen.add(name);
    if (
      !Array.isArray(bullets) ||
      bullets.length !== result[byName.get(name)!].bullets.length ||
      !bullets.every((b) => typeof b === "string" && b.trim().length > 0)
    ) {
      notes.push(`llm: bad rewrite shape for '${name}', kept bank text`);
      continue;
    }
    const original = projects[byName.get(name)!].bullets;
    const out = bullets.map((rw, idx) => {
      const orig = original[idx];
      const s = (rw as string).trim();
      if (s.length > capFor(orig)) {
        notes.push(`llm: over-length rewrite in '${name}', kept original bullet`);
        return orig;
      }
      if (widowCheck && s !== orig && widowCheck(s) && !widowCheck(orig)) {
        notes.push(`llm: widow-introducing rewrite in '${name}', kept original bullet`);
        return orig;
      }
      return s;
    });
    const changed = out.some((s, idx) => s !== original[idx]);
    result[byName.get(name)!] = { name, bullets: out, llmRewritten: changed };
  }
  const missing = [...byName.keys()].filter((n) => !seen.has(n));
  if (missing.length > 0) {
    notes.push(`llm: no rewrite returned for: ${missing.sort().join(", ")}`);
  }
  return { projects: result, notes };
}
