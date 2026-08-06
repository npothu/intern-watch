import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Convex backend for the optional STORE=convex TrackerStore driver.
//
// Three tables mirror the three kinds of "human state" the seam stores:
//  - ticks: one row per (user, short) toggle. A row's presence is what makes
//    an untick meaningful (no dashboard-window truncation in a DB), so every
//    short that ever carried a toggle keeps a row even after it's unticked.
//  - applications: the permanent ledger record per (user, short), with a
//    status + history mirroring src/ledger.py. `snapshot` carries the display
//    fields (company, title, url, ...) so getLedger can rebuild the webui's
//    record shape without re-reading the matches table.
//  - matches: the full-snapshot match list; pushMatches upserts by short and
//    deletes rows absent from the pushed set.
//
// All three share (user, short) as the identity key and index the same two
// ways: by_user for full lists, by_user_short for point lookups/upserts.
export default defineSchema({
  ticks: defineTable({
    user: v.string(),
    short: v.string(),
    applied: v.boolean(),
    saved: v.boolean(),
    dismissed: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_user_short", ["user", "short"])
    .index("by_user", ["user"]),

  applications: defineTable({
    user: v.string(),
    short: v.string(),
    status: v.string(),
    note: v.optional(v.string()),
    history: v.array(
      v.object({
        status: v.string(),
        note: v.optional(v.string()),
        at: v.string(),
      }),
    ),
    snapshot: v.optional(v.any()),
    createdAt: v.string(),
  })
    .index("by_user_short", ["user", "short"])
    .index("by_user", ["user"]),

  matches: defineTable({
    user: v.string(),
    short: v.string(),
    item: v.any(),
    pushedAt: v.number(),
  })
    .index("by_user_short", ["user", "short"])
    .index("by_user", ["user"]),
});
