// One-off maintenance: move every row owned by one tracker user key to another.
//
// Every per-user table carries a plain `user: v.string()` owner key, so a user
// rename is a rewrite of that field and nothing else. SHORTs are a hash of the
// job key (not the user), and stored credentials are encrypted with the
// deployment-wide CREDENTIALS_KEY (not the user), so both survive unchanged.
// Document ids are preserved (rows are patched, never re-inserted), so
// references such as referrals.contactId stay valid.
//
// Cutover procedure (see docs/user-rename.md):
//   1. npx convex env set TRACKER_MAINTENANCE 1      (blocks every writer)
//   2. renameUser {dryRun:true}                       (counts, collisions, pending jobs)
//   3. renameUser {dryRun:false}
//   4. switch TRACKER_USER_MAP / TRACKER_API_KEYS / data repo, then
//      npx convex env remove TRACKER_MAINTENANCE
//
// The real run refuses unless maintenance is on, no scheduled function is
// pending or running, and no row would collide with one the target already
// owns (same short / Gmail message / provider / mailbox, or a second copy of a
// singleton row). It rewrites in byte-bounded batches; each batch is one
// transaction and re-checks collisions, and the run is safe to repeat.

import { ConvexError, v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { maintenanceOn } from "./maintenance";

// How a row's logical identity is scoped to its user. Two rows with the same
// user and logical key must never coexist, so a move that would create such a
// pair is a collision.
type KeySpec =
  | { kind: "none" }                               // append-only / history rows
  | { kind: "singleton" }                          // at most one row per user
  | { kind: "field"; field: string; index: string }; // index = [user, field]

// [table, user index (user must be its first field), logical key]. Order
// matters for anything a live writer might observe: dedup records
// (mailMessages) move before the mailbox that consults them.
export const USER_TABLES: ReadonlyArray<readonly [string, string, KeySpec]> = [
  ["profileUploads", "by_user", { kind: "none" }],
  ["ticks", "by_user", { kind: "field", field: "short", index: "by_user_short" }],
  ["applications", "by_user", { kind: "field", field: "short", index: "by_user_short" }],
  ["matches", "by_user", { kind: "field", field: "short", index: "by_user_short" }],
  ["mailMessages", "by_user", { kind: "field", field: "gmailMessageId", index: "by_user_message" }],
  ["inboxActions", "by_user_state", { kind: "field", field: "gmailMessageId", index: "by_user_message" }],
  ["mailAccounts", "by_user", { kind: "field", field: "email", index: "by_user" }],
  ["resumes", "by_user", { kind: "field", field: "short", index: "by_user_short" }],
  ["profiles", "by_user", { kind: "singleton" }],
  ["profileBackups", "by_user", { kind: "none" }],
  ["profileImports", "by_user", { kind: "none" }],
  ["credentials", "by_user", { kind: "field", field: "provider", index: "by_user_provider" }],
  ["oauthNonces", "by_user", { kind: "none" }],
  ["settings", "by_user", { kind: "singleton" }],
  ["resumeBuilds", "by_user", { kind: "field", field: "short", index: "by_user_short" }],
  ["manualIngests", "by_user", { kind: "field", field: "short", index: "by_user_short" }],
  ["referralContacts", "by_user", { kind: "none" }],
  ["referrals", "by_user", { kind: "none" }],
  ["referralNotes", "by_user", { kind: "none" }],
] as const;

const TABLE_NAMES = USER_TABLES.map(([t]) => t);
const USER_KEY = /^[a-zA-Z0-9_-]{1,100}$/; // same rule as web/lib/access-config.ts
// Byte budgets kept well under Convex's per-function read/write limits so that
// large `matches.item` documents cannot push a page or batch over.
const COUNT_PAGE_BYTES = 4 * 1024 * 1024;
const MOVE_BATCH_BYTES = 2 * 1024 * 1024;

function spec(table: string) {
  const hit = USER_TABLES.find(([t]) => t === table);
  if (!hit) throw new Error(`not a per-user table: ${table}`);
  return { index: hit[1], key: hit[2] };
}

// Untyped handle: table names are dynamic, and every table here is known to
// have a string `user` field plus the indexes named in USER_TABLES.
/* eslint-disable @typescript-eslint/no-explicit-any */
function rowsFor(db: any, table: string, user: string) {
  return db.query(table).withIndex(spec(table).index, (ix: any) => ix.eq("user", user));
}

async function collisionFor(db: any, table: string, row: any, to: string): Promise<string | null> {
  const { key } = spec(table);
  if (key.kind === "none") return null;
  if (key.kind === "singleton") {
    const existing = await rowsFor(db, table, to).first();
    return existing ? `${table}: '${to}' already has its single row` : null;
  }
  const value = row[key.field];
  if (value === undefined) return null;
  const existing = key.index === "by_user"
    ? await db.query(table).withIndex("by_user", (ix: any) => ix.eq("user", to))
        .filter((f: any) => f.eq(f.field(key.field), value)).first()
    : await db.query(table).withIndex(key.index, (ix: any) => ix.eq("user", to).eq(key.field, value)).first();
  return existing ? `${table}: '${to}' already has ${key.field}=${String(value)}` : null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export const countUserPage = internalQuery({
  args: { table: v.string(), user: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { table, user, cursor }) => {
    const page = await rowsFor(ctx.db, table, user).paginate({
      cursor, numItems: 500, maximumBytesRead: COUNT_PAGE_BYTES,
    });
    return { n: page.page.length as number, cursor: page.continueCursor as string, isDone: page.isDone as boolean };
  },
});

// Dry-run helper: how many of one page of `from` rows would collide with `to`.
export const collisionsPage = internalQuery({
  args: { table: v.string(), from: v.string(), to: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { table, from, to, cursor }) => {
    const page = await rowsFor(ctx.db, table, from).paginate({
      cursor, numItems: 200, maximumBytesRead: MOVE_BATCH_BYTES,
    });
    const hits: string[] = [];
    for (const row of page.page) {
      const c = await collisionFor(ctx.db, table, row, to);
      if (c) hits.push(c);
    }
    return { hits, cursor: page.continueCursor as string, isDone: page.isDone as boolean };
  },
});

// _scheduled_functions keeps finished jobs for days, so page through it.
export const pendingScheduledPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db.system.query("_scheduled_functions").paginate({
      cursor, numItems: 1000, maximumBytesRead: COUNT_PAGE_BYTES,
    });
    const live = page.page
      .filter((j) => j.state.kind === "pending" || j.state.kind === "inProgress")
      .map((j) => ({ name: j.name, state: j.state.kind as string, scheduledTime: j.scheduledTime }));
    return { live, cursor: page.continueCursor, isDone: page.isDone };
  },
});

