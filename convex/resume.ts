import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

// Convex-native on-demand resume builder.
//
// The hosted web app's "build resume" button previously dispatched a GitHub
// Actions workflow (src.resume.batch) to produce a tailored .docx and commit
// it. This module replaces that backend entirely: the build runs inside a
// Convex action against a resume profile stored in the `profiles` table, and
// the finished .docx lands in Convex file storage via the existing `resumes`
// table (the same one the Python `ConvexStore.put_resume` driver writes).
//
// Flow: requestBuild (fast, returns {ok:true}) upserts a `resumeBuilds` row to
// "building" and schedules resume_node.runBuild (runAfter 0); runBuild fetches
// the match's JD text, asks the configured LLM (Gemini, like the mail-sync
// precedent) to rewrite the selected project bullets, composes the .docx,
// stores its bytes in Convex storage, and attaches it to the resumes row
// (replace-on-upsert). On success the resumeBuilds row is deleted; on failure
// it is patched to "failed" with a truncated error so the web app's
// getBuildStatus can show it.
//
// This file holds the default-runtime (V8 isolate) surface: the public
// mutations/query plus the internal db-touching helpers the build action
// needs. The build action itself (runBuild) lives in resume_node.ts under
// "use node" - a "use node" file may only export actions, and the JD fetch ->
// Gemini -> `docx` npm generation pipeline is kept there so it never risks a
// runtime-only failure against the isolate's missing Node globals (see
// mail.ts's atob/TextDecoder precedent). Actions have no ctx.db, so runBuild
// reaches the database through the internal query/mutations below via
// ctx.runQuery / ctx.runMutation.
//
// Every public endpoint is gated on the same TRACKER_SECRET as tracker.ts -
// this builder is not public and reads/writes per-user data.

// The TRACKER_SECRET env var set in the Convex dashboard.
function checkSecret(secret: string) {
  if (secret !== process.env.TRACKER_SECRET) {
    throw new Error("bad secret");
  }
}

const ERROR_MAX = 200; // truncated error message length for the status row

// ---------------------------------------------------------------------------
// Public mutation: kick off a build. Deliberately thin and synchronous so the
// Vercel server action returns fast; the heavy lifting is offloaded to the
// scheduled runBuild action.
// ---------------------------------------------------------------------------
export const requestBuild = mutation({
  args: {
    user: v.string(),
    short: v.string(),
    secret: v.string(),
    // Rebuild refinements, all optional so the plain "build" click stays a
    // two-field call. jdText: user-pasted JD when acquisition failed (or to
    // override a bad fetch). instructions: free-form guidance forwarded to the
    // tailor LLM ("emphasize the Go work"). overrides: literal bullet text the
    // user edited by hand, applied after the LLM pass per project name.
    // variant: when set, forces that bullet variant for every project instead
    // of the per-project JD auto-pick.
    jdText: v.optional(v.string()),
    instructions: v.optional(v.string()),
    overrides: v.optional(
      v.array(v.object({ name: v.string(), bullets: v.array(v.string()) })),
    ),
    variant: v.optional(v.string()),
  },
  handler: async (ctx, { user, short, secret, jdText, instructions, overrides, variant }) => {
    checkSecret(secret);
    // Validate the preconditions before spending a scheduler slot: the user
    // must have a resume profile AND a matching match row to build from.
    const profile = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("user", user))
      .first();
    if (!profile) {
      return { ok: false as const, error: "No resume profile on file for this user." };
    }
    const match = await ctx.db
      .query("matches")
      .withIndex("by_user_short", (q) =>
        q.eq("user", user).eq("short", short),
      )
      .first();
    if (!match) {
      return { ok: false as const, error: "Match not found." };
    }
    // Upsert the in-flight marker to "building".
    const existing = await ctx.db
      .query("resumeBuilds")
      .withIndex("by_user_short", (q) =>
        q.eq("user", user).eq("short", short),
      )
      .first();
    const row = {
      user,
      short,
      status: "building" as const,
      error: undefined,
      startedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, row);
    } else {
      await ctx.db.insert("resumeBuilds", row);
    }
    await ctx.scheduler.runAfter(0, internal.resume_node.runBuild, {
      user,
      short,
      jdText,
      instructions,
      overrides,
      variant,
    });
    return { ok: true as const };
  },
});

