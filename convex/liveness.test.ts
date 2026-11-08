import { beforeAll, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { readFileSync, readdirSync } from "node:fs";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import {
  checkLiveness,
  classifyPage,
  closedText,
  isClosed,
  nextLiveness,
  oracleTarget,
  probePlan,
  CLOSED_CONFIRMATIONS,
  RECHECK_MS,
  type Fetcher,
  type HttpResult,
} from "./liveness";

// Fixtures are real responses recorded on 2026-11-08 with curl (browser UA,
// one request at a time) and trimmed: tests/fixtures/liveness/<case>.json
// holds the match URL, the expected verdict, and every request the probe is
// expected to make, in order. A request not listed fails the test, so these
// also pin the request count (politeness) per ATS.

const SECRET = "test-tracker-secret";
beforeAll(() => {
  process.env.TRACKER_SECRET = SECRET;
});

type Call = { url: string; status: number; finalUrl?: string; body: string };
type Case = { url: string; expect: "open" | "closed" | "unknown"; calls: Call[] };

const FIXTURE_DIR = new URL("../tests/fixtures/liveness/", import.meta.url);

function loadCases(): [string, Case][] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => [f.replace(/\.json$/, ""), JSON.parse(readFileSync(new URL(f, FIXTURE_DIR), "utf8"))]);
}

function replay(calls: Call[]): { fetcher: Fetcher; seen: string[] } {
  const seen: string[] = [];
  const fetcher: Fetcher = async (url) => {
    seen.push(url);
    const hit = calls[seen.length - 1];
    if (!hit || hit.url !== url) throw new Error(`unexpected request #${seen.length}: ${url}`);
    return { status: hit.status, finalUrl: hit.finalUrl ?? url, body: hit.body };
  };
  return { fetcher, seen };
}

describe("checkLiveness against recorded responses", () => {
  for (const [name, c] of loadCases()) {
    test(`${name} -> ${c.expect}`, async () => {
      const { fetcher, seen } = replay(c.calls);
      const v = await checkLiveness(c.url, fetcher);
      expect(v.state, v.reason).toBe(c.expect);
      expect(seen).toEqual(c.calls.map((x) => x.url));
    });
  }
});

describe("probePlan", () => {
  test("Oracle CX job and preview URLs map to the ById finder", () => {
    const a = oracleTarget(new URL("https://abc.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/12345"));
    expect(a).toBe(
      "https://abc.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?onlyData=true&finder=ById;Id=%2212345%22,siteNumber=CX_1",
    );
    const b = oracleTarget(new URL("https://abc.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/requisitions/preview/777"));
    expect(b).toContain("Id=%22777%22,siteNumber=CX_1");
    expect(oracleTarget(new URL("https://example.com/hcmUI/CandidateExperience/en/sites/CX/job/1"))).toBeNull();
  });

  test("Workday apply sub-pages probe the posting, not the apply flow", () => {
    const p = probePlan("https://acme.wd5.myworkdayjobs.com/en-US/Ext/job/US-CA/Intern_R1/apply/applyManually");
    expect(p?.kind).toBe("workday");
    expect(p?.api).toBe("https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/Ext/job/US-CA/Intern_R1");
  });

  test("EU Greenhouse boards are page-only (the API host differs)", () => {
    expect(probePlan("https://job-boards.eu.greenhouse.io/veeam/jobs/123")?.kind).toBe("page");
  });

  test("Avature by host or JobDetail path; non-http is unprobeable", () => {
    expect(probePlan("https://acme.avature.net/careers/JobDetail/Intern/42")?.kind).toBe("avature");
    expect(probePlan("https://careers.example.com/en_US/careers/JobDetail?jobId=1")?.kind).toBe("avature");
    expect(probePlan("mailto:jobs@example.com")).toBeNull();
    expect(probePlan("not a url")).toBeNull();
  });
});

