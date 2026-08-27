import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { watchValidator } from "./watch_schema";

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
    // Needs-attention fields, both optional so applyStatus (which patches only
    // status/history/note/snapshot) and every Python-driven write leave them
    // untouched. dueAt is the next externally imposed deadline (ISO date);
    // snoozedUntil defers the row's appearance in the follow-up queue only.
    // Deliberately two scalars, not a tasks table: migrate when one
    // application needs several simultaneous deadlines.
    dueAt: v.optional(v.string()),
    snoozedUntil: v.optional(v.string()),
  })
    .index("by_user_short", ["user", "short"])
    .index("by_user", ["user"]),

  matches: defineTable({
    user: v.string(),
    short: v.string(),
    item: v.any(),
    pushedAt: v.number(),
    jobDescription: v.optional(v.string()),
    jobDescriptionUpdatedAt: v.optional(v.number()),
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
    // The Gmail OAuth refresh token: long-lived, silent read access to a
    // person's mailbox, and therefore the most sensitive value in this
    // database. It is AES-256-GCM ciphertext under CREDENTIALS_KEY whenever
    // `refreshTokenIv` is present.
    //
    // The iv is optional ONLY to keep rows written before encryption readable:
    // absent iv means the column still holds legacy plaintext, and the read
    // path re-encrypts it on the next write. Do not write a new plaintext row.
    refreshToken: v.string(),
    refreshTokenIv: v.optional(v.string()),
    // Deprecated and no longer written: caching a live bearer token in
    // plaintext beside the encrypted refresh token defeated the point of
    // encrypting it. Kept optional so rows written by older builds still
    // validate; refreshAccessToken clears them on the next run.
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

  // Built resume artifacts per (user, short), stored in Convex file storage.
  // `storageId` is the primary artifact. New native builds use PDF as primary
  // and keep a DOCX companion; legacy builds may still contain DOCX only.
  resumes: defineTable({
    user: v.string(),
    short: v.string(),
    filename: v.string(),
    storageId: v.id("_storage"),
    artifactFormat: v.optional(v.union(v.literal("pdf"), v.literal("docx"))),
    docxStorageId: v.optional(v.id("_storage")),
    docxFilename: v.optional(v.string()),
    updatedAt: v.number(),
    // Keep-N=2 versioning: a rebuild moves the current build into prev* and
    // deletes the storage object prev* held before, so exactly the last two
    // artifacts exist and nothing orphans (the schema's original no-leak goal).
    prevStorageId: v.optional(v.id("_storage")),
    prevFilename: v.optional(v.string()),
    prevArtifactFormat: v.optional(v.union(v.literal("pdf"), v.literal("docx"))),
    prevDocxStorageId: v.optional(v.id("_storage")),
    prevDocxFilename: v.optional(v.string()),
    prevUpdatedAt: v.optional(v.number()),
    // Build report: what the tailor actually did (JD source and size, project
    // selection scores, before/after bullets, LLM notes, rendered outline).
    // Computed by resume_node.performBuild; rendered by the web app's report
    // dialog. v.any() because it embeds profile-authored strings.
    report: v.optional(v.any()),
    prevReport: v.optional(v.any()),
  })
    .index("by_user_short", ["user", "short"])
    .index("by_user", ["user"]),

  // One resume profile (bank) JSON per user - the same shape as
  // users/<user>_resume.json - so the Convex-native resume builder can
  // compose a tailored .docx without reading the repo. `data` holds the
  // user's bank document (header/education/skills/work/projects/community)
  // serialized as a JSON string, not a raw object: Convex field names must
  // be non-control ASCII, and profile JSON can carry user-authored dict keys
  // (e.g. a project name with an em dash) that fail as object fields.
  // putProfile validates + stores the string; older rows written before this
  // fix may still hold a raw object, and getProfileInternal's reader
  // tolerates both. putProfile replaces the row on upsert (the migration
  // script seeds it).
  profiles: defineTable({
    user: v.string(),
    data: v.any(),
    updatedAt: v.number(),
  })
    .index("by_user", ["user"]),

  // The pre-migration copy of a profile, written once when a v1 document is
  // upgraded to the v2 (versioned, section-list) shape. The v2 migration is
  // deliberately one-shot and lossy-looking - v1's `Record<name, X>` groups
  // become ordered arrays - so the original JSON is parked here rather than
  // thrown away. Also written (fromVersion 2) by applyProfileImport just
  // before a confirmed resume import replaces the stored profile, so an
  // import that destroyed hand-written work is recoverable even after the
  // Undo toast is gone. Nothing reads this in normal operation; it exists so
  // a bad migration or import is recoverable by hand instead of unrecoverable.
  profileBackups: defineTable({
    user: v.string(),
    fromVersion: v.number(),           // 1 = v1 migration, 2 = pre-import snapshot
    data: v.string(),                  // the raw JSON string as it was stored
    createdAt: v.number(),
  })
    .index("by_user", ["user"]),

  // One in-flight (or just-finished) resume import per user. A row is created
  // when the browser's direct-to-storage upload is claimed, and it is the ONLY
  // place the import pipeline ever reads a storage id from: the id a client
  // reports at claim time is recorded under the signed-in user, and the
  // mapping action and every deletion work from this record, never from a
  // client argument. `status` is "mapping" | "ready" | "failed"; `preview`
  // holds the validated import serialized as a JSON string (profile JSON can
  // carry user-authored keys - same non-ASCII field-name constraint as
  // profiles.data). `storageId` is cleared once the temporary blob is deleted,
  // so the opportunistic sweep can tell "blob still pending" from "already
  // cleaned up".
  profileImports: defineTable({
    user: v.string(),
    storageId: v.optional(v.id("_storage")),
    filename: v.string(),
    contentType: v.string(),
    status: v.string(),
    preview: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_user", ["user"]),

  // Per-user third-party credentials for the Connections page.
  //
  // The secret itself is AES-256-GCM ciphertext and is NEVER returned to a
  // client - queries return only the non-secret display fields (hint, label,
  // status) so a card can render "AIza…7f2c / Connected" without the value
  // leaving the backend. Decryption happens in actions that are about to make
  // the outbound call.
  //
  // `provider` is one of: "gemini" | "google" | "browserbase" | "jobright"
  // | "smtp". One row per (user, provider).
  credentials: defineTable({
    user: v.string(),
    provider: v.string(),
    ciphertext: v.string(),            // base64, AES-256-GCM over JSON fields
    iv: v.string(),                    // base64, 12 bytes, fresh per write
    // Non-secret, safe to show:
    hint: v.optional(v.string()),      // masked tail, e.g. "AIza…7f2c"
    label: v.optional(v.string()),     // account email, project id, ...
    status: v.string(),                // "ok" | "error" | "untested"
    lastCheckedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_user", ["user"])
    .index("by_user_provider", ["user", "provider"]),

  // In-flight Google OAuth handshakes, one row per started flow.
  //
  // The signed state alone is NOT enough. A signature proves a state was issued
  // by us; it does not prove it has not already been used, and the value is
  // visible in browser history, in the redirect's Location header, and in any
  // TLS-inspecting proxy. Without this table a captured state stays usable for
  // its whole lifetime, and an attacker who replays it with a code from THEIR
  // OWN Google consent silently repoints the victim's mailbox at a mailbox the
  // attacker controls. The row is deleted the moment it is consumed, so a
  // replay finds nothing and is refused.
  oauthNonces: defineTable({
    nonce: v.string(),
    user: v.string(),
    expiresAt: v.number(),
  }).index("by_nonce", ["nonce"]),

  // Per-user, non-secret preferences. One row per user.
  //
  // The resume LLM lives here rather than on the `credentials` row because the
  // choice and the key are independent: a user can pick a model without having
  // a key (the shared key runs it), and the absence of a row is meaningful -
  // it means "whatever the operator provides", which is the default everyone
  // gets without visiting Settings at all.
  //
  // llmDay/llmCount are the per-user daily allowance for the OPERATOR's key,
  // mirroring the LLM_DAILY_CAP counter on mailAccounts. A user running their
  // own key is never counted here - it is their quota to spend.
  //
  // `watch` is the Settings > Preferences object (convex/watch_schema.ts): the
  // watcher preferences a person edits in the app. The Python watcher
  // overlays it on the user yaml every run and writes `watchReport`, the
  // resolved configuration it actually used (snake_case, Python-owned shape,
  // hence v.any()), so the page can show terms with their window dates and
  // the tracker-derived priority companies.
  settings: defineTable({
    user: v.string(),
    resumeProvider: v.optional(v.string()),
    resumeModel: v.optional(v.string()),
    llmDay: v.optional(v.string()),    // "YYYY-MM-DD" (UTC)
    llmCount: v.optional(v.number()),  // operator-key builds used that day
    watch: v.optional(watchValidator),
    watchUpdatedAt: v.optional(v.number()),
    watchReport: v.optional(v.any()),
    updatedAt: v.number(),
  }).index("by_user", ["user"]),

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

  // Manual job URL ingest: one row per user-submitted URL. The row tracks
  // fetch -> extract -> match upsert, or a terminal failure / already_exists.
  // `canonicalUrl` is the normalized URL used for dedup; `dedupKey` is the
  // stable key (jr:<id> or manual:<sha1(canonical)>) whose sha1 prefix is
  // `short`. `status` is one of "fetching" | "extracting" | "done" | "failed"
  // | "already_exists".
  manualIngests: defineTable({
    user: v.string(),
    short: v.string(),
    url: v.string(),
    canonicalUrl: v.optional(v.string()),
    status: v.string(),
    error: v.optional(v.string()),
    dedupKey: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["user"])
    .index("by_user_short", ["user", "short"])
    .index("by_user_url", ["user", "canonicalUrl"]),
});
