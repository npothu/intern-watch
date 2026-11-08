import type { Doc } from "./_generated/dataModel";

// Hand corrections to a match (PATCH /matches/<short>, tracker.ts patchMatch)
// live in the row's `overrides` column, beside `item`, because pushMatches
// replaces `item` wholesale on every watcher run. Every reader that shows or
// snapshots a match goes through effectiveItem so a correction is seen
// everywhere.
//
// Adding a correctable field (e.g. `url`) is four edits, all marked
// "Extension point":
//   1. schema.ts `overrides` - the stored slot;
//   2. effectiveItem below - the overlay;
//   3. tracker.ts MATCH_PATCH_FIELDS + patchMatch - validation and write;
//   4. web/lib/api/schemas.ts matchPatch - the HTTP body.

/** termConfidence of a hand-corrected term (beside explicit / inferred / unknown). */
export const MANUAL_TERM_CONFIDENCE = "manual";

/** A row's item with its hand corrections applied. Extension point. */
export function effectiveItem(row: Pick<Doc<"matches">, "item" | "overrides">) {
  const term = row.overrides?.term;
  return term ? { ...row.item, term, termConfidence: MANUAL_TERM_CONFIDENCE } : row.item;
}