// ---------------------------------------------------------------------------
// Public mutation: delete a built resume for one (user, short). Deletes both
// kept storage artifacts (current + previous) so keep-N=2 orphans nothing,
// then removes the resumes row and any stale resumeBuilds marker, so a
// "building"/"failed" badge cannot outlive its artifact.
// ---------------------------------------------------------------------------
export const deleteResume = mutation({
  args: { user: v.string(), short: v.string(), secret: v.string() },
  handler: async (ctx, { user, short, secret }) => {
    checkSecret(secret);
    const row = await ctx.db
      .query("resumes")
      .withIndex("by_user_short", (q) =>
        q.eq("user", user).eq("short", short),
      )
      .first();
    if (!row) {
      return { ok: false as const, reason: "not_found" };
    }
    // Delete every blob this row points at (the current artifact and the
    // kept previous one) - leaving either behind orphans a file forever.
    if (row.storageId) {
      await ctx.storage.delete(row.storageId);
    }
    if (row.prevStorageId) {
      await ctx.storage.delete(row.prevStorageId);
    }
    await ctx.db.delete(row._id);
    // A leftover in-flight/failed build row would keep a stale badge in the
    // UI for an artifact that no longer exists, so clear it too.
    const build = await ctx.db
      .query("resumeBuilds")
      .withIndex("by_user_short", (q) =>
        q.eq("user", user).eq("short", short),
      )
      .first();
    if (build) {
      await ctx.db.delete(build._id);
    }
    return { ok: true as const };
  },
});

// ---------------------------------------------------------------------------
// The user's stored resume profile (bank) JSON string, for the web
// app's profile editor. Secret-gated like every read - the bank is personal
// data. Legacy rows written as raw objects are serialized on the way out so
// the caller always receives a string.
// ---------------------------------------------------------------------------
export const getProfile = query({
  args: { user: v.string(), secret: v.string() },
  handler: async (ctx, { user, secret }) => {
    checkSecret(secret);
    const row = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("user", user))
      .first();
    if (!row) return { data: null };
    const data =
      typeof row.data === "string" ? row.data : JSON.stringify(row.data);
    return { data, updatedAt: row.updatedAt };
  },
});

// ---------------------------------------------------------------------------
// Public query: current build status for one (user, short).
// Returns "building" | {status:"failed", error} | null (null = not building;
// a successful build deletes the row, so the caller then reads the resume URL).
// ---------------------------------------------------------------------------
export const getBuildStatus = query({
  args: { user: v.string(), short: v.string(), secret: v.string() },
  handler: async (ctx, { user, short, secret }) => {
    checkSecret(secret);
    const row = await ctx.db
      .query("resumeBuilds")
      .withIndex("by_user_short", (q) =>
        q.eq("user", user).eq("short", short),
      )
      .first();
    if (!row) return null;
    if (row.status === "failed") {
      return { status: "failed" as const, error: row.error };
    }
    return "building" as const;
  },
});

// ---------------------------------------------------------------------------
// Public mutation: upsert a user's resume profile (bank) JSON. Used by the
// migration script (scripts/migrate_profiles_to_convex.py) to seed Convex.
//
// `data` is the profile's JSON serialized as a string, not stored as a raw
// object: Convex field names must be non-control ASCII, and profile JSON can
// carry user-authored dict keys (e.g. a project name with an em dash) that
// fail as object field names with an opaque "Server Error". Storing the
// already-serialized string sidesteps the constraint entirely; the reader
// (resume_node.ts's runBuild, via getProfileInternal) parses it back out.
// ---------------------------------------------------------------------------
export const putProfile = mutation({
  args: { user: v.string(), data: v.string(), secret: v.string() },
  handler: async (ctx, { user, data, secret }) => {
    checkSecret(secret);
    try {
      JSON.parse(data);
    } catch {
      throw new Error("profile data must be valid JSON");
    }
    const existing = await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("user", user))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { data, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("profiles", { user, data, updatedAt: Date.now() });
    }
  },
});

