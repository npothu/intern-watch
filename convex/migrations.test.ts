import { afterEach, beforeEach, expect, test } from "vitest";
import { convexTest } from "convex-test";

import { api, internal } from "./_generated/api";
import schema from "./schema";
import { USER_TABLES } from "./migrations";

const SECRET = "test-tracker-secret";

beforeEach(() => {
  process.env.TRACKER_SECRET = SECRET;
  process.env.TRACKER_MAINTENANCE = "1";
});
afterEach(() => {
  delete process.env.TRACKER_MAINTENANCE;
});

async function seed(t: ReturnType<typeof convexTest>, user: string, shorts: string[], singletons = true) {
  await t.run(async (ctx) => {
    for (const short of shorts) {
      await ctx.db.insert("ticks", { user, short, applied: true, saved: false, dismissed: false, updatedAt: 1 });
      await ctx.db.insert("applications", { user, short, status: "applied", history: [], createdAt: "2026-10-04T00:00:00Z" });
      await ctx.db.insert("matches", { user, short, item: { title: short }, pushedAt: 1 });
    }
    if (singletons) await ctx.db.insert("settings", { user, updatedAt: 1 });
  });
}

test("every schema table with a user field is migrated", () => {
  const covered = new Set(USER_TABLES.map(([t]) => t));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tables = (schema as any).tables as Record<string, any>;
  const withUser = Object.entries(tables)
    .filter(([, def]) => def.validator?.fields?.user !== undefined)
    .map(([name]) => name);
  expect(withUser.length).toBeGreaterThanOrEqual(19);
  expect(withUser.filter((name) => !covered.has(name))).toEqual([]);
});

