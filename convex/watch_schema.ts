import { v, type Infer } from "convex/values";
import type { WatchPrefs } from "./watch_types";

// The Convex validator for the Settings > Preferences object. The TYPE lives in
// watch_types.ts (no imports, so the web build can type-check it without
// `convex` installed); this file must describe exactly the same shape, and
// the two assignments at the bottom make tsc fail when they drift.

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

// Compile-time equality between the validator's inferred type and the
// hand-written WatchPrefs, in both directions.
type Validated = Infer<typeof watchValidator>;
const _validatedIsPrefs: WatchPrefs = null as unknown as Validated;
const _prefsIsValidated: Validated = null as unknown as WatchPrefs;
void _validatedIsPrefs;
void _prefsIsValidated;

export { normalizeWatch, PRESETS, type Preset, type WatchPrefs } from "./watch_types";