// ---------------------------------------------------------------------------
// Internal queries: db reads for the "use node" runBuild action, which has no
// ctx.db of its own (no action does - only query/mutation functions do).
// ---------------------------------------------------------------------------
export const getMatchInternal = internalQuery({
  args: { user: v.string(), short: v.string() },
  handler: async (ctx, { user, short }) => {
    return await ctx.db
      .query("matches")
      .withIndex("by_user_short", (q) => q.eq("user", user).eq("short", short))
      .first();
  },
});

export const getProfileInternal = internalQuery({
  args: { user: v.string() },
  handler: async (ctx, { user }) => {
    return await ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("user", user))
      .first();
  },
});

// ---------------------------------------------------------------------------
// Internal mutation: attach a built resume's storage id to its (user, short)
// row. Keep-N=2, same semantics as the public tracker.attachResume: the
// current build slides into the prev* fields and the object prev* held before
// is deleted, so a rebuild orphans nothing and the last build stays
// restorable. Also stores the build report alongside the artifact it
// describes.
// ---------------------------------------------------------------------------
export const attachResumeInternal = internalMutation({
  args: {
    user: v.string(),
    short: v.string(),
    filename: v.string(),
    storageId: v.id("_storage"),
    report: v.optional(v.any()),
  },
  handler: async (ctx, { user, short, filename, storageId, report }) => {
    const existing = await ctx.db
      .query("resumes")
      .withIndex("by_user_short", (q) =>
        q.eq("user", user).eq("short", short),
      )
      .first();
    if (existing) {
      if (existing.prevStorageId) {
        await ctx.storage.delete(existing.prevStorageId);
      }
      await ctx.db.patch(existing._id, {
        filename,
        storageId,
        updatedAt: Date.now(),
        report,
        prevStorageId: existing.storageId,
        prevFilename: existing.filename,
        prevUpdatedAt: existing.updatedAt,
      });
    } else {
      await ctx.db.insert("resumes", {
        user,
        short,
        filename,
        storageId,
        updatedAt: Date.now(),
        report,
      });
    }
  },
});

// ---------------------------------------------------------------------------
// Internal mutation: patch a resumeBuilds row to "failed" (or insert one if a
// build somehow runs without the marker). Error text is truncated.
// ---------------------------------------------------------------------------
export const markBuildFailed = internalMutation({
  args: { user: v.string(), short: v.string(), error: v.string() },
  handler: async (ctx, { user, short, error }) => {
    const message =
      error.length > ERROR_MAX ? `${error.slice(0, ERROR_MAX - 3)}...` : error;
    const existing = await ctx.db
      .query("resumeBuilds")
      .withIndex("by_user_short", (q) =>
        q.eq("user", user).eq("short", short),
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { status: "failed", error: message });
    } else {
      await ctx.db.insert("resumeBuilds", {
        user,
        short,
        status: "failed",
        error: message,
        startedAt: Date.now(),
      });
    }
  },
});

// ---------------------------------------------------------------------------
// Internal mutation: delete the in-flight marker on a successful build.
// ---------------------------------------------------------------------------
export const clearBuild = internalMutation({
  args: { user: v.string(), short: v.string() },
  handler: async (ctx, { user, short }) => {
    const existing = await ctx.db
      .query("resumeBuilds")
      .withIndex("by_user_short", (q) =>
        q.eq("user", user).eq("short", short),
      )
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});
