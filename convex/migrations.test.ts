import { expect, test } from "vitest";
import { convexTest } from "convex-test";

import { internal } from "./_generated/api";
import schema from "./schema";

async function seed(t: ReturnType<typeof convexTest>, user: string, shorts: string[]) {
  await t.run(async (ctx) => {
    for (const short of shorts) {
      await ctx.db.insert("ticks", { user, short, applied: true, saved: false, dismissed: false, updatedAt: 1 });
      await ctx.db.insert("applications", { user, short, status: "applied", history: [], createdAt: "2026-10-04T00:00:00Z" });
      await ctx.db.insert("matches", { user, short, item: { title: short }, pushedAt: 1 });
    }
    await ctx.db.insert("settings", { user, updatedAt: 1 });
  });
}

test("dry run reports counts and changes nothing", async () => {
  const t = convexTest(schema);
  await seed(t, "example", ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
  const r = await t.action(internal.migrations.renameUser, { from: "example", to: "nathan", dryRun: true });
  expect(r.dryRun).toBe(true);
  expect(r.before.example).toMatchObject({ ticks: 2, applications: 2, matches: 2, settings: 1 });
  expect(r.before.nathan.ticks).toBe(0);
  const still = await t.run((ctx) => ctx.db.query("ticks").collect());
  expect(still.every((row) => row.user === "example")).toBe(true);
});

test("real run moves every row, keeps shorts, leaves other users alone, and is re-runnable", async () => {
  const t = convexTest(schema);
  const shorts = Array.from({ length: 7 }, (_, i) => `${i}`.repeat(12));
  await seed(t, "example", shorts);
  await seed(t, "someone", ["cccccccccccc"]);

  const r = await t.action(internal.migrations.renameUser, { from: "example", to: "nathan", dryRun: false, batch: 3 });
  expect(r.remainingOnFrom).toBe(0);
  expect(r.moved).toMatchObject({ ticks: 7, applications: 7, matches: 7, settings: 1 });
  expect(r.after.nathan).toMatchObject({ ticks: 7, applications: 7, matches: 7, settings: 1 });

  const apps = await t.run((ctx) => ctx.db.query("applications").collect());
  expect(apps.filter((a) => a.user === "nathan").map((a) => a.short).sort()).toEqual(shorts.sort());
  expect(apps.filter((a) => a.user === "someone")).toHaveLength(1);

  // A second pass with stragglers: refuses by default because the target now owns rows...
  await seed(t, "example", ["dddddddddddd"]);
  await expect(
    t.action(internal.migrations.renameUser, { from: "example", to: "nathan", dryRun: false }),
  ).rejects.toThrow(/refusing/);
  // ...and picks them up when the re-run is explicit.
  const again = await t.action(internal.migrations.renameUser, {
    from: "example", to: "nathan", dryRun: false, allowExistingTarget: true,
  });
  expect(again.moved).toMatchObject({ ticks: 1, applications: 1, matches: 1, settings: 1 });
  expect(again.remainingOnFrom).toBe(0);
});

test("rejects malformed or identical keys", async () => {
  const t = convexTest(schema);
  await expect(t.action(internal.migrations.renameUser, { from: "example", to: "bad key", dryRun: true })).rejects.toThrow();
  await expect(t.action(internal.migrations.renameUser, { from: "x", to: "x", dryRun: true })).rejects.toThrow();
});
