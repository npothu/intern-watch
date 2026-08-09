import { beforeAll, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import * as mail from "./mail";
import { decryptJson } from "./credentials_crypto";

// Phase 1 tests for the mail-sync skeleton: account upsert, pending-action
// reads/resolution, and the /gmail/push HTTP doorbell. All tested against the
// in-memory convex-test backend, no deployment needed.

const SECRET = "test-tracker-secret";
const PUSH_TOKEN = "test-push-token";
const CRED_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="; // 32 bytes

beforeAll(() => {
  process.env.TRACKER_SECRET = SECRET;
  process.env.MAIL_PUSH_TOKEN = PUSH_TOKEN;
  // setMailAccount encrypts the refresh token before storing it.
  process.env.CREDENTIALS_KEY = CRED_KEY;
  // Mail-sync is opt-in; these two switch it on. Without them setMailAccount
  // refuses to store a token nothing could ever use.
  process.env.GMAIL_CLIENT_ID = "test-client-id";
  process.env.GMAIL_CLIENT_SECRET = "test-client-secret";
});

// Shared pending-action fixture. inboxActions has no public insert in Phase 1,
// so tests seed it via a direct t.run write.
const pendingAction = {
  user: "u1",
  gmailMessageId: "gm-123",
  threadId: "th-123",
  accountEmail: "a@example.com",
  from: "recruiter@acme.com",
  subject: "SWE Intern next steps",
  receivedAt: "2026-08-06T10:00:00Z",
  signal: "interview",
  evidence: "mentions HackerRank and a next step",
  source: "regex" as const,
  candidates: [{ short: "ab12cd34ef56", company: "Acme", title: "SWE Intern", score: 0.9 }],
  state: "pending" as const,
  createdAt: "2026-08-06T10:00:01Z",
};

// A valid Pub/Sub push envelope for `email`, with a base64-encoded payload.
function envelope(email: string): string {
  const payload = Buffer.from(
    JSON.stringify({ emailAddress: email, historyId: "123" }),
    "utf-8",
  ).toString("base64");
  return JSON.stringify({
    message: { data: payload, messageId: "m1" },
    subscription: "projects/test/subscriptions/gmail",
  });
}

// -- setMailAccount ---------------------------------------------------------

test("setMailAccount inserts then upserts, clearing lastError", async () => {
  const t = convexTest(schema);
  await t.action(mail.setMailAccount, {
    user: "u1",
    email: "a@example.com",
    refreshToken: "r1",
    secret: SECRET,
  });
  // Simulate a stale error on the row, then re-run the same upsert.
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("user", "u1"))
      .first();
    await ctx.db.patch(row!._id, { lastError: "boom", lastErrorAt: 123 });
  });
  await t.action(mail.setMailAccount, {
    user: "u1",
    email: "a@example.com",
    refreshToken: "r2",
    secret: SECRET,
  });
  const rows = await t.run(async (ctx) =>
    (await ctx.db.query("mailAccounts").collect()).map((r) => ({
      email: r.email,
      refreshToken: r.refreshToken,
      refreshTokenIv: r.refreshTokenIv,
      lastError: r.lastError,
      lastErrorAt: r.lastErrorAt,
    })),
  );
  // One row per user - the upsert patched in place rather than inserting.
  expect(rows).toHaveLength(1);
  expect(rows[0].email).toBe("a@example.com");
  expect(rows[0].lastError).toBeUndefined();
  expect(rows[0].lastErrorAt).toBeUndefined();

  // The token is at rest as ciphertext, not as the string we passed in. This
  // is the whole point of the change: a database dump must not hand over
  // silent, long-lived read access to someone's mailbox.
  expect(rows[0].refreshToken).not.toBe("r2");
  expect(rows[0].refreshTokenIv).toBeTruthy();
  await expect(
    decryptJson<string>(CRED_KEY, rows[0].refreshToken, rows[0].refreshTokenIv!),
  ).resolves.toBe("r2");
});

