import { v, type Infer } from "convex/values";

// The Settings > Watch object: the handful of watcher preferences a person
// changes a few times a year. Stored on the per-user `settings` row and
// overlaid on the user yaml by the Python watcher at the start of every run
// (src/prefs.py, which documents the same shape in snake_case). Every block
// is optional - an absent block leaves the yaml value in force - but a block
// that is present is complete, so the page never has to merge field by field.
//
// Shared by schema.ts (storage) and settings.ts (the setWatch validator).
// The web app imports only the TYPE (web/lib/convex.ts), never this module's
// runtime, because `convex/values` is not in web/package.json.

export const PRESETS = ["top_atl_remote", "priority_only", "anything"] as const;
export type Preset = (typeof PRESETS)[number];

const preset = v.union(
  v.literal("top_atl_remote"),
  v.literal("priority_only"),
  v.literal("anything"),
);

export const watchValidator = v.object({
  terms: v.optional(
    v.object({
      leadWeeks: v.number(),
      horizonMonths: v.number(),
      include: v.array(v.string()),
      exclude: v.array(v.string()),
    }),
  ),
  rules: v.optional(
    v.object({
      Spring: v.optional(preset),
      Summer: v.optional(preset),
      Fall: v.optional(preset),
    }),
  ),
  priority: v.optional(
    v.object({
      companies: v.array(v.string()),
      fromTracker: v.boolean(),
      emailImmediately: v.boolean(),
      subjectNames: v.boolean(),
    }),
  ),
  location: v.optional(v.object({ remoteCounts: v.boolean() })),
  email: v.optional(
    v.object({
      sendAtLocal: v.array(v.number()),
      timezone: v.string(),
      to: v.array(v.string()),
    }),
  ),
});

export type WatchPrefs = Infer<typeof watchValidator>;

/** A term the page may pin: "<Spring|Summer|Fall|Winter> <year>". */
export const TERM_RE = /^(Spring|Summer|Fall|Winter) 20\d\d$/;

/** Bounds the page and the mutation agree on. */
export const LIMITS = {
  leadWeeks: [0, 12],
  horizonMonths: [1, 36],
  companies: 200,
  recipients: 20,
  pinnedTerms: 12,
} as const;

/**
 * Tidy a submitted object into its canonical stored form, or throw with a
 * message the page can show. Companies and recipients are trimmed and
 * de-duplicated case-insensitively (first spelling wins); hours are sorted
 * unique integers; pinned terms must parse.
 */
export function normalizeWatch(input: WatchPrefs): WatchPrefs {
  const out: WatchPrefs = {};
  if (input.terms) {
    const { leadWeeks, horizonMonths } = input.terms;
    if (!Number.isInteger(leadWeeks) || leadWeeks < LIMITS.leadWeeks[0] || leadWeeks > LIMITS.leadWeeks[1]) {
      throw new Error(`lead time must be a whole number of weeks between ${LIMITS.leadWeeks[0]} and ${LIMITS.leadWeeks[1]}`);
    }
    if (!Number.isInteger(horizonMonths) || horizonMonths < LIMITS.horizonMonths[0] || horizonMonths > LIMITS.horizonMonths[1]) {
      throw new Error(`horizon must be a whole number of months between ${LIMITS.horizonMonths[0]} and ${LIMITS.horizonMonths[1]}`);
    }
    const pins = (list: string[], label: string) => {
      const seen: string[] = [];
      for (const raw of list) {
        const t = raw.trim();
        if (!TERM_RE.test(t)) throw new Error(`${label}: "${raw}" is not a term like "Summer 2028"`);
        if (!seen.includes(t)) seen.push(t);
      }
      if (seen.length > LIMITS.pinnedTerms) throw new Error(`${label}: at most ${LIMITS.pinnedTerms} terms`);
      return seen;
    };
    const include = pins(input.terms.include, "include");
    const exclude = pins(input.terms.exclude, "exclude");
    const both = include.filter((t) => exclude.includes(t));
    if (both.length) throw new Error(`${both[0]} cannot be both included and excluded`);
    out.terms = { leadWeeks, horizonMonths, include, exclude };
  }
  if (input.rules) {
    out.rules = {};
    for (const season of ["Spring", "Summer", "Fall"] as const) {
      const p = input.rules[season];
      if (p !== undefined) out.rules[season] = p;
    }
  }
  if (input.priority) {
    out.priority = {
      companies: dedupe(input.priority.companies, LIMITS.companies, "companies"),
      fromTracker: Boolean(input.priority.fromTracker),
      emailImmediately: Boolean(input.priority.emailImmediately),
      subjectNames: Boolean(input.priority.subjectNames),
    };
  }
  if (input.location) {
    out.location = { remoteCounts: Boolean(input.location.remoteCounts) };
  }
  if (input.email) {
    const hours = [...new Set(input.email.sendAtLocal)].sort((a, b) => a - b);
    if (!hours.length) throw new Error("pick at least one digest time");
    for (const h of hours) {
      if (!Number.isInteger(h) || h < 0 || h > 23) throw new Error(`digest hour ${h} is not between 0 and 23`);
    }
    const timezone = input.email.timezone.trim();
    if (!timezone) throw new Error("timezone is required");
    const to = dedupe(input.email.to, LIMITS.recipients, "recipients");
    if (!to.length) throw new Error("keep at least one recipient");
    for (const addr of to) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) throw new Error(`"${addr}" is not an email address`);
    }
    out.email = { sendAtLocal: hours, timezone, to };
  }
  return out;
}

function dedupe(list: string[], max: number, label: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const s = raw.trim().replace(/\s+/g, " ");
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  if (out.length > max) throw new Error(`${label}: at most ${max} entries`);
  return out;
}
