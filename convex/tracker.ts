import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { applyStatus } from "./ledger";

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