test("a legacy plaintext row is still readable, and is upgraded on the next write", async () => {
  // Rows written before encryption have no iv. Locking those users out of
  // their own mailbox would have been the worst possible migration, so the
  // read path tolerates them - see readRefreshToken in mail.ts.
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    await ctx.db.insert("mailAccounts", {
      user: "legacy",
      email: "old@example.com",
      refreshToken: "plaintext-token",
    });
  });
  const before = await t.run(async (ctx) =>
    ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("user", "legacy"))
      .first(),
  );
  expect(before?.refreshTokenIv).toBeUndefined();

  await t.action(mail.setMailAccount, {
    user: "legacy",
    email: "old@example.com",
    refreshToken: "rotated-token",
    secret: SECRET,
  });
  const after = await t.run(async (ctx) =>
    ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("user", "legacy"))
      .first(),
  );
  expect(after?.refreshTokenIv).toBeTruthy();
  await expect(
    decryptJson<string>(CRED_KEY, after!.refreshToken, after!.refreshTokenIv!),
  ).resolves.toBe("rotated-token");
});

// -- getActions -------------------------------------------------------------

test("getActions returns empty actions and null health for an unknown user", async () => {
  const t = convexTest(schema);
  const res = await t.query(mail.getActions, { user: "nobody", secret: SECRET });
  expect(res.actions).toEqual([]);
  expect(res.health).toBeNull();
});

test("getActions returns pending action + account health", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    await ctx.db.insert("mailAccounts", {
      user: "u1",
      email: "a@example.com",
      refreshToken: "r1",
      lastPushAt: 111,
      lastSyncAt: 222,
    });
    await ctx.db.insert("inboxActions", { ...pendingAction });
  });
  const res = await t.query(mail.getActions, { user: "u1", secret: SECRET });
  expect(res.health).toEqual(
    expect.objectContaining({
      email: "a@example.com",
      lastPushAt: 111,
      lastSyncAt: 222,
      lastError: null,
      lastErrorAt: null,
      watchExpiration: null,
      historyId: null,
    }),
  );
  expect(res.actions).toHaveLength(1);
  const [action] = res.actions;
  expect(action).toMatchObject({
    gmailMessageId: "gm-123",
    threadId: "th-123",
    accountEmail: "a@example.com",
    from: "recruiter@acme.com",
    subject: "SWE Intern next steps",
    signal: "interview",
    evidence: "mentions HackerRank and a next step",
    source: "regex",
  });
  expect(action.candidates).toEqual(pendingAction.candidates);
  expect(typeof action.id).toBe("string");
});

// -- resolveAction ----------------------------------------------------------

test("resolveAction resolves a pending action with a status", async () => {
  const t = convexTest(schema);
  const id = await t.run(async (ctx) => ctx.db.insert("inboxActions", { ...pendingAction }));
  await t.mutation(mail.resolveAction, {
    user: "u1",
    id,
    short: "ab12cd34ef56",
    status: "oa",
    secret: SECRET,
  });
  const row = await t.run(async (ctx) => ctx.db.get(id));
  expect(row!.state).toBe("resolved");
  expect(row!.resolution).toMatchObject({ short: "ab12cd34ef56", status: "oa" });
  expect(typeof row!.resolution!.at).toBe("string");
});

test("resolveAction dismisses a pending action", async () => {
  const t = convexTest(schema);
  const id = await t.run(async (ctx) => ctx.db.insert("inboxActions", { ...pendingAction }));
  await t.mutation(mail.resolveAction, { user: "u1", id, dismiss: true, secret: SECRET });
  const row = await t.run(async (ctx) => ctx.db.get(id));
  expect(row!.state).toBe("dismissed");
  expect(row!.resolution!.short).toBeUndefined();
  expect(row!.resolution!.status).toBeUndefined();
  expect(typeof row!.resolution!.at).toBe("string");
});

