import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import * as mail from "./mail";

// Phase 2 tests for the Gmail API plumbing: token refresh, watch arm, sync
// (history / full-sync fallback), the recordOutcome idempotency barrier, and
// monotonic cursor advancement. All Gmail/OAuth HTTP is stubbed via
// vi.stubGlobal("fetch", ...) with small canned fixtures - convex-test runs
// actions in-process, so the stub is visible to `fetch` in the actions.

const SECRET = "test-tracker-secret";

beforeAll(() => {
  process.env.TRACKER_SECRET = SECRET;
  process.env.GMAIL_CLIENT_ID = "client-id";
  process.env.GMAIL_CLIENT_SECRET = "client-secret";
  process.env.MAIL_PUBSUB_TOPIC = "projects/p/topics/gmail";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// -- fixtures ----------------------------------------------------------------

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function okJson(json: unknown): Response {
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errStatus(status: number, json?: unknown): Response {
  return new Response(json ? JSON.stringify(json) : "", { status });
}

// A messages.get/full Gmail message: From/Subject/Date/Message-ID headers plus
// a multipart payload preferring text/plain over text/html.
function gmailMessage(
  id: string,
  threadId: string,
  from: string,
  subject: string,
  date: string,
  messageId: string,
): unknown {
  return {
    id,
    threadId,
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: from },
        { name: "Subject", value: subject },
        { name: "Date", value: date },
        { name: "Message-ID", value: messageId },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: b64url("recruiter here, apply") } },
        { mimeType: "text/html", body: { data: b64url("<p>recruiter here</p>") } },
      ],
    },
  };
}

async function seedAccount(t: Awaited<ReturnType<typeof convexTest>>, fields?: Record<string, unknown>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("mailAccounts", {
      user: "u1",
      email: "a@example.com",
      refreshToken: "r1",
      ...fields,
    });
  });
}

async function getAccountRow(t: Awaited<ReturnType<typeof convexTest>>, user = "u1") {
  return t.run(async (ctx) =>
    ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("user", user))
      .first(),
  );
}

// Type helper for the fetch router: dispatches on the URL substring.
type Router = (url: string) => Response | Promise<Response>;

function stubFetch(router: Router) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => router(String(input))),
  );
}

// A full happy-path router: token refresh, history list, one message get.
function happyRouter(message = gmailMessage("gm1", "th-1", "r@acme.com", "SWE Intern", "2026-08-05T00:00:00Z", "msg-1")): Router {
  return async (url) => {
    if (url.includes("/token")) return okJson({ access_token: "tok", expires_in: 3600 });
    if (url.includes("/history")) return okJson({ history: [{ id: 200, messages: [{ id: "gm1" }] }] });
    if (url.includes("/messages/")) return okJson(message);
    throw new Error(`unexpected url: ${url}`);
  };
}

// -- sync happy path ---------------------------------------------------------

test("sync happy path: one history page -> messages.get -> recordOutcome, cursor advanced", async () => {
  const t = convexTest(schema);
  await seedAccount(t, { historyId: "100" });
  stubFetch(happyRouter());

  await t.action(mail.sync, { user: "u1" });

  const rows = await t.run(async (ctx) => ctx.db.query("mailMessages").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    user: "u1",
    gmailMessageId: "gm1",
    threadId: "th-1",
    outcome: "ignored",
  });
  const account = await getAccountRow(t);
  expect(account!.historyId).toBe("200");
  expect(typeof account!.lastSyncAt).toBe("number");
  expect(account!.lastError).toBeUndefined();
});

test("sync double delivery: same message recorded once (idempotency barrier)", async () => {
  const t = convexTest(schema);
  await seedAccount(t, { historyId: "100" });
  stubFetch(happyRouter());

  await t.action(mail.sync, { user: "u1" });
  await t.action(mail.sync, { user: "u1" });

  const rows = await t.run(async (ctx) => ctx.db.query("mailMessages").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0].gmailMessageId).toBe("gm1");
});

test("sync history.list 404 -> full-sync fallback (messages.list + profile re-anchor)", async () => {
  const t = convexTest(schema);
  await seedAccount(t, { historyId: "99" });
  const message = gmailMessage("gm2", "th-2", "hr@bigco.com", "Interview", "2026-08-04T00:00:00Z", "msg-2");
  stubFetch(async (url) => {
    if (url.includes("/token")) return okJson({ access_token: "tok", expires_in: 3600 });
    if (url.includes("/history")) return errStatus(404);
    if (url.includes("/messages?q=")) return okJson({ messages: [{ id: "gm2" }] });
    if (url.includes("/profile")) return okJson({ historyId: 5000 });
    if (url.includes("/messages/")) return okJson(message);
    throw new Error(`unexpected url: ${url}`);
  });

  await t.action(mail.sync, { user: "u1" });

  const rows = await t.run(async (ctx) => ctx.db.query("mailMessages").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0].gmailMessageId).toBe("gm2");
  const account = await getAccountRow(t);
  expect(account!.historyId).toBe("5000");
  expect(typeof account!.lastSyncAt).toBe("number");
  expect(account!.lastError).toBeUndefined();
});

