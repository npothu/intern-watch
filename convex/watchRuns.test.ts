import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { RETAIN_MS } from "./watchRuns";

// Watcher run history: record() inserts and prunes past 7 days per user;
// recent() returns the window ascending, defaulting to the last 24h.

const SECRET = "test-tracker-secret";
const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);

beforeAll(() => {
  process.env.TRACKER_SECRET = SECRET;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("watchRuns", () => {
  test("record + recent: last 24h by default, ascending, only at/newMatches", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const t = convexTest(schema);
    for (const h of [30, 2, 20, 1]) {
      await t.mutation(api.watchRuns.record, {
        user: "u", at: NOW - h * HOUR, newMatches: h, scanned: 100, source: "schedule", secret: SECRET,
      });
    }
    await t.mutation(api.watchRuns.record, { user: "other", at: NOW - HOUR, newMatches: 9, secret: SECRET });
    const runs = await t.query(api.watchRuns.recent, { user: "u", secret: SECRET });
    expect(runs).toEqual([
      { at: NOW - 20 * HOUR, newMatches: 20 },
      { at: NOW - 2 * HOUR, newMatches: 2 },
      { at: NOW - HOUR, newMatches: 1 },
    ]);
    const wide = await t.query(api.watchRuns.recent, { user: "u", sinceMs: NOW - 48 * HOUR, secret: SECRET });
    expect(wide.map((r) => r.newMatches)).toEqual([30, 20, 2, 1]);
  });

  test("record prunes this user's rows older than 7 days, not other users'", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert("watchRuns", { user: "u", at: NOW - RETAIN_MS - HOUR, newMatches: 1 });
      await ctx.db.insert("watchRuns", { user: "u", at: NOW - RETAIN_MS + HOUR, newMatches: 2 });
      await ctx.db.insert("watchRuns", { user: "v", at: NOW - RETAIN_MS - HOUR, newMatches: 3 });
    });
    await t.mutation(api.watchRuns.record, { user: "u", at: NOW, newMatches: 4, secret: SECRET });
    const rows = await t.run((ctx) => ctx.db.query("watchRuns").collect());
    expect(rows.map((r) => [r.user, r.newMatches]).sort()).toEqual([["u", 2], ["u", 4], ["v", 3]]);
  });

  test("bad secret is refused", async () => {
    const t = convexTest(schema);
    await expect(
      t.mutation(api.watchRuns.record, { user: "u", at: 1, newMatches: 0, secret: "nope" }),
    ).rejects.toThrow(/bad secret/);
    await expect(t.query(api.watchRuns.recent, { user: "u", secret: "nope" })).rejects.toThrow(/bad secret/);
  });
});
