import { expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { internal } from "./_generated/api";


// Synthetic rows only: fictional employers, .invalid URLs.
const row = (short: string, item: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  user: "alice", short, pushedAt: 0,
  item: { key: `k:${short}`, short, company: "Example Robotics", location: "", added: "2026-10-15",
    tag: "", salary: "", url: `https://jobs.example.invalid/${short}`, source: "manual", ...item },
  ...extra,
});

async function seeded() {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    await ctx.db.insert("matches", row("aaaaaaaaaaa1", { title: "Software Engineer Intern", term: "" },
      { jobDescription: "This 12-week summer internship is based in Austin." }));
    await ctx.db.insert("matches", row("aaaaaaaaaaa2", { title: "Hardware Intern", term: "" },
      { jobDescription: "Internship dates: May-August 2027." }));
    await ctx.db.insert("matches", row("aaaaaaaaaaa3", { title: "Data Intern (Fall 2027)", term: "" }));
    await ctx.db.insert("matches", row("aaaaaaaaaaa4", { title: "Software Engineer Intern", term: "" },
      { jobDescription: "Graduating in Spring 2028 or later." }));
    await ctx.db.insert("matches", row("aaaaaaaaaaa5", { title: "Robotics Intern", term: "Summer 2027" }));
    await ctx.db.insert("matches", row("aaaaaaaaaaa6", { title: "Software Engineer Intern", term: "" },
      { jobDescription: "Fall 2027 co-op.", overrides: { term: "Spring 2027", updatedAt: 1 } }));
    await ctx.db.insert("matches", { ...row("bbbbbbbbbbb1", { title: "Intern", term: "" },
      { jobDescription: "Summer 2027 internship." }), user: "bob" });
  });
  return t;
}

const terms = (t: ReturnType<typeof convexTest>) => t.run(async (ctx) =>
  Object.fromEntries((await ctx.db.query("matches").collect()).map((r) => [r.short, r.item.term])));

test("dry run (the default) reports counts and writes nothing", async () => {
  const t = await seeded();
  const before = await terms(t);
  const report = await t.action(internal.term_backfill.backfillTerms, { user: "alice" });
  expect(report.dryRun).toBe(true);
  expect(report.counts).toEqual({
    scanned: 6, blank: 5, blankWithJd: 3, corrected: 1, resolved: 3, resolvedFromJd: 2,
    explicit: 1, inferred: 2, unresolved: 1, written: 0,
  });
  expect(report.samples.map((s) => [s.short, s.term, s.source])).toEqual([
    ["aaaaaaaaaaa1", "Summer 2027", "jd"],
    ["aaaaaaaaaaa2", "Summer 2027", "jd"],
    ["aaaaaaaaaaa3", "Fall 2027", "title"],
  ]);
  expect(await terms(t)).toEqual(before);
});

test("dryRun: false writes only resolved blank rows of the chosen user", async () => {
  const t = await seeded();
  const report = await t.action(internal.term_backfill.backfillTerms, { user: "alice", dryRun: false });
  expect(report.counts.written).toBe(3);
  expect(await terms(t)).toMatchObject({
    aaaaaaaaaaa1: "Summer 2027", aaaaaaaaaaa2: "Summer 2027", aaaaaaaaaaa3: "Fall 2027",
    aaaaaaaaaaa4: "", aaaaaaaaaaa5: "Summer 2027", aaaaaaaaaaa6: "", bbbbbbbbbbb1: "",
  });
  const confidence = await t.run(async (ctx) => (await ctx.db.query("matches").collect())
    .find((r) => r.short === "aaaaaaaaaaa3")?.item.termConfidence);
  expect(confidence).toBe("explicit");
});

test("without a user it covers every user", async () => {
  const t = await seeded();
  const report = await t.action(internal.term_backfill.backfillTerms, {});
  expect(report.counts.scanned).toBe(7);
  expect(report.counts.resolved).toBe(4);
});
