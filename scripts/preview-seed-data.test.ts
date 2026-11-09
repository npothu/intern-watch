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

test("seed facts cover every detail-panel shape", () => {
  const { items, watchRuns } = buildPreviewSeed(sha1HexSync, { nowMs: Date.UTC(2026, 10, 9, 12) });
  const facts = items.map((i) => i.facts);
  expect(facts.every((f) => typeof f.source === "string" && f.acceptedBy)).toBe(true);
  for (const f of facts) {
    expect(new Set(f.sources).size).toBe(f.sources.length);
    expect(f.sources).toContain(f.source);
  }
  // i % 4 === 2 rows whose own source is jobright-swe (i = 10, 30) would
  // otherwise list it twice
  expect(facts[10].source).toBe("jobright-swe");
  expect(facts[10].sources).toEqual(["jobright-swe"]);
  const modes = new Set(facts.map((f) => f.delivery?.mode).filter(Boolean));
  expect(modes).toEqual(new Set(["immediate", "digest"]));
  expect(facts.some((f) => !f.delivery)).toBe(true);
  expect(facts.some((f) => f.termSource === "llm")).toBe(true);
  expect(facts.some((f) => f.metro?.source === "llm")).toBe(true);
  expect(facts.some((f) => f.topCompany?.source === "llm" && f.topCompany.judgedAt)).toBe(true);
  expect(facts.filter((f) => f.clearanceObtainable)).toHaveLength(1);
  const unresolved = items.filter((i) => i.facts.termSource === "unresolved");
  expect(unresolved).toHaveLength(1);
  expect(unresolved[0].term).toBeNull();
  expect(unresolved[0].facts.acceptedBy).toBe("unresolved-all-terms");
  expect(watchRuns).toHaveLength(12);
  const now = Date.UTC(2026, 10, 9, 12);
  expect(watchRuns.every((r) => r.at <= now && r.at > now - 24 * 60 * 60 * 1000)).toBe(true);
  expect(watchRuns.map((r) => r.at)).toEqual([...watchRuns.map((r) => r.at)].sort((x, y) => x - y));
});

test("seed goes through the real tracker mutations", async () => {
  process.env.TRACKER_SECRET = SECRET;
  const t = convexTest(schema);
  const nowMs = Date.now();
  const { items, applications, ticks, watchRuns } = buildPreviewSeed(sha1HexSync, { nowMs });
  const user = "nathan";
  await t.mutation(api.tracker.pushMatches, { user, items, secret: SECRET });
  for (const x of applications) {
    await t.mutation(api.tracker.recordStatus, { user, short: x.short, status: x.status, note: x.note, snapshot: x.snapshot, secret: SECRET });
  }
  await t.mutation(api.tracker.setTicks, { user, writes: ticks, secret: SECRET });
  for (const run of watchRuns) {
    await t.mutation(api.watchRuns.record, { user, ...run, secret: SECRET });
  }
  const recent = await t.query(api.watchRuns.recent, { user, secret: SECRET });
  expect(recent).toHaveLength(watchRuns.length);
  const pushed = await t.query(api.tracker.getMatches, { user, secret: SECRET });
  expect(pushed.every((m: { facts?: { source?: string } }) => typeof m.facts?.source === "string")).toBe(true);

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
