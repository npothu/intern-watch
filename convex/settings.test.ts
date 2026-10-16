import { beforeAll, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { normalizeWatch, type WatchPrefs } from "./watch_types";
import { OPERATOR_DAILY_CAP } from "./settings";
import { OPERATOR_MODEL } from "./llm_providers";

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
  });

  test("no recipients is allowed: it means keep the yaml's list", () => {
    expect(normalizeWatch({ email: { sendAtLocal: [8], timezone: "UTC", to: [] } })).toEqual({
      email: { sendAtLocal: [8], timezone: "UTC", to: [] },
    });
  });

  test("an absent block stays absent", () => {
    expect(normalizeWatch({ location: { remoteCounts: false } })).toEqual({ location: { remoteCounts: false } });
  });
});

describe("getWatch / setWatch / putWatchReport", () => {
  test("empty until saved; save replaces; report is independent", async () => {
    const t = convexTest(schema);
    expect(await t.query(api.settings.getWatch, { user: "u", secret: SECRET })).toEqual({
      watch: null,
      updatedAt: null,
      report: null,
    });

    const saved = await t.mutation(api.settings.setWatch, { user: "u", watch: FULL, secret: SECRET });
    expect(saved.watch).toEqual(FULL);
    const after = await t.query(api.settings.getWatch, { user: "u", secret: SECRET });
    expect(after.watch).toEqual(FULL);
    expect(after.updatedAt).toBeTypeOf("number");
    expect(after.report).toBeNull();

    // The watcher's report lands beside the prefs without touching them.
    const report = { reported_at: "2026-08-26T14:00:00+00:00", terms: { rows: [] } };
    await t.mutation(api.settings.putWatchReport, { user: "u", report, secret: SECRET });
    const withReport = await t.query(api.settings.getWatch, { user: "u", secret: SECRET });
    expect(withReport.report).toEqual(report);
    expect(withReport.watch).toEqual(FULL);

    // A second save is a replace, not a merge: dropping a block drops it.
    await t.mutation(api.settings.setWatch, {
      user: "u",
      watch: { priority: { ...FULL.priority!, companies: ["Stripe"] } },
      secret: SECRET,
    });
    const replaced = await t.query(api.settings.getWatch, { user: "u", secret: SECRET });
    expect(replaced.watch).toEqual({ priority: { ...FULL.priority!, companies: ["Stripe"] } });
    expect(replaced.report).toEqual(report);
  });

  test("a report for a user with no settings row creates one", async () => {
    const t = convexTest(schema);
    await t.mutation(api.settings.putWatchReport, { user: "fresh", report: { x: 1 }, secret: SECRET });
    const got = await t.query(api.settings.getWatch, { user: "fresh", secret: SECRET });
    expect(got).toMatchObject({ watch: null, report: { x: 1 } });
  });

  test("bad secret and bad values are rejected", async () => {
    const t = convexTest(schema);
    await expect(t.query(api.settings.getWatch, { user: "u", secret: "nope" })).rejects.toThrow(/bad secret/);
    await expect(
      t.mutation(api.settings.setWatch, {
        user: "u",
        watch: { terms: { leadWeeks: 99, horizonMonths: 14, include: [], exclude: [] } },
        secret: SECRET,
      }),
    ).rejects.toThrow(/lead time/);
  });
});

describe("setOperatorGrant", () => {
  test("a granted cap and model apply to that user only, and clear with null", async () => {
    const t = convexTest(schema);
    const read = (user: string) => t.query(api.settings.getResumeLlm, { user, secret: SECRET });

    expect(await t.mutation(internal.settings.setOperatorGrant, {
      user: "u", dailyCap: 50, model: "gemini-4-argon",
    })).toEqual({ user: "u", dailyCap: 50, model: "gemini-4-argon" });
    expect(await read("u")).toMatchObject({ dailyCap: 50, defaultModel: "gemini-4-argon" });
    expect(await read("other")).toMatchObject({ dailyCap: OPERATOR_DAILY_CAP, defaultModel: OPERATOR_MODEL });

    // The reservation honours the grant: allowed past the default, stopped at 50.
    for (let i = 0; i < 50; i++) {
      expect((await t.mutation(internal.settings.consumeOperatorLlm, { user: "u" })).allowed).toBe(true);
    }
    expect((await t.mutation(internal.settings.consumeOperatorLlm, { user: "u" })).allowed).toBe(false);
    expect(await t.query(internal.settings.operatorCapReached, { user: "u" })).toBe(true);

    // Omitted fields are untouched; null reverts to the default.
    await t.mutation(internal.settings.setOperatorGrant, { user: "u", dailyCap: null });
    expect(await read("u")).toMatchObject({ dailyCap: OPERATOR_DAILY_CAP, defaultModel: "gemini-4-argon" });
  });

  test("rejects a nonsense cap", async () => {
    const t = convexTest(schema);
    await expect(t.mutation(internal.settings.setOperatorGrant, { user: "u", dailyCap: -1 }))
      .rejects.toThrow(/non-negative integer/);
  });
});
