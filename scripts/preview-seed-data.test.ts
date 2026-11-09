import { expect, test } from "vitest";
import { convexTest } from "convex-test";

import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { sha1HexSync } from "../convex/short_key";
import { buildPreviewSeed } from "./preview-seed-data.mjs";

const SECRET = "test-tracker-secret";

test("seed is deterministic, fictional, and shorts match the watcher's sha1(key)[:12]", () => {
  const a = buildPreviewSeed(sha1HexSync);
  const b = buildPreviewSeed(sha1HexSync);
  expect(a).toEqual(b);
  expect(a.items).toHaveLength(36);
  expect(new Set(a.items.map((i) => i.short)).size).toBe(36);
  for (const item of a.items) {
    expect(new URL(item.url).hostname.endsWith(".invalid")).toBe(true);
    expect(item.short).toBe(sha1HexSync(item.key).slice(0, 12));
  }
  expect(new Set(a.applications.map((x) => x.status))).toEqual(
    new Set(["applied", "oa", "phone_screen", "interview", "rejected", "offer", "withdrawn"]),
  );
});

test("seed goes through the real tracker mutations", async () => {
  process.env.TRACKER_SECRET = SECRET;
  const t = convexTest(schema);
  const { items, applications, ticks } = buildPreviewSeed(sha1HexSync);
  const user = "nathan";
  await t.mutation(api.tracker.pushMatches, { user, items, secret: SECRET });
  for (const x of applications) {
    await t.mutation(api.tracker.recordStatus, { user, short: x.short, status: x.status, note: x.note, snapshot: x.snapshot, secret: SECRET });
  }
  await t.mutation(api.tracker.setTicks, { user, writes: ticks, secret: SECRET });

  const counts = await t.run(async (ctx) => ({
    matches: (await ctx.db.query("matches").collect()).length,
    applications: await ctx.db.query("applications").collect(),
    ticks: (await ctx.db.query("ticks").collect()).length,
  }));
  expect(counts.matches).toBe(items.length);
  expect(counts.applications).toHaveLength(applications.length);
  expect(counts.applications.every((row) => row.user === user)).toBe(true);
  expect(counts.ticks).toBeGreaterThan(applications.length);
});

test("seeded watch report drives the add-URL watched-board hint", async () => {
  process.env.TRACKER_SECRET = SECRET;
  const t = convexTest(schema);
  const { watchReport } = buildPreviewSeed(sha1HexSync);
  const user = "nathan";
  await t.mutation(api.settings.putWatchReport, { user, report: watchReport, secret: SECRET });
  const watched = await t.mutation(api.ingest.requestIngest, {
    user, url: "https://job-boards.greenhouse.io/previewwatched/jobs/1", secret: SECRET,
  });
  const unwatched = await t.mutation(api.ingest.requestIngest, {
    user, url: "https://jobs.lever.co/notwatched/1", secret: SECRET,
  });
  expect(watched).toMatchObject({ boardWatched: true });
  expect(unwatched).toMatchObject({ boardWatched: false, atsSupported: true, ats: "lever", atsBoard: "notwatched" });
});
