// Read side of the coverage-gap loop (src/coverage.py): manual adds whose
// fetch FAILED never become matches, so the report would not see them -
// yet a bot-walled Workday/Oracle page is exactly the miss worth counting.
import { query } from "./_generated/server";
import { v } from "convex/values";
import { assertNotMaintenance } from "./maintenance";

export const getFailedIngests = query({
  args: { user: v.string(), secret: v.string() },
  handler: async (ctx, { user, secret }) => {
    assertNotMaintenance();
    if (secret !== process.env.TRACKER_SECRET) throw new Error("bad secret");
    const rows = await ctx.db
      .query("manualIngests")
      .withIndex("by_user", (q) => q.eq("user", user))
      .collect();
    return rows
      .filter((r) => r.status === "failed")
      .map((r) => ({
        url: r.canonicalUrl ?? r.url,
        ats: r.ats,
        atsBoard: r.atsBoard,
        foundVia: r.foundVia,
        added: new Date(r.createdAt).toISOString().slice(0, 10),
      }));
  },
});