test("dry run reports counts, collisions and blockers and changes nothing", async () => {
  const t = convexTest(schema);
  await seed(t, "example", ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
  await seed(t, "nathan", ["aaaaaaaaaaaa"], false);
  const r = await t.action(internal.migrations.renameUser, { from: "example", to: "nathan", dryRun: true });
  expect(r.dryRun).toBe(true);
  expect(r.before.example).toMatchObject({ ticks: 2, applications: 2, matches: 2, settings: 1 });
  expect(r.collisions.length).toBe(3); // ticks/applications/matches for aaaaaaaaaaaa
  expect(r.blockers.join(" ")).toMatch(/collision/);
  const still = await t.run((ctx) => ctx.db.query("ticks").withIndex("by_user", (q) => q.eq("user", "example")).collect());
  expect(still).toHaveLength(2);
});

test("real run moves all rows (incl. referrals) with ids intact and leaves others alone", async () => {
  const t = convexTest(schema);
  const shorts = Array.from({ length: 7 }, (_, i) => `${i}`.repeat(12));
  await seed(t, "example", shorts);
  await seed(t, "someone", ["cccccccccccc"]);
  const contactId = await t.run(async (ctx) => {
    const now = 1;
    const id = await ctx.db.insert("referralContacts", {
      user: "example", name: "Ada", company: "Acme", relationship: "", email: "", profileUrl: "",
      availability: "can_refer", followUpOn: "", nextStep: "", archived: false, createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("referralNotes", { user: "example", contactId: id, text: "met at career fair", createdAt: now });
    return id;
  });

  const r = await t.action(internal.migrations.renameUser, { from: "example", to: "nathan", dryRun: false, batch: 3 });
  expect(r.remainingOnFrom).toBe(0);
  expect(r.moved).toMatchObject({ ticks: 7, applications: 7, matches: 7, settings: 1 });
  expect(r.after.nathan).toMatchObject({ ticks: 7, applications: 7, matches: 7, settings: 1 });

  const apps = await t.run((ctx) => ctx.db.query("applications").collect());
  expect(apps.filter((a) => a.user === "nathan").map((a) => a.short).sort()).toEqual([...shorts].sort());
  expect(apps.filter((a) => a.user === "someone")).toHaveLength(1);
  const moved = await t.run(async (ctx) => ({
    contact: await ctx.db.get(contactId),
    notes: await ctx.db.query("referralNotes").withIndex("by_contact", (q) => q.eq("contactId", contactId)).collect(),
  }));
  expect(moved.contact?.user).toBe("nathan"); // same document id, new owner
  expect(moved.notes.map((n) => n.user)).toEqual(["nathan"]);
});

test("refuses without maintenance, and refuses on collisions without moving anything", async () => {
  const t = convexTest(schema);
  await seed(t, "example", ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);

  delete process.env.TRACKER_MAINTENANCE;
  await expect(t.action(internal.migrations.renameUser, { from: "example", to: "nathan", dryRun: false }))
    .rejects.toThrow(/TRACKER_MAINTENANCE/);
  process.env.TRACKER_MAINTENANCE = "1";

  await seed(t, "nathan", ["bbbbbbbbbbbb"], false);
  await expect(t.action(internal.migrations.renameUser, { from: "example", to: "nathan", dryRun: false }))
    .rejects.toThrow(/collision/);
  const moved = await t.run((ctx) => ctx.db.query("ticks").withIndex("by_user", (q) => q.eq("user", "nathan")).collect());
  expect(moved).toHaveLength(1); // only the pre-existing target row
});

test("a second settings row is a singleton collision", async () => {
  const t = convexTest(schema);
  await seed(t, "example", []);
  await seed(t, "nathan", []);
  const r = await t.action(internal.migrations.renameUser, { from: "example", to: "nathan", dryRun: true });
  expect(r.collisions.some((c: string) => c.startsWith("settings"))).toBe(true);
});

test("moving the old target aside first, then the real rename, is collision-free and re-runnable", async () => {
  const t = convexTest(schema);
  await seed(t, "example", ["aaaaaaaaaaaa"]);
  await seed(t, "nathan", ["aaaaaaaaaaaa"]);
  await t.action(internal.migrations.renameUser, { from: "nathan", to: "nathan_legacy", dryRun: false });
  const r = await t.action(internal.migrations.renameUser, { from: "example", to: "nathan", dryRun: false });
  expect(r.remainingOnFrom).toBe(0);
  // Re-running with nothing left on `from` is a no-op.
  const again = await t.action(internal.migrations.renameUser, { from: "example", to: "nathan", dryRun: false });
  expect(again.remainingOnFrom).toBe(0);
  expect(Object.values(again.moved as Record<string, number>).every((n) => n === 0)).toBe(true);
});

test("maintenance blocks public endpoints", async () => {
  const t = convexTest(schema);
  await expect(t.query(api.tracker.getTicks, { user: "example", secret: SECRET }))
    .rejects.toThrow(/maintenance/);
  delete process.env.TRACKER_MAINTENANCE;
  await expect(t.query(api.tracker.getTicks, { user: "example", secret: SECRET })).resolves.toBeDefined();
});

test("deleteUser removes only that user's rows and needs confirm + maintenance", async () => {
  const t = convexTest(schema);
  await seed(t, "nathan", ["aaaaaaaaaaaa"]);
  await seed(t, "example", ["aaaaaaaaaaaa"]);
  const dry = await t.action(internal.migrations.deleteUser, { user: "nathan", dryRun: true });
  expect(dry.before).toMatchObject({ ticks: 1, applications: 1, matches: 1, settings: 1 });
  await expect(t.action(internal.migrations.deleteUser, { user: "nathan", dryRun: false })).rejects.toThrow(/confirm/);
  delete process.env.TRACKER_MAINTENANCE;
  await expect(t.action(internal.migrations.deleteUser, { user: "nathan", dryRun: false, confirm: "nathan" }))
    .rejects.toThrow(/TRACKER_MAINTENANCE/);
  process.env.TRACKER_MAINTENANCE = "1";
  const r = await t.action(internal.migrations.deleteUser, { user: "nathan", dryRun: false, confirm: "nathan" });
  expect(r.remaining).toBe(0);
  const left = await t.run((ctx) => ctx.db.query("ticks").collect());
  expect(left.map((row) => row.user)).toEqual(["example"]);
  // Now the rename is collision-free.
  const moved = await t.action(internal.migrations.renameUser, { from: "example", to: "nathan", dryRun: false });
  expect(moved.remainingOnFrom).toBe(0);
});

test("rejects malformed or identical keys", async () => {
  const t = convexTest(schema);
  await expect(t.action(internal.migrations.renameUser, { from: "example", to: "bad key", dryRun: true })).rejects.toThrow();
  await expect(t.action(internal.migrations.renameUser, { from: "x", to: "x", dryRun: true })).rejects.toThrow();
});
