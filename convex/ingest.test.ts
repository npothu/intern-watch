import { beforeAll, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import * as ingest from "./ingest";
import {
  canonicalUrl,
  validateUrl,
  detectAts,
  extractGeneric,
  companyFromUrl,
  inferTerm,
} from "./ingest_extract";

const SECRET = "test-tracker-secret";

beforeAll(() => {
  process.env.TRACKER_SECRET = SECRET;
});

// ---------------------------------------------------------------------------
// canonicalUrl
// ---------------------------------------------------------------------------
describe("ingest: canonicalUrl", () => {
  test("lowercases host, drops www., strips fragment and trailing slash", () => {
    expect(canonicalUrl("HTTPS://WWW.Example.COM/jobs/123/?utm_source=foo#section")).toBe(
      "https://example.com/jobs/123"
    );
  });
  test("strips utm_* and gh_* and tracking params, keeps others sorted", () => {
    const url = "https://example.com/job?b=2&utm_medium=email&gh_src=123&a=1&ref=abc&keep=yes";
    // keep=b? Actually tracking keys: gh_src, ref, utm_medium - should be stripped, keep a, b, keep
    expect(canonicalUrl(url)).toBe("https://example.com/job?a=1&b=2&keep=yes");
  });
  test("strips gh_jid etc and fragment", () => {
    expect(canonicalUrl("https://example.com/job?gh_jid=123&x=1#frag")).toBe(
      "https://example.com/job?x=1"
    );
  });
  test("handles trailing slash on root vs path", () => {
    expect(canonicalUrl("https://example.com/")).toBe("https://example.com/");
    expect(canonicalUrl("https://example.com/jobs/")).toBe("https://example.com/jobs");
  });
  test("drops www and lowercases host", () => {
    expect(canonicalUrl("https://www.JOBS.example.COM/Role")).toBe("https://jobs.example.com/Role");
  });
});

// ---------------------------------------------------------------------------
// validateUrl
// ---------------------------------------------------------------------------
describe("ingest: validateUrl", () => {
  test("accepts valid https url with dot host", () => {
    expect(() => validateUrl("https://example.com/job/123")).not.toThrow();
    expect(() => validateUrl("https://jobs.lever.co/company/abc")).not.toThrow();
  });
  test("blocks localhost", () => {
    expect(() => validateUrl("http://localhost/job")).toThrow(/localhost/);
    expect(() => validateUrl("http://127.0.0.1/job")).toThrow(/private/);
  });
  test("blocks private IPs", () => {
    expect(() => validateUrl("http://10.0.0.1/job")).toThrow(/private/);
    expect(() => validateUrl("http://192.168.1.5/job")).toThrow(/private/);
    expect(() => validateUrl("http://172.20.5.1/job")).toThrow(/private/);
  });
  test("blocks file://", () => {
    expect(() => validateUrl("file:///etc/passwd")).toThrow(/file/);
  });
  test("blocks no-dot host", () => {
    expect(() => validateUrl("https://intranet/job")).toThrow(/dot/);
  });
  test("blocks non-http scheme", () => {
    expect(() => validateUrl("ftp://example.com/file")).toThrow(/http/);
  });
});

// ---------------------------------------------------------------------------
// requestIngest duplicate detection
// ---------------------------------------------------------------------------
describe("ingest: requestIngest", () => {
  test("creates fetching row and returns short", async () => {
    const t = convexTest(schema);
    const res = await t.mutation(ingest.requestIngest, {
      user: "u1",
      url: "https://example.com/jobs/123",
      secret: SECRET,
    });
    expect(res.status).toBe("fetching");
    expect(typeof res.ingestId).toBe("string");
    expect(typeof res.short).toBe("string");
    expect(res.short).toHaveLength(12);
    const row = await t.query(ingest.getIngestStatus, { user: "u1", ingestId: res.ingestId as any, secret: SECRET });
    expect(row?.status).toBe("fetching");
    expect(row?.canonicalUrl).toBe(canonicalUrl("https://example.com/jobs/123"));
  });

  test("duplicate via same canonical url returns already_exists with same short", async () => {
    const t = convexTest(schema);
    const url = "https://example.com/jobs/123?utm_source=foo";
    const first = await t.mutation(ingest.requestIngest, { user: "u1", url, secret: SECRET });
    // second request with normalized same url (tracking params stripped) should dedup
    const second = await t.mutation(ingest.requestIngest, {
      user: "u1",
      url: "https://example.com/jobs/123?utm_campaign=bar",
      secret: SECRET,
    });
    expect(second.status).toBe("already_exists");
    expect(second.short).toBe(first.short);
    expect(second.ingestId).toBe(first.ingestId);
  });

  test("duplicate via existing match (by short) returns already_exists", async () => {
    const t = convexTest(schema);
    const canonical = canonicalUrl("https://example.com/jobs/456");
    const { short, dedupKey } = ingest.dedupInfoForUrl(canonical);
    // Seed a match row with same short
    await t.run(async (ctx) => {
      await ctx.db.insert("matches", {
        user: "u1",
        short,
        item: { url: "https://example.com/jobs/456", key: dedupKey, company: "Acme", title: "Intern" },
        pushedAt: Date.now(),
      });
    });
    const res = await t.mutation(ingest.requestIngest, {
      user: "u1",
      url: "https://example.com/jobs/456",
      secret: SECRET,
    });
    expect(res.status).toBe("already_exists");
    expect(res.short).toBe(short);
  });

  test("duplicate via existing match canonical url returns already_exists", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert("matches", {
        user: "u1",
        short: "abc123456789",
        item: { url: "https://example.com/jobs/789?keep=1", key: "manual:xxx", company: "Beta", title: "SWE" },
        pushedAt: Date.now(),
      });
    });
    // Same canonical (keep param, but with tracking added)
    const res = await t.mutation(ingest.requestIngest, {
      user: "u1",
      url: "https://example.com/jobs/789?keep=1&utm_source=x",
      secret: SECRET,
    });
    expect(res.status).toBe("already_exists");
    expect(res.short).toBe("abc123456789");
  });

  test("different user not considered duplicate", async () => {
    const t = convexTest(schema);
    const url = "https://example.com/jobs/999";
    const first = await t.mutation(ingest.requestIngest, { user: "u1", url, secret: SECRET });
    const second = await t.mutation(ingest.requestIngest, { user: "u2", url, secret: SECRET });
    expect(first.status).toBe("fetching");
    expect(second.status).toBe("fetching");
    expect(first.ingestId).not.toBe(second.ingestId);
  });

  test("bad secret throws", async () => {
    const t = convexTest(schema);
    await expect(
      t.mutation(ingest.requestIngest, { user: "u1", url: "https://example.com/j", secret: "wrong" })
    ).rejects.toThrow("bad secret");
  });

  test("invalid url throws", async () => {
    const t = convexTest(schema);
    await expect(
      t.mutation(ingest.requestIngest, { user: "u1", url: "http://localhost/job", secret: SECRET })
    ).rejects.toThrow();
    await expect(
      t.mutation(ingest.requestIngest, { user: "u1", url: "file:///etc/passwd", secret: SECRET })
    ).rejects.toThrow();
  });

  test("getIngestStatus returns null for wrong user", async () => {
    const t = convexTest(schema);
    const res = await t.mutation(ingest.requestIngest, { user: "u1", url: "https://example.com/jobs/a", secret: SECRET });
    const status = await t.query(ingest.getIngestStatus, { user: "u2", ingestId: res.ingestId as any, secret: SECRET });
    expect(status).toBeNull();
  });

  test("dedupInfoForUrl uses jr: for jobright urls", async () => {
    const canonical = canonicalUrl("https://jobright.ai/jobs/info/abcdef1234567890abcdef12");
    const info = ingest.dedupInfoForUrl(canonical);
    expect(info.dedupKey).toBe("jr:abcdef1234567890abcdef12");
    expect(info.short).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------------
// extractGeneric
// ---------------------------------------------------------------------------
describe("ingest_extract: extractGeneric", () => {
  test("extracts from ld+json JobPosting", () => {
    const html = `
      <html><head>
      <script type="application/ld+json">
      {"@type":"JobPosting","title":"Software Intern","hiringOrganization":{"name":"Acme Corp"},"jobLocation":{"address":{"addressLocality":"San Francisco","addressRegion":"CA"}}}
      </script>
      </head><body><h1>Software Intern</h1></body></html>
    `;
    const ex = extractGeneric(html, "https://example.com/job");
    expect(ex.title).toBe("Software Intern");
    expect(ex.company).toBe("Acme Corp");
    expect(ex.location).toBe("San Francisco, CA");
  });
  test("falls back to og:title / h1 / host", () => {
    const html = `<html><head><meta property="og:title" content="Data Intern at Beta Inc"><meta property="og:site_name" content="Beta Inc"></head><body><h1>Data Intern at Beta Inc</h1></body></html>`;
    const ex = extractGeneric(html, "https://jobs.example.com/123");
    expect(ex.title).toBe("Data Intern at Beta Inc");
    expect(ex.company).toBe("Beta Inc");
  });
});

describe("ingest_extract: detectAts", () => {
  test("detects greenhouse, lever, etc", () => {
    expect(detectAts("boards.greenhouse.io")).toBe("greenhouse");
    expect(detectAts("jobs.lever.co")).toBe("lever");
    expect(detectAts("example.com")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runIngest (mock fetch)
// ---------------------------------------------------------------------------
describe("ingest: runIngest", () => {
  test("fetches, extracts, upserts match and marks done", async () => {
    const t = convexTest(schema);
    // Create a pending ingest via requestIngest (which schedules runIngest, but we will manually invoke)
    const req = await t.mutation(ingest.requestIngest, {
      user: "u1",
      url: "https://example.com/jobs/555",
      secret: SECRET,
    });
    const ingestId = req.ingestId as any;

    const html = `
      <html><head>
      <script type="application/ld+json">
      {"@type":"JobPosting","title":"ML Intern","hiringOrganization":{"name":"Gamma LLC"},"jobLocation":{"address":"Remote"}}
      </script>
      <title>ML Intern - Gamma</title>
      </head><body>Great role</body></html>
    `;
    const fetchMock = vi.fn(async () =>
      new Response(html, { status: 200, headers: { "Content-Type": "text/html" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    // Directly run the node action (bypassing scheduler)
    const { runIngest } = await import("./ingest_node");
    await t.action(runIngest, { user: "u1", ingestId });

    const row = await t.query(ingest.getIngestStatus, { user: "u1", ingestId, secret: SECRET });
    expect(row?.status).toBe("done");
    expect(row?.dedupKey).toBeTruthy();

    const matches = await t.run(async (ctx) => ctx.db.query("matches").collect());
    expect(matches).toHaveLength(1);
    expect(matches[0].short).toBe(req.short);
    expect(matches[0].item.company).toBe("Gamma LLC");
    expect(matches[0].item.title).toBe("ML Intern");
    expect(matches[0].item.url).toBe(canonicalUrl("https://example.com/jobs/555"));
    expect(matches[0].item.source).toBe("manual");
    expect(matches[0].item.tag).toBe("[MANUAL]");

    vi.unstubAllGlobals();
  });

  test("fetch failure marks ingest as failed with truncated error", async () => {
    const t = convexTest(schema);
    const req = await t.mutation(ingest.requestIngest, {
      user: "u1",
      url: "https://example.com/jobs/fail",
      secret: SECRET,
    });
    const ingestId = req.ingestId as any;
    const fetchMock = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const { runIngest } = await import("./ingest_node");
    await t.action(runIngest, { user: "u1", ingestId });

    const row = await t.query(ingest.getIngestStatus, { user: "u1", ingestId, secret: SECRET });
    expect(row?.status).toBe("failed");
    expect(row?.error).toBeTruthy();
    expect(row!.error!.length).toBeLessThanOrEqual(300);

    vi.unstubAllGlobals();
  });

  test("200KB cap: large body is truncated", async () => {
    const t = convexTest(schema);
    const req = await t.mutation(ingest.requestIngest, {
      user: "u1",
      url: "https://example.com/jobs/big",
      secret: SECRET,
    });
    // Job data inside the cap, padding past it: the body is truncated and the
    // match is still extracted. (Previously this fixture put the ld+json after
    // the padding, so truncation dropped it and the test only passed because a
    // titleless page was given the placeholder title "Manual Ingest" - the
    // junk-row behaviour that is now a hard failure instead.)
    const bigHtml =
      `<script type="application/ld+json">{"@type":"JobPosting","title":"Big Intern","hiringOrganization":{"name":"BigCo"}}</script>` +
      "a".repeat(300 * 1024);
    const fetchMock = vi.fn(async () => new Response(bigHtml, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { runIngest } = await import("./ingest_node");
    await t.action(runIngest, { user: "u1", ingestId: req.ingestId as any });
    const row = await t.query(ingest.getIngestStatus, { user: "u1", ingestId: req.ingestId as any, secret: SECRET });
    expect(row?.status).toBe("done");
    const match = await t.run(async (ctx) => await ctx.db.query("matches").first());
    expect(match?.item?.title).toBe("Big Intern");
    vi.unstubAllGlobals();
  });

  test("200KB cap: job data beyond the cap fails rather than inventing a row", async () => {
    const t = convexTest(schema);
    const req = await t.mutation(ingest.requestIngest, {
      user: "u1",
      url: "https://example.com/jobs/big-late",
      secret: SECRET,
    });
    const lateHtml =
      "a".repeat(300 * 1024) +
      `<script type="application/ld+json">{"@type":"JobPosting","title":"Late Intern","hiringOrganization":{"name":"LateCo"}}</script>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(lateHtml, { status: 200 })));
    const { runIngest } = await import("./ingest_node");
    await t.action(runIngest, { user: "u1", ingestId: req.ingestId as any });
    const row = await t.query(ingest.getIngestStatus, { user: "u1", ingestId: req.ingestId as any, secret: SECRET });
    expect(row?.status).toBe("failed");
    const matches = await t.run(async (ctx) => await ctx.db.query("matches").collect());
    expect(matches).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// Regressions found while testing manual ingest against real job URLs
// ---------------------------------------------------------------------------
describe("regressions from live ingest testing", () => {
  test("a jobright employer link derives the same jr: key the watcher would", () => {
    // canonicalUrl strips jr_id as tracking, so the id has to be read from the
    // raw URL or this link never matches the watcher's row for the same job.
    const raw =
      "https://jobs.ashbyhq.com/terranova/a8e5a8d2-4af3-4736-b66e-e0804447f7a0/application?utm_source=jobright&jr_id=6a75372837da8525e8cdcbb9";
    const canonical = canonicalUrl(raw);
    expect(canonical).not.toContain("jr_id");

    const viaRaw = ingest.dedupInfoForUrl(canonical, raw);
    expect(viaRaw.dedupKey).toBe("jr:6a75372837da8525e8cdcbb9");

    // ...and that must equal what the jobright.ai permalink for the same job
    // derives, so the two routes to one job collapse to a single row.
    const permalink = "https://jobright.ai/jobs/info/6a75372837da8525e8cdcbb9";
    const viaPermalink = ingest.dedupInfoForUrl(canonicalUrl(permalink), permalink);
    expect(viaPermalink.short).toBe(viaRaw.short);
  });

  test("employer name comes from the URL on shared boards, not the hostname", () => {
    expect(
      companyFromUrl(
        "https://job-boards.greenhouse.io/embed/job_app?for=flyzipline&token=7787868003"
      )
    ).toBe("Flyzipline");
    expect(
      companyFromUrl("https://jobs.ashbyhq.com/ramp/67fadb77-43d8-4449-954b-d4cf2c6d3b8b/application")
    ).toBe("Ramp");
  });

  test("employer is read from the <title> 'at <employer>' phrase", () => {
    // Greenhouse puts the role in <h1> and "<role> at <employer>" in <title>.
    const html =
      "<title>Job Application for Maps Intern (Fall 2026) at Zipline </title>" +
      "<h1>Maps Intern (Fall 2026)</h1>";
    const out = extractGeneric(
      html,
      "https://job-boards.greenhouse.io/embed/job_app?for=flyzipline"
    );
    expect(out.company).toBe("Zipline");
    expect(out.title).toBe("Maps Intern (Fall 2026)");
  });

  test("term is inferred from a title that spells it out", () => {
    expect(inferTerm("Maps Intern (Fall 2026)")).toBe("Fall 2026");
    expect(inferTerm("SWE Intern - Summer 2027")).toBe("Summer 2027");
    expect(inferTerm("Software Engineering Intern")).toBe("");
  });

  test("a 2xx response with an empty body fails instead of creating a row", async () => {
    // Avature answers automated requests with HTTP 202 and no body.
    const t = convexTest(schema);
    const req = await t.mutation(ingest.requestIngest, {
      user: "u1",
      url: "https://careers.example.com/en_US/careers/JobDetail?jobId=1",
      secret: SECRET,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 202 })));
    const { runIngest } = await import("./ingest_node");
    await t.action(runIngest, { user: "u1", ingestId: req.ingestId as any });
    const row = await t.query(ingest.getIngestStatus, {
      user: "u1",
      ingestId: req.ingestId as any,
      secret: SECRET,
    });
    expect(row?.status).toBe("failed");
    expect(row?.error).toMatch(/empty response/i);

    const matches = await t.run(async (ctx) => await ctx.db.query("matches").collect());
    expect(matches).toHaveLength(0);
    vi.unstubAllGlobals();
  });
});

describe("manual rows survive the watcher's snapshot prune", () => {
  test("pruneMatches keeps manual rows it was never told about", async () => {
    const t = convexTest(schema);
    // One watcher row and one hand-added row.
    await t.run(async (ctx) => {
      await ctx.db.insert("matches", {
        user: "u1",
        short: "watcher00001",
        item: { key: "jr:aaa", title: "Watcher Job" },
        pushedAt: Date.now(),
      });
      await ctx.db.insert("matches", {
        user: "u1",
        short: "manual000001",
        item: { key: "manual:bbb", title: "Hand Added", source: "manual" },
        pushedAt: Date.now(),
      });
    });

    // The watcher prunes to its own snapshot, which cannot mention the manual
    // row - it only exists in Convex, never in the run state.
    const tracker = await import("./tracker");
    await t.mutation(tracker.pruneMatches, {
      user: "u1",
      keep: ["watcher00001"],
      secret: SECRET,
    });

    const left = await t.run(async (ctx) =>
      await ctx.db.query("matches").collect()
    );
    const shorts = left.map((r) => r.short).sort();
    expect(shorts).toEqual(["manual000001", "watcher00001"]);
  });

  test("pruneMatches still deletes stale watcher rows", async () => {
    const t = convexTest(schema);
    await t.run(async (ctx) => {
      await ctx.db.insert("matches", {
        user: "u1",
        short: "stale0000001",
        item: { key: "jr:ccc", title: "Gone" },
        pushedAt: Date.now(),
      });
    });
    const tracker = await import("./tracker");
    await t.mutation(tracker.pruneMatches, { user: "u1", keep: [], secret: SECRET });
    const left = await t.run(async (ctx) => await ctx.db.query("matches").collect());
    expect(left).toHaveLength(0);
  });
});
