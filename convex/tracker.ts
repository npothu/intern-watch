import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { applyStatus, removeIfUnprogressed } from "./ledger";

// Query/mutation functions backing the ConvexStore TrackerStore driver
// (src/store.py). Every endpoint - reads and writes - checks the secret
// passed by the driver against TRACKER_SECRET, so only someone holding the
// secret can read or mutate state. Reads are gated too: the queries return
// per-user tracker data (ticks, ledger, matches) that must not be exposed to
// anyone who merely learns the deployment URL. The driver's Python side
// returns {"status":"error"} and surfaces `errorMessage` when these throw, so
// callers degrade exactly as they do on other API errors.

// The TRACKER_SECRET env var set in the Convex dashboard.
function checkSecret(secret: string) {
  if (secret !== process.env.TRACKER_SECRET) {
    throw new Error("bad secret");
  }
}

const TICK_FIELDS = ["applied", "saved", "dismissed"] as const;

// -- ticks --------------------------------------------------------------

export const getTicks = query({
  args: { user: v.string(), secret: v.string() },
  handler: async (ctx, { user, secret }) => {
    checkSecret(secret);
    const rows = await ctx.db
      .query("ticks")
      .withIndex("by_user", (q) => q.eq("user", user))
      .collect();
    return rows.map((r) => ({
      short: r.short,
      applied: r.applied,
      saved: r.saved,
      dismissed: r.dismissed,
    }));
  },
});

export const setTicks = mutation({
  args: {
    user: v.string(),
    writes: v.array(
      v.object({
        short: v.string(),
        field: v.string(),
        value: v.boolean(),
      }),
    ),
    secret: v.string(),
  },
  handler: async (ctx, { user, writes, secret }) => {
    checkSecret(secret);
    for (const w of writes) {
      if (!(TICK_FIELDS as readonly string[]).includes(w.field)) {
        throw new Error("bad field");
      }
      const existing = await ctx.db
        .query("ticks")
        .withIndex("by_user_short", (q) =>
          q.eq("user", user).eq("short", w.short),
        )
        .first();
      // Ticking applied is what creates the application. Until this existed
      // the ledger was only ever written by the watcher, which mirrors
      // item["applied"] out of its own run state: a tick made in the web UI
      // did not reach the tracker until the next cron (up to 2h), and a
      // manually ingested job - which lives only in this table and never in
      // that run state - could never reach it at all. Writing here makes both
      // immediate. applyStatus backfills the display snapshot from `matches`,
      // so manual rows render properly too.
      if (w.field === "applied") {
        if (w.value) {
          await applyStatus(ctx.db, { user, short: w.short, status: "applied" });
        } else {
          await removeIfUnprogressed(ctx.db, { user, short: w.short });
        }
      }
      if (existing) {
        await ctx.db.patch(existing._id, {
          [w.field]: w.value,
          updatedAt: Date.now(),
        });
      } else {
        // A fresh row starts all-false then sets the toggled field, so a
        // short that only ever had one flag ticked still exists as a row
        // (row presence is what the driver reads back as "*_present").
        await ctx.db.insert("ticks", {
          user,
          short: w.short,
          applied: false,
          saved: false,
          dismissed: false,
          [w.field]: w.value,
          updatedAt: Date.now(),
        });
      }
    }
  },
});

// -- applications ledger ---------------------------------------------------

export const getLedger = query({
  args: { user: v.string(), secret: v.string() },
  handler: async (ctx, { user, secret }) => {
    checkSecret(secret);
    const rows = await ctx.db
      .query("applications")
      .withIndex("by_user", (q) => q.eq("user", user))
      .collect();
    return rows.map((r) => ({
      short: r.short,
      status: r.status,
      note: r.note,
      history: r.history,
      snapshot: r.snapshot,
      createdAt: r.createdAt,
    }));
  },
});

export const recordStatus = mutation({
  args: {
    user: v.string(),
    short: v.string(),
    status: v.string(),
    note: v.optional(v.string()),
    snapshot: v.optional(v.any()),
    secret: v.string(),
  },
  handler: async (ctx, { user, short, status, note, snapshot, secret }) => {
    checkSecret(secret);
    // Shared ledger write (convex/ledger.ts): same-status dedupe, history
    // append, create-if-missing, and snapshot backfill from the matches table
    // when no snapshot is available - mail-sync writes go through the same
    // helper so the two paths can't drift.
    await applyStatus(ctx.db, { user, short, status, note, snapshot });
  },
});

// -- match snapshot --------------------------------------------------------

export const pushMatches = mutation({
  args: {
    user: v.string(),
    items: v.array(v.any()),
    secret: v.string(),
  },
  handler: async (ctx, { user, items, secret }) => {
    checkSecret(secret);
    // Pure upsert: the driver chunks a large snapshot across several calls,
    // so a prune here would delete every earlier chunk's rows. See
    // pruneMatches, called once after the chunks with the whole kept set.
    for (const item of items) {
      const short = item.short;
      const existing = await ctx.db
        .query("matches")
        .withIndex("by_user_short", (q) =>
          q.eq("user", user).eq("short", short),
        )
        .first();
      const row = { user, short, item, pushedAt: Date.now() };
      if (existing) {
        await ctx.db.patch(existing._id, row);
      } else {
        await ctx.db.insert("matches", row);
      }
    }
  },
});

