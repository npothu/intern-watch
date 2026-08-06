import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Query/mutation functions backing the ConvexStore TrackerStore driver
// (src/store.py). Every write endpoint checks the secret passed by the
// driver against TRACKER_SECRET, so only someone holding the secret can
// mutate state. The driver's Python side returns {"status":"error"} and
// surfaces `errorMessage` when these throw, so callers degrade exactly as
// they do on other API errors.

// The TRACKER_SECRET env var set in the Convex dashboard.
function checkSecret(secret: string) {
  if (secret !== process.env.TRACKER_SECRET) {
    throw new Error("bad secret");
  }
}

const TICK_FIELDS = ["applied", "saved", "dismissed"] as const;

// -- ticks --------------------------------------------------------------

export const getTicks = query({
  args: { user: v.string() },
  handler: async (ctx, { user }) => {
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
  args: { user: v.string() },
  handler: async (ctx, { user }) => {
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
    const entry: { status: string; at: string; note?: string } = {
      status,
      at: new Date().toISOString(),
    };
    if (note) {
      entry.note = note;
    }
    const existing = await ctx.db
      .query("applications")
      .withIndex("by_user_short", (q) =>
        q.eq("user", user).eq("short", short),
      )
      .first();
    if (existing) {
      const history = existing.history ?? [];
      const last = history[history.length - 1];
      // Repeating the current status without a change is a no-op rather than
      // history spam (mirrors src/ledger.py set_status).
      if (last && last.status === status && (last.note ?? "") === (note ?? "")) {
        return;
      }
      history.push(entry);
      const patch: Record<string, unknown> = { status, history };
      if (note !== undefined) {
        patch.note = note;
      }
      if (snapshot !== undefined) {
        patch.snapshot = snapshot;
      }
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("applications", {
        user,
        short,
        status,
        note,
        history: [entry],
        snapshot,
        createdAt: new Date().toISOString(),
      });
    }
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
      if (!kept.has(row.short)) {
        await ctx.db.delete(row._id);
      }
    }
  },
});

export const getMatches = query({
  args: { user: v.string() },
  handler: async (ctx, { user }) => {
    const rows = await ctx.db
      .query("matches")
      .withIndex("by_user", (q) => q.eq("user", user))
      .collect();
    // Item payloads in by_user index order; patched rows keep their
    // position, so this is index order, not insertion order.
    return rows.map((r) => r.item);
  },
});
