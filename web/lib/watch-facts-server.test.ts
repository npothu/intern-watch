import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { MatchItem } from "./convex";

// The modules under test are server-only; under vitest that guard is a no-op.
vi.mock("server-only", () => ({}));

let getWatcherRuns: typeof import("./convex").getWatcherRuns;
let toTriageRows: typeof import("./app-data").toTriageRows;

beforeAll(async () => {
  // lib/convex reads these at import time.
  vi.stubEnv("CONVEX_URL", "https://example.invalid");
  vi.stubEnv("CONVEX_SECRET", "test-secret");
  ({ getWatcherRuns } = await import("./convex"));
  ({ toTriageRows } = await import("./app-data"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Stubs fetch with one Convex reply; returns the mock to inspect the request. */
function reply(value: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "success", value }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("getWatcherRuns", () => {
  test("calls watchRuns:recent with the user, the tracker secret and sinceMs", async () => {
    const fetchMock = reply([]);
    await getWatcherRuns("alice", 1234);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.invalid/api/query");
    expect(JSON.parse(init.body as string)).toEqual({
      path: "watchRuns:recent",
      args: { user: "alice", sinceMs: 1234, secret: "test-secret" },
      format: "json",
    });
    // No sinceMs: the query's own default window.
    await getWatcherRuns("alice");
    const [, init2] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(init2.body as string).args).toEqual({ user: "alice", secret: "test-secret" });
  });

  test("a non-array payload is no runs", async () => {
    for (const value of [null, {}, "runs", 3, { runs: [] }]) {
      reply(value);
      await expect(getWatcherRuns("alice")).resolves.toEqual([]);
    }
  });

  test("sorts ascending and drops malformed, negative and non-finite rows; keeps future ones", async () => {
    const future = Date.now() + 3600e3;
    reply([
      { at: 300, newMatches: 1 },
      { at: 100, newMatches: 2, extra: "x" },
      { at: -5, newMatches: 1 },
      { at: "200", newMatches: 1 },
      { at: Number.NaN, newMatches: 1 },
      { at: 250, newMatches: null },
      null,
      "row",
      { at: future, newMatches: 0 },
    ]);
    await expect(getWatcherRuns("alice")).resolves.toEqual([
      { at: 100, newMatches: 2 },
      { at: 300, newMatches: 1 },
      { at: future, newMatches: 0 },
    ]);
  });

  test("a thrown fetch, an error status or a non-JSON body resolve to []", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("offline"))));
    await expect(getWatcherRuns("alice")).resolves.toEqual([]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "error", errorMessage: "no such function" }), { status: 400 }))
    );
    await expect(getWatcherRuns("alice")).resolves.toEqual([]);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502 })));
    await expect(getWatcherRuns("alice")).resolves.toEqual([]);
  });
});

describe("toTriageRows facts gating", () => {
  const item = (short: string, facts: unknown): MatchItem => ({
    key: `k:${short}`,
    short,
    company: "Acme",
    title: "Software Engineer Intern",
    location: "Remote",
    term: "Summer 2027",
    added: "2026-11-08",
    tag: "",
    salary: "",
    url: "https://example.invalid/",
    facts,
  });
  const rows = (facts: unknown) => {
    const core = {
      matches: [item("a", facts)],
      ticks: [],
      ledger: [],
      prefs: { priorityNames: new Set<string>() },
      todayIso: "2026-11-08",
    } as unknown as Parameters<typeof toTriageRows>[0];
    return toTriageRows(core, {});
  };

  test("absent, non-object, array and all-malformed facts leave the row without facts", () => {
    for (const facts of [undefined, null, "facts", 7, [], [{ source: "s" }], {}, { source: 3, metro: { name: "x" } }]) {
      const [r] = rows(facts);
      expect(r).not.toHaveProperty("facts");
    }
  });

  test("well-typed members pass; malformed ones drop", () => {
    const [r] = rows({
      source: "simplify",
      sources: "simplify",
      delivery: { mode: "digest", at: "2026-11-08T20:00:00Z" },
      metro: { name: "Austin" },
      topCompany: { verdict: true },
    });
    expect(r.facts).toEqual({ source: "simplify", delivery: { mode: "digest", at: "2026-11-08T20:00:00Z" } });
  });
});
