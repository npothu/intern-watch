import { describe, expect, test, vi, beforeAll } from "vitest";
import { convexTest } from "convex-test";
import cases from "../shared/ats-board-cases.json";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { detectAtsBoard, isBoardWatched, normalizeFoundVia } from "./ats_detect";

const SECRET = "test-tracker-secret";
beforeAll(() => {
  process.env.TRACKER_SECRET = SECRET;
});

describe("ATS board detection agrees with src/coverage.py", () => {
  test.each(cases)("$url", (c) => {
    const { url, ats, board } = c;
    const scope = (c as { scope?: string }).scope;
    expect(detectAtsBoard(url)).toEqual(ats === null ? null : { ats, board, ...(scope ? { scope } : {}) });
  });
});

describe("isBoardWatched", () => {
  const report = { watched_boards: ["greenhouse:acme", "workday:acme/wd5/careers_acme"] };
  test("compares case-insensitively against the watch report", () => {
    expect(isBoardWatched({ ats: "workday", board: "acme/wd5/Careers_Acme" }, report)).toBe(true);
    expect(isBoardWatched({ ats: "greenhouse", board: "beta" }, report)).toBe(false);
  });
  test("oracle needs its exact site; eightfold host-only only with one polled domain", () => {
    const r = { watched_boards: [
      "oracle:abcd.fa.us2.oraclecloud.com/cx_1",
      "eightfold:ngc.eightfold.ai/ngc.com",
      "eightfold:two.eightfold.ai/a.com", "eightfold:two.eightfold.ai/b.com",
    ] };
    const oracle = (site: string) => detectAtsBoard(
      `https://abcd.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/${site}/job/1`);
    expect(isBoardWatched(oracle("CX_1"), r)).toBe(true);
    expect(isBoardWatched(oracle("CX"), r)).toBe(false); // sibling site of a polled pod
    expect(isBoardWatched(detectAtsBoard("https://ngc.eightfold.ai/careers/job/123456"), r)).toBe(true);
    expect(isBoardWatched(detectAtsBoard("https://two.eightfold.ai/careers/job/123456"), r)).toBeUndefined();
    expect(isBoardWatched(detectAtsBoard("https://other.eightfold.ai/careers/job/123456"), r)).toBeUndefined();
    expect(isBoardWatched(detectAtsBoard("https://apply.careers.microsoft.com/careers/job/1970393556621237"),
      { watched_boards: ["eightfold:apply.careers.microsoft.com/other.com"] })).toBe(false);
  });
  test("unknown without a report or a board", () => {
    expect(isBoardWatched({ ats: "greenhouse", board: "acme" }, null)).toBeUndefined();
    expect(isBoardWatched({ ats: "greenhouse", board: null }, report)).toBeUndefined();
  });
  test("normalizeFoundVia", () => {
    expect(normalizeFoundVia("  Instagram  Story ")).toBe("instagram story");
    expect(normalizeFoundVia("   ")).toBeUndefined();
  });
});

describe("manual add records the coverage gap", () => {
  test("ingest row and resulting match carry ats, board, watched and foundVia", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert("settings", {
        user: "u1",
        watchReport: { watched_boards: ["greenhouse:acme"], supported_ats: ["greenhouse", "smartrecruiters"] },
        updatedAt: 0,
      });
    });
    const url = "https://jobs.smartrecruiters.com/Gamma/744000147613769-intern";
    const res = await t.mutation(api.ingest.requestIngest, {
      user: "u1", url, secret: SECRET, foundVia: "Instagram",
    });
    expect(res).toMatchObject({
      status: "fetching", ats: "smartrecruiters", atsBoard: "Gamma", boardWatched: false, atsSupported: true,
      foundVia: "instagram",
    });
    const row = await t.query(api.ingest.getIngestStatus, { user: "u1", ingestId: res.ingestId as any, secret: SECRET });
    expect(row).toMatchObject({ ats: "smartrecruiters", atsBoard: "Gamma", boardWatched: false });

    const html = `<script type="application/ld+json">{"@type":"JobPosting","title":"SWE Intern","hiringOrganization":{"name":"Gamma"}}</script>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(html, { status: 200, headers: { "Content-Type": "text/html" } })));
    try {
      await t.action(internal.ingest_node.runIngest, { user: "u1", ingestId: res.ingestId as any });
    } finally {
      vi.unstubAllGlobals();
    }
    const [match] = await t.run(async (ctx) => ctx.db.query("matches").collect());
    expect(match.item).toMatchObject({ ats: "smartrecruiters", atsBoard: "Gamma", foundVia: "instagram" });
  });

  test("a watched board is reported as watched; no report means unknown", async () => {
    const t = convexTest(schema);
    const url = "https://job-boards.greenhouse.io/acme/jobs/123";
    const before = await t.mutation(api.ingest.requestIngest, { user: "u1", url, secret: SECRET });
    expect(before).toMatchObject({ ats: "greenhouse", atsBoard: "acme" });
    expect("boardWatched" in before).toBe(false);

    await t.run(async (ctx) => {
      await ctx.db.insert("settings", { user: "u2", watchReport: { watched_boards: ["greenhouse:acme"] }, updatedAt: 0 });
    });
    const after = await t.mutation(api.ingest.requestIngest, { user: "u2", url, secret: SECRET });
    expect(after).toMatchObject({ boardWatched: true });
  });
});

describe("coverage:getFailedIngests", () => {
  test("returns only failed manual adds, with their gap facts", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      const base = { user: "u1", short: "aaaaaaaaaaaa", createdAt: Date.UTC(2026, 10, 3), updatedAt: 0 };
      await ctx.db.insert("manualIngests", {
        ...base, url: "https://acme.wd5.myworkdayjobs.com/Ext/job/x_R1", status: "failed",
        ats: "workday", atsBoard: "acme.wd5/Ext", foundVia: "instagram",
      });
      await ctx.db.insert("manualIngests", { ...base, url: "https://example.com/j/1", status: "done" });
      await ctx.db.insert("manualIngests", { ...base, user: "u2", url: "https://example.com/j/2", status: "failed" });
    });
    const rows = await t.query(api.coverage.getFailedIngests, { user: "u1", secret: SECRET });
    expect(rows).toEqual([{
      url: "https://acme.wd5.myworkdayjobs.com/Ext/job/x_R1", ats: "workday", atsBoard: "acme.wd5/Ext",
      foundVia: "instagram", added: "2026-11-03",
    }]);
    await expect(t.query(api.coverage.getFailedIngests, { user: "u1", secret: "nope" })).rejects.toThrow();
  });
});
