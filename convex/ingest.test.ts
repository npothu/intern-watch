import { beforeAll, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import * as ingest from "./ingest";
import { canonicalUrl, validateUrl, detectAts, extractGeneric } from "./ingest_extract";

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
    const bigHtml = "a".repeat(300 * 1024) + `<script type="application/ld+json">{"@type":"JobPosting","title":"Big Intern","hiringOrganization":{"name":"BigCo"}}</script>`;
    const fetchMock = vi.fn(async () => new Response(bigHtml, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { runIngest } = await import("./ingest_node");
    await t.action(runIngest, { user: "u1", ingestId: req.ingestId as any });
    const row = await t.query(ingest.getIngestStatus, { user: "u1", ingestId: req.ingestId as any, secret: SECRET });
    // Should still succeed (truncated) and create a match
    expect(row?.status).toBe("done");
    vi.unstubAllGlobals();
  });
});