describe("page signals", () => {
  const plan = { kind: "page" as const, page: "https://careers.example.com/job/1" };
  const res = (o: Partial<HttpResult>): HttpResult => ({ status: 200, finalUrl: plan.page, body: "<p>Responsibilities</p>", ...o });

  test("404 and 410 close; 403/429/5xx/202 are unknown", () => {
    expect(classifyPage(plan, res({ status: 404 })).state).toBe("closed");
    expect(classifyPage(plan, res({ status: 410 })).state).toBe("closed");
    for (const s of [202, 403, 429, 500, 503]) {
      expect(classifyPage(plan, res({ status: s })).state).toBe("unknown");
    }
  });

  test("an empty 200 is unknown, not open", () => {
    expect(classifyPage(plan, res({ body: "  " })).state).toBe("unknown");
  });

  test("known closed phrases close; ordinary JD prose does not", () => {
    expect(closedText("<h2>This job is no longer available.</h2>")).not.toBeNull();
    expect(closedText("<div>We are no longer accepting applications for this role</div>")).not.toBeNull();
    expect(closedText("<p>This position has been filled.</p>")).not.toBeNull();
    expect(closedText("<p>Sorry, the job posting has expired</p>")).not.toBeNull();
    expect(closedText("<p>The page you are looking for doesn't exist.</p>")).not.toBeNull();
    expect(closedText("<p>You will no longer be blocked by legacy tooling. Apply now.</p>")).toBeNull();
    expect(closedText("<p>Our filled calendar of events keeps interns busy.</p>")).toBeNull();
  });

  test("Avature redirect to search closes; a WAF 202 does not", () => {
    const av = { kind: "avature" as const, page: "https://acme.avature.net/careers/JobDetail?jobId=9" };
    expect(classifyPage(av, { status: 200, finalUrl: "https://acme.avature.net/careers/SearchJobs", body: "x" }).state).toBe("closed");
    expect(classifyPage(av, { status: 202, finalUrl: av.page, body: "" }).state).toBe("unknown");
    expect(classifyPage(av, { status: 200, finalUrl: "https://acme.avature.net/careers/Login", body: "<p>Sign in</p>" }).state).not.toBe("closed");
  });

  test("network failure is unknown", async () => {
    const boom: Fetcher = async () => {
      throw new Error("timeout");
    };
    expect((await checkLiveness("https://boards.greenhouse.io/x/jobs/1", boom)).state).toBe("unknown");
    expect((await checkLiveness("https://careers.example.com/job/1", boom)).state).toBe("unknown");
  });

  test("Greenhouse API 404 but the page forwards to the employer with gh_jid: not closed", async () => {
    const calls: Call[] = [
      { url: "https://boards-api.greenhouse.io/v1/boards/acme/jobs/55", status: 404, body: "{}" },
      { url: "https://boards.greenhouse.io/acme/jobs/55", status: 200, finalUrl: "https://acme.com/careers?gh_jid=55", body: "<p>Apply</p>" },
    ];
    const v = await checkLiveness("https://boards.greenhouse.io/acme/jobs/55", replay(calls).fetcher);
    expect(v.state).not.toBe("closed");
  });
});

