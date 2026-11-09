import { assertNotMaintenance } from "./maintenance";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Watcher run history for the Matches header sparkline ("watcher pushes,
// last 24h"). The Python watcher (src/store.py ConvexStore.put_watch_run)
// records one row per run per user; the web app reads `recent`. Display-only:
// nothing here feeds back into filtering or delivery.

export const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

function assertSecret(secret: string) {
  assertNotMaintenance();
  if (secret !== process.env.TRACKER_SECRET) {
    throw new Error("bad secret");
  }
}

/** Record one run, then drop this user's rows older than RETAIN_MS. */
export const record = mutation({
  args: {
    user: v.string(),
    at: v.number(),
    newMatches: v.number(),
    scanned: v.optional(v.number()),
    source: v.optional(v.string()),
    secret: v.string(),
  },
  handler: async (ctx, { user, at, newMatches, scanned, source, secret }) => {
    assertSecret(secret);
    const row: { user: string; at: number; newMatches: number; scanned?: number; source?: string } = {
      user, at, newMatches,
    };
    if (scanned !== undefined) row.scanned = scanned;
    if (source !== undefined) row.source = source;
    await ctx.db.insert("watchRuns", row);
    const cutoff = Date.now() - RETAIN_MS;
    const stale = await ctx.db
      .query("watchRuns")
      .withIndex("by_user_at", (q) => q.eq("user", user).lt("at", cutoff))
      .collect();
    for (const r of stale) await ctx.db.delete(r._id);
  },
});

/** The user's runs since `sinceMs` (default: the last 24h), ascending. */
export const recent = query({
  args: { user: v.string(), sinceMs: v.optional(v.number()), secret: v.string() },
  handler: async (ctx, { user, sinceMs, secret }) => {
    assertSecret(secret);
    const since = sinceMs ?? Date.now() - DEFAULT_WINDOW_MS;
    const rows = await ctx.db
      .query("watchRuns")
      .withIndex("by_user_at", (q) => q.eq("user", user).gte("at", since))
      .order("asc")
      .collect();
    return rows.map((r) => ({ at: r.at, newMatches: r.newMatches }));
  },
});