export const renameUserBatch = internalMutation({
  args: { table: v.string(), from: v.string(), to: v.string(), limit: v.number() },
  handler: async (ctx, { table, from, to, limit }) => {
    if (!maintenanceOn()) throw new ConvexError("TRACKER_MAINTENANCE must be 1 while moving rows");
    // Always read from the start of the `from` range: patched rows leave it,
    // so no cursor is needed and nothing can be skipped.
    const page = await rowsFor(ctx.db, table, from).paginate({
      cursor: null, numItems: limit, maximumBytesRead: MOVE_BATCH_BYTES,
    });
    // Check the whole batch first so a collision aborts before any write.
    for (const row of page.page) {
      const c = await collisionFor(ctx.db, table, row, to);
      if (c) throw new ConvexError(`collision, nothing in this batch moved: ${c}`);
    }
    for (const row of page.page) await ctx.db.patch(row._id, { user: to });
    return { moved: page.page.length as number, isDone: page.isDone as boolean };
  },
});

/* eslint-disable @typescript-eslint/no-explicit-any */
async function countAll(ctx: any, user: string): Promise<Record<string, number>> {
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

async function collisionsAll(ctx: any, from: string, to: string): Promise<string[]> {
  const out: string[] = [];
  for (const table of TABLE_NAMES) {
    let cursor: string | null = null;
    for (;;) {
      const page: { hits: string[]; cursor: string; isDone: boolean } =
        await ctx.runQuery(internal.migrations.collisionsPage, { table, from, to, cursor });
      out.push(...page.hits);
      if (page.isDone) break;
      cursor = page.cursor;
    }
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const total = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);

export const renameUser = internalAction({
  args: {
    from: v.string(),
    to: v.string(),
    dryRun: v.boolean(),
    batch: v.optional(v.number()),
  },
  handler: async (ctx, { from, to, dryRun, batch }) => {
    if (!USER_KEY.test(from) || !USER_KEY.test(to)) throw new ConvexError("user keys must match [a-zA-Z0-9_-]{1,100}");
    if (from === to) throw new ConvexError("from and to are the same key");
    const before = { [from]: await countAll(ctx, from), [to]: await countAll(ctx, to) };
    const collisions = await collisionsAll(ctx, from, to);
    const pending: { name: string; state: string; scheduledTime: number }[] = [];
    for (let cursor: string | null = null; ;) {
      const page: { live: typeof pending; cursor: string; isDone: boolean } =
        await ctx.runQuery(internal.migrations.pendingScheduledPage, { cursor });
      pending.push(...page.live);
      if (page.isDone) break;
      cursor = page.cursor;
    }
    const blockers: string[] = [];
    if (!maintenanceOn()) blockers.push("TRACKER_MAINTENANCE is not 1");
    if (pending.length) blockers.push(`${pending.length} scheduled function(s) pending or running`);
    if (collisions.length) blockers.push(`${collisions.length} collision(s) with rows '${to}' already owns`);
    const report = { before, collisions: collisions.slice(0, 50), pending: pending.slice(0, 50), blockers };
    if (dryRun) return { dryRun: true, ...report };
    if (blockers.length) throw new ConvexError(`refusing: ${blockers.join("; ")}`);

    const limit = Math.max(1, Math.min(batch ?? 200, 500));
    const moved: Record<string, number> = {};
    for (const table of TABLE_NAMES) {
      moved[table] = 0;
      for (;;) {
        const r: { moved: number; isDone: boolean } =
          await ctx.runMutation(internal.migrations.renameUserBatch, { table, from, to, limit });
        moved[table] += r.moved;
        if (r.moved === 0 && r.isDone) break;
        if (r.moved === 0) throw new ConvexError(`${table}: empty batch before the range was exhausted`);
      }
    }
    const after = { [from]: await countAll(ctx, from), [to]: await countAll(ctx, to) };
    for (const table of TABLE_NAMES) {
      if (after[to][table] !== before[to][table] + before[from][table]) {
        throw new ConvexError(`${table}: count mismatch after move (${JSON.stringify({ before, after })})`);
      }
    }
    return { dryRun: false, before, moved, after, remainingOnFrom: total(after[from]) };
  },
});