describe("nextLiveness streak", () => {
  const url = "https://x.example/job/1";
  const closed = { state: "closed" as const, reason: "api-404" };
  const open = { state: "open" as const, reason: "ok" };
  const unknown = { state: "unknown" as const, reason: "http-503" };

  test(`needs ${CLOSED_CONFIRMATIONS} consecutive closed verdicts`, () => {
    const a = nextLiveness(undefined, url, closed, 1000);
    expect(a.record.closedAt).toBeUndefined();
    expect(a.dueAt).toBe(1000 + RECHECK_MS.closedPending);
    const b = nextLiveness(a.record, url, closed, 2000);
    expect(b.record.closedAt).toBe(2000);
    expect(isClosed(b.record, url)).toBe(true);
  });

  test("unknown breaks a pending streak (verdicts must be consecutive); open resets", () => {
    const a = nextLiveness(undefined, url, closed, 1);
    const b = nextLiveness(a.record, url, unknown, 2);
    expect(b.record.closedStreak).toBe(0);
    expect(nextLiveness(b.record, url, closed, 3).record.closedAt).toBeUndefined();
    const c = nextLiveness(a.record, url, open, 3);
    expect(c.record.closedStreak).toBe(0);
    const d = nextLiveness(c.record, url, closed, 4);
    expect(d.record.closedAt).toBeUndefined();
  });

  test("open after a closed mark reopens; unknown keeps the mark", () => {
    let r = nextLiveness(undefined, url, closed, 1).record;
    r = nextLiveness(r, url, closed, 2).record;
    expect(nextLiveness(r, url, unknown, 3).record.closedAt).toBe(2);
    expect(nextLiveness(r, url, open, 3).record.closedAt).toBeUndefined();
  });

  test("a changed URL starts a fresh streak and invalidates the mark", () => {
    let r = nextLiveness(undefined, url, closed, 1).record;
    r = nextLiveness(r, url, closed, 2).record;
    expect(isClosed(r, "https://x.example/job/2")).toBe(false);
    const fresh = nextLiveness(r, "https://x.example/job/2", closed, 3).record;
    expect(fresh.closedStreak).toBe(1);
    expect(fresh.closedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// claim / record mutations (convex-test, no network)
// ---------------------------------------------------------------------------


async function seed(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const mk = (short: string, item: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      ctx.db.insert("matches", {
        user: "u1",
        short,
        pushedAt: 0,
        item: { short, url: `https://boards.greenhouse.io/acme/jobs/${short.length}${short.charCodeAt(0)}`, ...item },
        ...extra,
      });
    const fresh = await mk("fresh", {});
    const appliedSnap = await mk("appliedsnap", { applied: true });
    const appliedTick = await mk("appliedtick", {});
    const hidden = await mk("hidden", {});
    const ledgered = await mk("ledgered", {});
    const notDue = await mk("notdue", {}, { livenessDueAt: 10_000_000 });
    const mailto = await mk("mailto", { url: "mailto:x@example.com" });
    await ctx.db.insert("ticks", { user: "u1", short: "appliedtick", applied: true, saved: false, dismissed: false, updatedAt: 0 });
    await ctx.db.insert("ticks", { user: "u1", short: "hidden", applied: false, saved: false, dismissed: true, updatedAt: 0 });
    await ctx.db.insert("applications", { user: "u1", short: "ledgered", status: "applied", history: [], createdAt: "2026-11-01" });
    return { fresh, appliedSnap, appliedTick, hidden, ledgered, notDue, mailto };
  });
}

describe("claimBatch / recordVerdict", () => {
  test("claims only visible, un-applied, due rows; skipped rows only get rotated", async () => {
    const t = convexTest(schema);
    const ids = await seed(t);
    const ledgerBefore = await t.run((ctx) => ctx.db.query("applications").collect());

    const claimed = await t.mutation(internal.liveness_probe.claimBatch, { now: 1000, limit: 10 });
    expect(claimed.map((c) => c.id)).toEqual([ids.fresh]);

    await t.run(async (ctx) => {
      for (const id of [ids.appliedSnap, ids.appliedTick, ids.hidden, ids.ledgered, ids.mailto]) {
        const row = await ctx.db.get(id);
        expect(row?.livenessDueAt).toBe(1000 + RECHECK_MS.skipped);
        expect(row?.liveness).toBeUndefined();
      }
      expect((await ctx.db.get(ids.notDue))?.livenessDueAt).toBe(10_000_000);
      // Ledger untouched.
      expect(await ctx.db.query("applications").collect()).toEqual(ledgerBefore);
    });

    // Leased: an overlapping run claims nothing.
    expect(await t.mutation(internal.liveness_probe.claimBatch, { now: 1001, limit: 10 })).toEqual([]);
  });

  test("two closed verdicts mark the row; getMatches exposes closed", async () => {
    const t = convexTest(schema);
    const ids = await seed(t);
    const [row] = await t.mutation(internal.liveness_probe.claimBatch, { now: 1000, limit: 1 });
    const rec = (now: number) =>
      t.mutation(internal.liveness_probe.recordVerdict, { id: row.id, url: row.url, state: "closed", reason: "api-404", now });

    expect(await rec(2000)).toEqual({ recorded: true, closed: false });
    let items = await t.query(api.tracker.getMatches, { user: "u1", secret: SECRET });
    expect(items.find((i: { short: string }) => i.short === "fresh")?.closed).toBeUndefined();

    expect(await rec(3000)).toEqual({ recorded: true, closed: true });
    items = await t.query(api.tracker.getMatches, { user: "u1", secret: SECRET });
    const fresh = items.find((i: { short: string }) => i.short === "fresh");
    expect(fresh?.closed).toBe(true);
    // Nothing else got a closed flag.
    expect(items.filter((i: { closed?: boolean }) => i.closed).length).toBe(1);
    expect(ids.fresh).toBe(row.id);
  });

  test("a row applied while its probe was in flight is not marked", async () => {
    const t = convexTest(schema);
    await seed(t);
    const [row] = await t.mutation(internal.liveness_probe.claimBatch, { now: 1000, limit: 1 });
    await t.mutation(internal.liveness_probe.recordVerdict, { id: row.id, url: row.url, state: "closed", reason: "x", now: 2000 });
    await t.mutation(api.tracker.setTicks, {
      user: "u1",
      secret: SECRET,
      writes: [{ short: "fresh", field: "applied", value: true }],
    });
    const res = await t.mutation(internal.liveness_probe.recordVerdict, { id: row.id, url: row.url, state: "closed", reason: "x", now: 3000 });
    expect(res).toEqual({ recorded: false, why: "applied" });
    const doc = await t.run((ctx) => ctx.db.get(row.id));
    expect(doc?.liveness?.closedAt).toBeUndefined();
  });

  test("a watcher push keeps the liveness record; a new URL drops the closed flag", async () => {
    const t = convexTest(schema);
    await seed(t);
    const [row] = await t.mutation(internal.liveness_probe.claimBatch, { now: 1000, limit: 1 });
    for (const now of [2000, 3000]) {
      await t.mutation(internal.liveness_probe.recordVerdict, { id: row.id, url: row.url, state: "closed", reason: "x", now });
    }
    await t.mutation(api.tracker.pushMatches, { user: "u1", secret: SECRET, items: [{ short: "fresh", url: row.url, title: "T" }] });
    let doc = await t.run((ctx) => ctx.db.get(row.id));
    expect(doc?.liveness?.closedAt).toBe(3000);

    await t.mutation(api.tracker.pushMatches, {
      user: "u1",
      secret: SECRET,
      items: [{ short: "fresh", url: "https://boards.greenhouse.io/acme/jobs/999", title: "T" }],
    });
    const items = await t.query(api.tracker.getMatches, { user: "u1", secret: SECRET });
    expect(items.find((i: { short: string }) => i.short === "fresh")?.closed).toBeUndefined();
    doc = await t.run((ctx) => ctx.db.get(row.id));
    expect(doc?.liveness?.url).toBe(row.url); // stale record kept, but not for this URL
  });

  test("rows written before the probe (no liveness fields) still validate and are claimed first", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert("matches", { user: "u2", short: "old", pushedAt: 0, item: { short: "old", url: "https://jobs.lever.co/acme/11111111-2222-3333-4444-555555555555" }, livenessDueAt: 500 });
      await ctx.db.insert("matches", { user: "u2", short: "legacy", pushedAt: 0, item: { short: "legacy", url: "https://jobs.lever.co/acme/aaaaaaaa-2222-3333-4444-555555555555" } });
    });
    const claimed = await t.mutation(internal.liveness_probe.claimBatch, { now: 1000, limit: 1 });
    const doc = await t.run((ctx) => ctx.db.get(claimed[0].id));
    expect(doc?.short).toBe("legacy");
  });
});