test("sync with no stored cursor uses full-sync path and anchors from profile", async () => {
  const t = convexTest(schema);
  await seedAccount(t, {}); // no historyId yet
  const message = gmailMessage("gm3", "th-3", "talent@devx.com", "Apply", "2026-08-03T00:00:00Z", "msg-3");
  stubFetch(async (url) => {
    if (url.includes("/token")) return okJson({ access_token: "tok", expires_in: 3600 });
    if (url.includes("/messages?q=")) return okJson({ messages: [{ id: "gm3" }] });
    if (url.includes("/profile")) return okJson({ historyId: 2615129026 });
    if (url.includes("/messages/")) return okJson(message);
    throw new Error(`unexpected url: ${url}`);
  });

  await t.action(mail.sync, { user: "u1" });

  const rows = await t.run(async (ctx) => ctx.db.query("mailMessages").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0].gmailMessageId).toBe("gm3");
  const account = await getAccountRow(t);
  expect(account!.historyId).toBe("2615129026");
});

test("sync token refresh failure stamps lastError and does not throw", async () => {
  const t = convexTest(schema);
  await seedAccount(t, { historyId: "100" });
  stubFetch(async (url) => {
    if (url.includes("/token"))
      return errStatus(400, { error: "invalid_grant", error_description: "Token has been revoked" });
    throw new Error(`unexpected url: ${url}`);
  });

  // The action should swallow the failure (no crash-loop), not reject.
  await t.action(mail.sync, { user: "u1" });

  const account = await getAccountRow(t);
  expect(account!.lastError).toContain("invalid_grant");
  expect(typeof account!.lastErrorAt).toBe("number");
  expect(account!.lastSyncAt).toBeUndefined();
  const rows = await t.run(async (ctx) => ctx.db.query("mailMessages").collect());
  expect(rows).toHaveLength(0);
});

// -- recordOutcome idempotency ----------------------------------------------

test("recordOutcome second call with the same gmailMessageId is a no-op", async () => {
  const t = convexTest(schema);
  const args = {
    user: "u1",
    gmailMessageId: "gm1",
    threadId: "th-1",
    headers: { from: "r@acme.com", subject: "SWE Intern", date: "2026-08-05T00:00:00Z", messageId: "msg-1" },
    accountEmail: "a@example.com",
  };
  await t.mutation(mail.recordOutcome, args);
  await t.mutation(mail.recordOutcome, args);

  const rows = await t.run(async (ctx) => ctx.db.query("mailMessages").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ user: "u1", gmailMessageId: "gm1", threadId: "th-1", outcome: "ignored" });
});

// -- monotonic historyId ----------------------------------------------------

test("monotonic historyId: a stale sync result never regresses the cursor", async () => {
  const t = convexTest(schema);
  await seedAccount(t, { historyId: "2000" });
  stubFetch(async (url) => {
    if (url.includes("/token")) return okJson({ access_token: "tok", expires_in: 3600 });
    if (url.includes("/history")) return okJson({ history: [{ id: 1900, messages: [] }] });
    throw new Error(`unexpected url: ${url}`);
  });

  await t.action(mail.sync, { user: "u1" });

  const account = await getAccountRow(t);
  expect(account!.historyId).toBe("2000"); // never regressed below 2000
  expect(typeof account!.lastSyncAt).toBe("number");
  expect(account!.lastError).toBeUndefined();
});

test("history ids as strings + top-level historyId advance the cursor (real API shape)", async () => {
  // Gmail serializes history ids as strings (uint64) and history.list carries
  // the current mailbox cursor as a top-level historyId; a number-only reader
  // would leave the cursor pinned forever.
  const t = convexTest(schema);
  await seedAccount(t, { historyId: "100" });
  stubFetch(async (url) => {
    if (url.includes("/token")) return okJson({ access_token: "tok", expires_in: 3600 });
    if (url.includes("/history"))
      return okJson({
        historyId: "2615129099",
        history: [{ id: "205", messages: [{ id: "gm1" }] }],
      });
    if (url.includes("/messages/"))
      return okJson(gmailMessage("gm1", "th-1", "r@acme.com", "SWE Intern",
                                 "2026-08-05T00:00:00Z", "msg-1"));
    throw new Error(`unexpected url: ${url}`);
  });

  await t.action(mail.sync, { user: "u1" });

  const account = await getAccountRow(t);
  expect(account!.historyId).toBe("2615129099");
  const rows = await t.run(async (ctx) => ctx.db.query("mailMessages").collect());
  expect(rows).toHaveLength(1);
});

// -- startWatch -------------------------------------------------------------

test("startWatch stores expiration and anchors historyId when unset", async () => {
  const t = convexTest(schema);
  await seedAccount(t, {}); // no historyId
  stubFetch(async (url) => {
    if (url.includes("/token")) return okJson({ access_token: "tok", expires_in: 3600 });
    if (url.includes("/watch")) return okJson({ expiration: 1789200000000, historyId: "777" });
    throw new Error(`unexpected url: ${url}`);
  });

  await t.action(mail.startWatch, { user: "u1" });

  const account = await getAccountRow(t);
  expect(account!.watchExpiration).toBe(1789200000000);
  expect(account!.historyId).toBe("777");
  expect(account!.lastError).toBeUndefined();
});

test("startWatch does not overwrite an existing historyId", async () => {
  const t = convexTest(schema);
  await seedAccount(t, { historyId: "old" });
  stubFetch(async (url) => {
    if (url.includes("/token")) return okJson({ access_token: "tok", expires_in: 3600 });
    if (url.includes("/watch")) return okJson({ expiration: 1789200000000, historyId: "new" });
    throw new Error(`unexpected url: ${url}`);
  });

  await t.action(mail.startWatch, { user: "u1" });

  const account = await getAccountRow(t);
  expect(account!.historyId).toBe("old"); // anchor only when unset
  expect(account!.watchExpiration).toBe(1789200000000);
});