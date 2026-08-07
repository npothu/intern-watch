import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Convex backend for the optional STORE=convex TrackerStore driver.
//
// Four tables mirror the "human state" the seam stores:
//  - ticks: one row per (user, short) toggle. A row's presence is what makes
//    an untick meaningful (no dashboard-window truncation in a DB), so every
//    short that ever carried a toggle keeps a row even after it's unticked.
//  - applications: the permanent ledger record per (user, short), with a
//    status + history mirroring src/ledger.py. `snapshot` carries the display
//    fields (company, title, url, ...) so getLedger can rebuild the webui's
//    record shape without re-reading the matches table.
//  - matches: the full-snapshot match list; pushMatches upserts by short and
//    deletes rows absent from the pushed set.
//  - resumes: a built and tailored .docx per (user, short), stored in Convex
//    file storage. `storageId` is the system file id; attachResume replaces
//    an existing row on rebuild (deleting the old storage object) so the
//    table never leaks orphaned files. Nothing is ever committed to the repo
//    on a convex instance - getResumeUrls serves storage links instead.
//
// These four seam tables all share (user, short) as the identity key and
// index the same two ways: by_user for full lists, by_user_short for point
// lookups/upserts. The mail-sync feature's tables (mailAccounts,
// mailMessages, inboxActions) follow below in their own section.
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

// -- Gmail mail-sync ------------------------------------------------------
  //
  // Three tables backing the mail-sync feature (see convex/mail.ts). The
  // drive is push-based: Gmail sends a Pub/Sub notification, the /gmail/push
  // HTTP action stamps lastPushAt, and an internal sync action reads new
  // mail and classifies it. All three are keyed by user like the tracker
  // tables above.
  //  - mailAccounts: one row per (user, gmail account). Holds the OAuth
  //    refresh token plus the last-known watch/history cursor and a rolling
  //    error field so the dashboard can show "last push OK / last sync
  //    failed" health at a glance.
  //  - mailMessages: the processed-message dedup barrier. Recording a
  //    gmailMessageId here is what makes the sync idempotent - a message
  //    already processed (or an ignored one) is never classified twice.
  //    outcome is "auto" | "action" | "ignored".
  //  - inboxActions: recruiter-email candidates surfaced for human
  //    resolution. A `pending` row is exposed by getActions; resolveAction
  //    flips it to resolved (with an optional application status) or
  //    dismissed. candidates is the ranked short/company/title list the
  //    classifier produced, so the human sees the evidence behind it.
  mailAccounts: defineTable({
    user: v.string(),
    email: v.string(),
    refreshToken: v.string(),
    accessToken: v.optional(v.string()),
    accessTokenExpiry: v.optional(v.number()),
    historyId: v.optional(v.string()),
    watchExpiration: v.optional(v.number()),
    lastPushAt: v.optional(v.number()),
    lastSyncAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    lastErrorAt: v.optional(v.number()),
    llmCallsToday: v.optional(v.number()),
    llmCapDate: v.optional(v.string()),
  })
    .index("by_user", ["user"])
    .index("by_email", ["email"]),

  mailMessages: defineTable({
    user: v.string(),
    gmailMessageId: v.string(),
    threadId: v.string(),
    processedAt: v.number(),
    outcome: v.string(),
    signal: v.optional(v.string()),
    short: v.optional(v.string()),
  })
    .index("by_user_message", ["user", "gmailMessageId"])
    .index("by_user", ["user"]),

  inboxActions: defineTable({
    user: v.string(),
    gmailMessageId: v.string(),
    threadId: v.string(),
    accountEmail: v.string(),
    from: v.string(),
    subject: v.string(),
    receivedAt: v.string(),
    signal: v.string(),
    evidence: v.string(),
    source: v.string(),
    candidates: v.array(
      v.object({
        short: v.string(),
        company: v.string(),
        title: v.string(),
        score: v.number(),
      }),
    ),
    state: v.string(),
    resolution: v.optional(
      v.object({
        short: v.optional(v.string()),
        status: v.optional(v.string()),
        at: v.string(),
      }),
    ),
    createdAt: v.string(),
  })
    .index("by_user_state", ["user", "state"])
    .index("by_user_message", ["user", "gmailMessageId"]),

  // Built and tailored .docx per (user, short), stored in Convex file
  // storage. `storageId` is the system file id; attachResume replaces an
  // existing row on rebuild (deleting the old storage object) so the table
  // never leaks orphaned files. Nothing is ever committed to the repo on a
  // convex instance - getResumeUrls serves storage links instead.
  resumes: defineTable({
    user: v.string(),
    short: v.string(),
    filename: v.string(),
    storageId: v.id("_storage"),
    updatedAt: v.number(),
  })
    .index("by_user_short", ["user", "short"])
    .index("by_user", ["user"]),

  // One resume profile (bank) JSON per user - the same shape as
  // users/<user>_resume.json - so the Convex-native resume builder can
  // compose a tailored .docx without reading the repo. `data` is the
  // user's bank document (header/education/skills/work/projects/community).
  // putProfile replaces it on upsert (the migration script seeds it).
  profiles: defineTable({
    user: v.string(),
    data: v.any(),
    updatedAt: v.number(),
  })
    .index("by_user", ["user"]),

  // In-flight on-demand resume builds. A row is upserted to "building" when
  // requestBuild schedules runBuild; runBuild deletes it on success or patches
  // it to "failed" (with a truncated error) on failure. The hosted web app
  // polls this via getBuildStatus to show building/failed before the built
  // resume shows up in `resumes`.
  resumeBuilds: defineTable({
    user: v.string(),
    short: v.string(),
    status: v.string(),                 // "building" | "failed"
    error: v.optional(v.string()),
    startedAt: v.number(),
  })
    .index("by_user_short", ["user", "short"])
    .index("by_user", ["user"]),
});