export const pruneMatches = mutation({
  args: {
    user: v.string(),
    keep: v.array(v.string()),
    secret: v.string(),
  },
  handler: async (ctx, { user, keep, secret }) => {
    checkSecret(secret);
    // Full-snapshot semantics, over the WHOLE pushed set in one call: rows
    // whose short is no longer in `keep` are deleted, so the matches table
    // mirrors the state list exactly.
    const kept = new Set(keep);
    const rows = await ctx.db
      .query("matches")
      .withIndex("by_user", (q) => q.eq("user", user))
      .collect();
    for (const row of rows) {
      // Manually ingested rows are outside the watcher's snapshot: they live
      // only in this table, never in the run state that builds `keep`. Pruning
      // them would delete every hand-added job on the next watcher run (the
      // cron is every 2h), so the snapshot only governs the rows it owns.
      if (row.item?.source === "manual") continue;
      if (!kept.has(row.short)) {
        await ctx.db.delete(row._id);
      }
    }
  },
});

/**
 * Remove a single match, permanently for hand-added jobs.
 *
 * Distinct from hiding, which only sets the `dismissed` tick and leaves the row
 * in place under the Hidden filter. Until this existed the only thing that ever
 * deleted a match was the watcher's snapshot prune, so a manually added job -
 * which that prune deliberately skips - could never be removed at all.
 *
 * The ingest records for the job go with it, otherwise the next attempt to add
 * the same URL is refused by a record whose match no longer exists.
 *
 * Deliberately untouched:
 *  - the applications ledger, which is the permanent record of an application
 *    and is never pruned;
 *  - the ticks row, so re-adding the same job restores its applied/saved state
 *    rather than silently losing it.
 *
 * `willReturn` reports that this row came from the watcher rather than a manual
 * add, so deleting it only lasts until the next watcher run re-pushes it. The
 * caller decides what to do about that; hiding is usually what was wanted.
 */
export const deleteMatch = mutation({
  args: { user: v.string(), short: v.string(), secret: v.string() },
  handler: async (ctx, { user, short, secret }) => {
    checkSecret(secret);
    const row = await ctx.db
      .query("matches")
      .withIndex("by_user_short", (q) => q.eq("user", user).eq("short", short))
      .first();
    if (!row) return { deleted: false, willReturn: false, ingestsRemoved: 0 };

    const isManual = row.item?.source === "manual";
    await ctx.db.delete(row._id);

    const ingests = await ctx.db
      .query("manualIngests")
      .withIndex("by_user_short", (q) => q.eq("user", user).eq("short", short))
      .collect();
    for (const ing of ingests) {
      await ctx.db.delete(ing._id);
    }

    return {
      deleted: true,
      willReturn: !isManual,
      ingestsRemoved: ingests.length,
    };
  },
});

export const getMatches = query({
  args: { user: v.string(), secret: v.string() },
  handler: async (ctx, { user, secret }) => {
    checkSecret(secret);
    const rows = await ctx.db
      .query("matches")
      .withIndex("by_user", (q) => q.eq("user", user))
      .collect();
    // Item payloads in by_user index order; patched rows keep their
    // position, so this is index order, not insertion order.
    return rows.map((r) => r.item);
  },
});

// -- resume storage (built .docx artifacts) --------------------------------

// Hands out a Convex file-storage upload URL. The driver POSTs the raw .docx
// bytes to it (Content-Type the DOCX mime), reads the { storageId } from the
// response, then calls attachResume. Gated by the secret like every endpoint:
// anyone without TRACKER_SECRET can't mint storage space here.
export const generateResumeUploadUrl = mutation({
  args: { user: v.string(), short: v.string(), secret: v.string() },
  handler: async (ctx, { secret }) => {
    checkSecret(secret);
    return await ctx.storage.generateUploadUrl();
  },
});

// Records a built resume's storage id on its (user, short) row, replacing any
// earlier build: the old storage object is deleted so a rebuild never leaks
// an orphaned file, and the row stays a single tuple per (user, short).
export const attachResume = mutation({
  args: {
    user: v.string(),
    short: v.string(),
    filename: v.string(),
    storageId: v.id("_storage"),
    secret: v.string(),
  },
  handler: async (ctx, { user, short, filename, storageId, secret }) => {
    checkSecret(secret);
    const existing = await ctx.db
      .query("resumes")
      .withIndex("by_user_short", (q) =>
        q.eq("user", user).eq("short", short),
      )
      .first();
    if (existing) {
      await ctx.storage.delete(existing.storageId);
      await ctx.db.patch(existing._id, {
        filename,
        storageId,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("resumes", {
        user,
        short,
        filename,
        storageId,
        updatedAt: Date.now(),
      });
    }
  },
});

// Serving URLs for a user's built resumes, one query over the by_user index
// (never one HTTP round-trip per row). Only rows whose storage URL resolves
// are returned. Reads are gated too - the URLs expose resumes the caller
// must be authorized to see.
export const getResumeUrls = query({
  args: { user: v.string(), secret: v.string() },
  handler: async (ctx, { user, secret }) => {
    checkSecret(secret);
    const rows = await ctx.db
      .query("resumes")
      .withIndex("by_user", (q) => q.eq("user", user))
      .collect();
    const out: { short: string; url: string; filename: string }[] = [];
    for (const row of rows) {
      const url = await ctx.storage.getUrl(row.storageId);
      if (url) {
        out.push({ short: row.short, url, filename: row.filename });
      }
    }
    return out;
  },
});
