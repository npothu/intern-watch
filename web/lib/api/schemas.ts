import { z } from "zod";
import { MAX_PROFILE_BYTES } from "../../../shared/resume-compose";
import { LIMITS, PRESETS, TERM_RE, canonicalTerm } from "../../../convex/watch_types";
import { STATUS_ORDER } from "../../components/tracker/tracker-lib";
import { validateUrl } from "../../../convex/ingest_extract";

export const empty = z.strictObject({});
export const short = z.string().regex(/^[0-9a-f]{12}$/, "Use the lowercase 12-hex short key returned by the API.");
export const id = z.string().min(1).max(256);
export const status = z.enum(STATUS_ORDER);
export const variant = z.string().trim().min(1).max(40);
export const provider = z.enum(["gemini", "anthropic", "openai", "openrouter"]);
export const date = z.union([z.iso.date(), z.iso.datetime({ offset: true })]).nullable();
// readBody has already parsed JSON, so nested values need no recursive schema.
export const profile = z.record(z.string(), z.unknown()).refine(
  (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_PROFILE_BYTES,
  "Profile is too large (max 768KB).",
).describe("Resume profile JSON object, at most 768 KiB. See docs/resume.md and convex/profile_schema.ts.");
export const jobUrl = z.string().trim().min(1).max(2048).superRefine((value, ctx) => {
  try { validateUrl(value); } catch (error) {
    // A listing URL is a valid URL of the wrong kind: say so.
    const listing = error instanceof Error && /search or listing page/.test(error.message);
    ctx.addIssue({ code: "custom", message: listing ? error.message : "Provide a public HTTP or HTTPS job URL." });
  }
});
// Caller-supplied posting fields for a job the server cannot read itself
// (bot wall, JS-only page). Limits mirror convex/ingest.ts MANUAL_LIMITS.
export const ingest = z.strictObject({
  url: jobUrl,
  jdText: z.string().trim().min(1).max(20_000).optional()
    .describe("The job description, when the page cannot be fetched. Stored as a pasted JD."),
  title: z.string().trim().min(1).max(300).optional().describe("Job title; required with jdText when the page gives none."),
  company: z.string().trim().min(1).max(200).optional(),
  location: z.string().trim().min(1).max(300).optional(),
});
export const ticks = z.strictObject({
  writes: z.array(z.strictObject({ short, field: z.enum(["applied", "saved", "dismissed"]), value: z.boolean() })).max(500),
});
// PATCH /matches/{short}. Extension point: convex/match_overrides.ts lists
// the edits a new field (e.g. `url`) needs.
export const matchPatch = z.strictObject({
  term: z.string().max(40).nullable().transform((value, ctx) => {
    if (value === null) return null;
    const term = canonicalTerm(value);
    if (!term) {
      ctx.addIssue({ code: "custom", message: 'Use a term like "Summer 2027", or null to clear the correction.' });
      return z.NEVER;
    }
    return term;
  }).optional().describe('A term like "Summer 2027" (Spring, Summer, Fall or Winter plus a year), or null to clear the correction.'),
}).refine((body) => Object.keys(body).length > 0, "Provide at least one field to change.");
export const build = z.strictObject({
  jdText: z.string().trim().min(1).max(20_000).optional(),
  instructions: z.string().max(1000).optional(),
  overrides: z.array(z.strictObject({
    entryId: id.optional(), name: z.string().min(1).max(500),
    bullets: z.array(z.string().max(20_000)).max(100),
  })).max(12).optional(),
  variant: variant.optional(),
  profileSnapshot: profile.optional(),
});
const term = z.string().regex(TERM_RE);
const preset = z.enum(PRESETS);
export const watch = z.strictObject({
  terms: z.strictObject({
    leadWeeks: z.int().min(LIMITS.leadWeeks[0]).max(LIMITS.leadWeeks[1]),
    horizonMonths: z.int().min(LIMITS.horizonMonths[0]).max(LIMITS.horizonMonths[1]),
    include: z.array(term).max(LIMITS.pinnedTerms), exclude: z.array(term).max(LIMITS.pinnedTerms),
  }).optional(),
  rules: z.strictObject({ Spring: preset.optional(), Summer: preset.optional(), Fall: preset.optional() }).optional(),
  priority: z.strictObject({
    companies: z.array(z.string().max(500)).max(LIMITS.companies),
    fromTracker: z.boolean(), emailImmediately: z.boolean(), subjectNames: z.boolean(),
  }).optional(),
  location: z.strictObject({ remoteCounts: z.boolean() }).optional(),
  email: z.strictObject({
    sendAtLocal: z.array(z.int().min(0).max(23)).min(1).max(24),
    timezone: z.string().trim().min(1).max(100).refine((value) => {
      try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
    }, "Use an IANA timezone, such as America/New_York."),
    to: z.array(z.email()).max(LIMITS.recipients),
  }).optional(),
});

export const importFilename = z.string().trim().min(1).max(255).regex(/\.(docx|txt|md|markdown)$/i);
export function importContentType(filename: string): string {
  if (/\.docx$/i.test(filename)) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  return /\.txt$/i.test(filename) ? "text/plain" : "text/markdown";
}
