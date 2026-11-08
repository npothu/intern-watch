// One-off maintenance: move every row owned by one tracker user key to another.
//
// Every per-user table carries a plain `user: v.string()` owner key, so a user
// rename is a rewrite of that field and nothing else. SHORTs are a hash of the
// job key (not the user), and stored credentials are encrypted with the
// deployment-wide CREDENTIALS_KEY (not the user), so both survive unchanged.
//
// Run with the Convex CLI against the target deployment, e.g.
//   npx convex run --prod migrations:renameUser '{"from":"example","to":"nathan","dryRun":true}'
//   npx convex run --prod migrations:renameUser '{"from":"example","to":"nathan","dryRun":false}'
// The dry run reports per-table counts for both keys and changes nothing. The
// real run refuses to start if the target key already owns any row, rewrites
// in small batches, and is safe to re-run (it only touches rows still on
// `from`), so a second pass after the cutover picks up stragglers written by a
// cron that was mid-flight.

import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";

// [table, index]. The index must have `user` as its first field; null means
// the table has no such index and is small enough to scan (oauthNonces holds
// short-lived OAuth state only).
export const USER_TABLES = [
  ["profileUploads", "by_user"],
  ["ticks", "by_user"],
  ["applications", "by_user"],
  ["matches", "by_user"],
  ["mailAccounts", "by_user"],
  ["mailMessages", "by_user"],
  ["inboxActions", "by_user_state"],
  ["resumes", "by_user"],
  ["profiles", "by_user"],
  ["profileBackups", "by_user"],
  ["profileImports", "by_user"],
  ["credentials", "by_user"],
  ["oauthNonces", null],
  ["settings", "by_user"],
  ["resumeBuilds", "by_user"],
  ["manualIngests", "by_user"],
] as const;

type UserTable = (typeof USER_TABLES)[number][0];
const TABLE_NAMES = USER_TABLES.map(([t]) => t) as readonly string[];
const USER_KEY = /^[a-zA-Z0-9_-]{1,100}$/; // same rule as web/lib/access-config.ts

function indexFor(table: string): string | null {
  const hit = USER_TABLES.find(([t]) => t === table);
  if (!hit) throw new Error(`not a per-user table: ${table}`);
  return hit[1];
}

// Untyped handle: the table name is dynamic, and every table here is known to
// have a string `user` field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowsFor(db: any, table: string, user: string) {
  const index = indexFor(table);
  const q = db.query(table);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return index ? q.withIndex(index, (ix: any) => ix.eq("user", user))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    : q.filter((f: any) => f.eq(f.field("user"), user));
}

export const countUserPage = internalQuery({
  args: { table: v.string(), user: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { table, user, cursor }) => {
    const page = await rowsFor(ctx.db, table, user).paginate({ cursor, numItems: 500 });
    return { n: page.page.length as number, cursor: page.continueCursor as string, isDone: page.isDone as boolean };
  },
});

export const renameUserBatch = internalMutation({
  args: { table: v.string(), from: v.string(), to: v.string(), limit: v.number() },
  handler: async (ctx, { table, from, to, limit }) => {
    // Always re-read the first `limit` rows still on `from`: patched rows leave
    // the index range, so no cursor is needed and nothing can be skipped.
    const rows = await rowsFor(ctx.db, table, from).take(limit);
    for (const row of rows) await ctx.db.patch(row._id, { user: to });
    return rows.length as number;
  },
});

async function countAll(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any, user: string,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of TABLE_NAMES) {
    let n = 0;
    let cursor: string | null = null;
    for (;;) {
      const page: { n: number; cursor: string; isDone: boolean } =
        await ctx.runQuery(internal.migrations.countUserPage, { table, user, cursor });
      n += page.n;
      if (page.isDone) break;
      cursor = page.cursor;
    }
    out[table] = n;
  }
  return out;
}

const total = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);

export const renameUser = internalAction({
  args: {
    from: v.string(),
    to: v.string(),
    dryRun: v.boolean(),
    // Only for a deliberate re-run after a partial cutover: allows rows to
    // exist under `to` already. Uniqueness on (user, short) is then the
    // operator's responsibility, so the report lists any collisions first.
    allowExistingTarget: v.optional(v.boolean()),
    batch: v.optional(v.number()),
  },
  handler: async (ctx, { from, to, dryRun, allowExistingTarget, batch }) => {
    if (!USER_KEY.test(from) || !USER_KEY.test(to)) throw new Error("user keys must match [a-zA-Z0-9_-]{1,100}");
    if (from === to) throw new Error("from and to are the same key");
    const before = { [from]: await countAll(ctx, from), [to]: await countAll(ctx, to) };
    if (dryRun) return { dryRun: true, before };
    if (total(before[to]) > 0 && !allowExistingTarget) {
      throw new Error(
        `refusing: '${to}' already owns ${total(before[to])} rows ` +
        `(${JSON.stringify(before[to])}); pass allowExistingTarget only for a deliberate re-run`,
      );
    }
    const limit = Math.max(1, Math.min(batch ?? 200, 500));
    const moved: Record<string, number> = {};
    for (const table of TABLE_NAMES as readonly UserTable[]) {
      moved[table] = 0;
      for (;;) {
        const n: number = await ctx.runMutation(internal.migrations.renameUserBatch, { table, from, to, limit });
        moved[table] += n;
        if (n < limit) break;
      }
    }
    const after = { [from]: await countAll(ctx, from), [to]: await countAll(ctx, to) };
    return { dryRun: false, before, moved, after, remainingOnFrom: total(after[from]) };
  },
});
