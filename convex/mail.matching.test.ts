import { beforeAll, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { scoreCandidates, decisiveCandidate } from "./classify";

const titles = [
  "Product Manager Intern 2027",
  "Software Developer Intern 2027",
  "IBM Power Product Management Intern - Austin, TX - 2027",
  "Product Management Intern / Infrastructure Growth & Innovation - Poughkeepsie, NY / Austin, TX - 2027",
  "Power Firmware Developer Intern - Rochester, MN & Austin, TX - 2027",
  "Power Backend Developer Intern - Rochester, MN & Austin, TX - 2027",
  "Application Developer Intern – Strategy & Transformation 2027",
];
const ids = ["128509", "128497", "130908", "131158", "130788", "130787", "129220"];
const apps = titles.map((title, i) => ({
  short: `app${i}`, company: "IBM", title,
  url: `https://careers.ibm.com/en_US/careers/JobDetail?jobId=${ids[i]}`,
}));
const email = (i: number) => ({
  fromAddr: "talent@ibm.com", fromName: "IBM Talent Acquisition",
  subject: `Action Required:IBM Coding Assessment for completion Candidate - ${ids[i]} - ${titles[i]}`,
  body: "Please complete the assessment. IBM recruiting. " + "Assessment instructions and privacy information. ".repeat(80),
});

beforeAll(() => { process.env.TRACKER_SECRET = "test-secret"; });

test.each([5, 6])("OA %i matches its requisition beyond the old five-result cutoff", (i) => {
  const candidates = scoreCandidates(email(i), apps);
  expect(candidates).toHaveLength(apps.length);
  expect(candidates[0].short).toBe(apps[i].short);
  expect(decisiveCandidate(candidates)).toBe(apps[i].short);
});

test("exact subject title wins even without an employer URL or requisition ID", () => {
  const candidates = scoreCandidates(
    { ...email(5), subject: `IBM assessment: ${titles[5]}` },
    apps.map((app) => ({ ...app, url: "" })),
  );
  expect(candidates[0].short).toBe(apps[5].short);
  expect(decisiveCandidate(candidates)).toBe(apps[5].short);
});

test("requisition ID distinguishes identical titles and does not match ID substrings", () => {
  const candidates = scoreCandidates({ ...email(5), subject: "IBM assessment for 130787" }, [
    { ...apps[0], title: titles[5], url: "https://careers.ibm.com/jobs/1307870" },
    apps[5],
  ]);
  expect(decisiveCandidate(candidates)).toBe(apps[5].short);
});

test("shared IDs at another employer do not outweigh the sender and title", () => {
  const candidates = scoreCandidates(email(5), [
    { ...apps[5], short: "other", company: "Other", url: "https://other.com/jobs/130787" },
    apps[5],
  ]);
  expect(decisiveCandidate(candidates)).toBe(apps[5].short);
});

test("company-only emails stay ambiguous", () => {
  expect(decisiveCandidate(scoreCandidates({ ...email(5), subject: "IBM assessment" }, apps))).toBeNull();
});

test("a ZIP code in the body cannot override the exact subject title", () => {
  const candidates = scoreCandidates({
    fromAddr: "recruiting@acme.com", fromName: "Acme",
    subject: "Acme assessment: Backend Developer Intern 2027",
    body: "Complete the assessment. Acme, New York, NY 10001",
  }, [
    { short: "pm", company: "Acme", title: "Product Manager Intern", url: "https://acme.com/jobs/10001" },
    { short: "backend", company: "Acme", title: "Backend Developer Intern 2027", url: "https://acme.com/jobs/20002" },
  ]);
  expect(decisiveCandidate(candidates)).toBe("backend");
});

test("labelled requisitions in the body still distinguish same-company applications", () => {
  const candidates = scoreCandidates({ ...email(5), subject: "IBM assessment", body: "Job ID: 130787" }, apps);
  expect(decisiveCandidate(candidates)).toBe(apps[5].short);
});

test("assessment-provider body titles remain weak manual candidates", () => {
  const candidates = scoreCandidates({
    fromAddr: "no-reply@hackerrank.com", fromName: "HackerRank", subject: "Assessment",
    body: "Backend Developer Intern",
  }, [{ short: "backend", company: "Acme", title: "Backend Developer Intern", url: "" }]);
  expect(candidates).toMatchObject([{ short: "backend", score: 1 }]);
  expect(decisiveCandidate(candidates)).toBeNull();
});

test("pending inbox rows refresh against current applications, retaining body-only evidence", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    for (const app of apps) {
      await ctx.db.insert("applications", {
        user: "u1", short: app.short, status: "applied", snapshot: app,
        history: [], createdAt: "2026-09-06",
      });
    }
    await ctx.db.insert("applications", {
      user: "someone-else", short: "private", status: "applied", snapshot: apps[5],
      history: [], createdAt: "2026-09-06",
    });
    await ctx.db.insert("inboxActions", {
      user: "u1", gmailMessageId: "oa", threadId: "thread", accountEmail: "user@example.com",
      from: "IBM Talent Acquisition <talent@ibm.com>", subject: email(5).subject,
      receivedAt: "2026-09-07", signal: "oa", evidence: "complete the assessment",
      source: "regex", state: "pending", createdAt: "2026-09-07",
      candidates: apps.slice(0, 5).map(({ short, company, title }) => ({ short, company, title, score: 6 })),
    });
  });
  const result = await t.query(api.mail.getActions, { user: "u1", secret: "test-secret" });
  expect(result.actions[0].candidates).toHaveLength(apps.length);
  expect(result.actions[0].candidates[0].short).toBe(apps[5].short);
  expect(result.actions[0].candidates).toContainEqual(expect.objectContaining({ short: apps[0].short, score: 6 }));
  expect(await t.run(async (ctx) => (await ctx.db.query("inboxActions").first())?.state)).toBe("pending");
});
