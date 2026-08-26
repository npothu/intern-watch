import { beforeAll, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import * as settings from "./settings";
import { normalizeWatch, type WatchPrefs } from "./watch_schema";

// Settings > Watch: the object the page saves, the report the watcher
// pushes back, and the normalization between them. The resume-LLM half of
// settings.ts is exercised through the real connections page.

const SECRET = "test-tracker-secret";

beforeAll(() => {
  process.env.TRACKER_SECRET = SECRET;
});

const FULL: WatchPrefs = {
  terms: { leadWeeks: 3, horizonMonths: 14, include: ["Summer 2028"], exclude: [] },
  rules: { Spring: "top_atl_remote", Summer: "anything", Fall: "top_atl_remote" },
  priority: {
    companies: ["Microsoft", "Meta"],
    fromTracker: true,
    emailImmediately: true,
    subjectNames: true,
  },
  location: { remoteCounts: true },
  email: { sendAtLocal: [8], timezone: "America/New_York", to: ["a@example.com"] },
};

describe("normalizeWatch", () => {
  test("keeps a clean object as-is", () => {
    expect(normalizeWatch(FULL)).toEqual(FULL);
  });

  test("trims, de-duplicates and sorts", () => {
    const out = normalizeWatch({
      ...FULL,
      priority: { ...FULL.priority!, companies: [" Meta ", "meta", "Amazon  Web Services", ""] },
      email: { sendAtLocal: [18, 8, 8], timezone: " UTC ", to: ["A@x.com", "a@x.com", "b@x.com"] },
    });
    expect(out.priority!.companies).toEqual(["Meta", "Amazon Web Services"]);
    expect(out.email).toEqual({ sendAtLocal: [8, 18], timezone: "UTC", to: ["A@x.com", "b@x.com"] });
  });

  test("rejects what the page should have refused", () => {
    expect(() => normalizeWatch({ terms: { ...FULL.terms!, leadWeeks: 2.5 } })).toThrow(/lead time/);
    expect(() => normalizeWatch({ terms: { ...FULL.terms!, horizonMonths: 0 } })).toThrow(/horizon/);
    expect(() => normalizeWatch({ terms: { ...FULL.terms!, include: ["Fall"] } })).toThrow(/not a term/);
    expect(() =>
      normalizeWatch({ terms: { ...FULL.terms!, include: ["Fall 2027"], exclude: ["Fall 2027"] } }),
    ).toThrow(/both included and excluded/);
    expect(() => normalizeWatch({ email: { sendAtLocal: [], timezone: "UTC", to: ["a@x.com"] } })).toThrow(
      /at least one digest time/,
    );
    expect(() => normalizeWatch({ email: { sendAtLocal: [24], timezone: "UTC", to: ["a@x.com"] } })).toThrow(
      /between 0 and 23/,
    );
    expect(() => normalizeWatch({ email: { sendAtLocal: [8], timezone: "UTC", to: ["nope"] } })).toThrow(
      /not an email address/,
    );
    expect(() => normalizeWatch({ email: { sendAtLocal: [8], timezone: "UTC", to: [] } })).toThrow(
      /at least one recipient/,
    );
  });

  test("an absent block stays absent", () => {
    expect(normalizeWatch({ location: { remoteCounts: false } })).toEqual({ location: { remoteCounts: false } });
  });
});

describe("getWatch / setWatch / putWatchReport", () => {
  test("empty until saved; save replaces; report is independent", async () => {
    const t = convexTest(schema);
    expect(await t.query(settings.getWatch, { user: "u", secret: SECRET })).toEqual({
      watch: null,
      updatedAt: null,
      report: null,
    });

    const saved = await t.mutation(settings.setWatch, { user: "u", watch: FULL, secret: SECRET });
    expect(saved.watch).toEqual(FULL);
    const after = await t.query(settings.getWatch, { user: "u", secret: SECRET });
    expect(after.watch).toEqual(FULL);
    expect(after.updatedAt).toBeTypeOf("number");
    expect(after.report).toBeNull();

    // The watcher's report lands beside the prefs without touching them.
    const report = { reported_at: "2026-08-26T14:00:00+00:00", terms: { rows: [] } };
    await t.mutation(settings.putWatchReport, { user: "u", report, secret: SECRET });
    const withReport = await t.query(settings.getWatch, { user: "u", secret: SECRET });
    expect(withReport.report).toEqual(report);
    expect(withReport.watch).toEqual(FULL);

    // A second save is a replace, not a merge: dropping a block drops it.
    await t.mutation(settings.setWatch, {
      user: "u",
      watch: { priority: { ...FULL.priority!, companies: ["Stripe"] } },
      secret: SECRET,
    });
    const replaced = await t.query(settings.getWatch, { user: "u", secret: SECRET });
    expect(replaced.watch).toEqual({ priority: { ...FULL.priority!, companies: ["Stripe"] } });
    expect(replaced.report).toEqual(report);
  });

  test("a report for a user with no settings row creates one", async () => {
    const t = convexTest(schema);
    await t.mutation(settings.putWatchReport, { user: "fresh", report: { x: 1 }, secret: SECRET });
    const got = await t.query(settings.getWatch, { user: "fresh", secret: SECRET });
    expect(got).toMatchObject({ watch: null, report: { x: 1 } });
  });

  test("bad secret and bad values are rejected", async () => {
    const t = convexTest(schema);
    await expect(t.query(settings.getWatch, { user: "u", secret: "nope" })).rejects.toThrow(/bad secret/);
    await expect(
      t.mutation(settings.setWatch, {
        user: "u",
        watch: { terms: { leadWeeks: 99, horizonMonths: 14, include: [], exclude: [] } },
        secret: SECRET,
      }),
    ).rejects.toThrow(/lead time/);
  });
});