test("resolveAction rejects a bad status", async () => {
  const t = convexTest(schema);
  const id = await t.run(async (ctx) => ctx.db.insert("inboxActions", { ...pendingAction }));
  await expect(
    t.mutation(mail.resolveAction, {
      user: "u1",
      id,
      short: "ab12cd34ef56",
      status: "not-a-status",
      secret: SECRET,
    }),
  ).rejects.toThrow("bad status");
});

test("resolveAction rejects an action that is not the user's", async () => {
  const t = convexTest(schema);
  const id = await t.run(async (ctx) => ctx.db.insert("inboxActions", { ...pendingAction }));
  await expect(
    t.mutation(mail.resolveAction, {
      user: "intruder",
      id,
      short: "ab12cd34ef56",
      status: "oa",
      secret: SECRET,
    }),
  ).rejects.toThrow("not found");
});

test("resolveAction rejects an already-resolved action", async () => {
  const t = convexTest(schema);
  const id = await t.run(async (ctx) => ctx.db.insert("inboxActions", { ...pendingAction }));
  await t.mutation(mail.resolveAction, { user: "u1", id, dismiss: true, secret: SECRET });
  await expect(
    t.mutation(mail.resolveAction, {
      user: "u1",
      id,
      short: "ab12cd34ef56",
      status: "oa",
      secret: SECRET,
    }),
  ).rejects.toThrow("already resolved");
});

// -- bad secret -------------------------------------------------------------

test("bad secret throws for setMailAccount, getActions, resolveAction", async () => {
  const t = convexTest(schema);
  await expect(
    t.mutation(mail.setMailAccount, {
      user: "u1",
      email: "a@example.com",
      refreshToken: "r1",
      secret: "wrong",
    }),
  ).rejects.toThrow("bad secret");
  await expect(t.query(mail.getActions, { user: "u1", secret: "wrong" })).rejects.toThrow(
    "bad secret",
  );
  const id = await t.run(async (ctx) => ctx.db.insert("inboxActions", { ...pendingAction }));
  await expect(
    t.mutation(mail.resolveAction, {
      user: "u1",
      id,
      short: "ab12cd34ef56",
      status: "oa",
      secret: "wrong",
    }),
  ).rejects.toThrow("bad secret");
});

// -- /gmail/push HTTP route -------------------------------------------------

test("gmail push returns 403 on a bad token", async () => {
  const t = convexTest(schema);
  const res = await t.fetch("/gmail/push?token=wrong", {
    method: "POST",
    body: envelope("a@example.com"),
  });
  expect(res.status).toBe(403);
});

test("gmail push returns 204 and stamps lastPushAt on a good envelope", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    await ctx.db.insert("mailAccounts", {
      user: "u1",
      email: "a@example.com",
      refreshToken: "r1",
    });
  });
  const res = await t.fetch(`/gmail/push?token=${PUSH_TOKEN}`, {
    method: "POST",
    body: envelope("a@example.com"),
  });
  expect(res.status).toBe(204);
  const pushAt = await t.run(async (ctx) => {
    const row = await ctx.db
      .query("mailAccounts")
      .withIndex("by_email", (q) => q.eq("email", "a@example.com"))
      .first();
    return row?.lastPushAt ?? null;
  });
  expect(typeof pushAt).toBe("number");
});

test("gmail push returns 204 on a malformed body with a valid token", async () => {
  const t = convexTest(schema);
  const res = await t.fetch(`/gmail/push?token=${PUSH_TOKEN}`, {
    method: "POST",
    body: "this is not json",
  });
  expect(res.status).toBe(204);
});

test("gmail push returns 204 for an unconfigured account (no throw)", async () => {
  const t = convexTest(schema);
  const res = await t.fetch(`/gmail/push?token=${PUSH_TOKEN}`, {
    method: "POST",
    body: envelope("nobody@example.com"),
  });
  expect(res.status).toBe(204);
});
