import { beforeAll, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
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

// -- OAuth readiness --------------------------------------------------------

test("getOAuthConfig requires the complete operator-managed mail setup", async () => {
  const t = convexTest(schema);
  const previousTopic = process.env.MAIL_PUBSUB_TOPIC;
  const previousToken = process.env.MAIL_PUSH_TOKEN;
  delete process.env.MAIL_PUBSUB_TOPIC;
  delete process.env.MAIL_PUSH_TOKEN;

  try {
    const incomplete = await t.query(api.mail.getOAuthConfig, { secret: SECRET });
    expect(incomplete.missing).toEqual(
      expect.arrayContaining(["MAIL_PUBSUB_TOPIC", "MAIL_PUSH_TOKEN"]),
    );

    process.env.MAIL_PUBSUB_TOPIC = "projects/test/topics/gmail";
    process.env.MAIL_PUSH_TOKEN = PUSH_TOKEN;
    const ready = await t.query(api.mail.getOAuthConfig, { secret: SECRET });
    expect(ready.missing).toEqual([]);
  } finally {
    if (previousTopic === undefined) delete process.env.MAIL_PUBSUB_TOPIC;
    else process.env.MAIL_PUBSUB_TOPIC = previousTopic;
    if (previousToken === undefined) delete process.env.MAIL_PUSH_TOKEN;
    else process.env.MAIL_PUSH_TOKEN = previousToken;
  }
});

// -- setMailAccount ---------------------------------------------------------

test("setMailAccount inserts then upserts, clearing lastError", async () => {
  const t = convexTest(schema);
  await t.action(api.mail.setMailAccount, {
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
  await t.action(api.mail.setMailAccount, {
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

  await t.action(api.mail.setMailAccount, {
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
  const res = await t.query(api.mail.getActions, { user: "nobody", secret: SECRET });
  expect(res.actions).toEqual([]);
  expect(res.applications).toEqual([]);
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
    await ctx.db.insert("applications", {
      user: "u1", short: pendingAction.candidates[0].short, status: "applied",
      snapshot: pendingAction.candidates[0], history: [], createdAt: "2026-08-06",
    });
    await ctx.db.insert("inboxActions", { ...pendingAction });
  });
  const res = await t.query(api.mail.getActions, { user: "u1", secret: SECRET });
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
  expect(action.candidates).toEqual([expect.objectContaining({
    short: "ab12cd34ef56", company: "Acme", title: "SWE Intern",
  })]);
  expect(res.applications).toEqual([
    expect.objectContaining({
      short: "ab12cd34ef56",
      company: "Acme",
      title: "SWE Intern",
      status: "applied",
    }),
  ]);
  expect(typeof action.id).toBe("string");
});

test("getActions exposes the full application catalog, including unsuggested rows", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    await ctx.db.insert("applications", {
      user: "u1",
      short: "111111111111",
      status: "applied",
      snapshot: { company: "Acme", title: "SWE Intern", location: "Austin", url: "https://acme.test/1" },
      history: [],
      createdAt: "2026-08-01",
    });
    await ctx.db.insert("applications", {
      user: "u1",
      short: "222222222222",
      status: "phone_screen",
      snapshot: { company: "Quiet Co", title: "Data Intern", location: "Remote", url: "https://quiet.test/2" },
      history: [],
      createdAt: "2026-08-02",
    });
    await ctx.db.insert("applications", {
      user: "other",
      short: "333333333333",
      status: "applied",
      snapshot: { company: "Private Co", title: "Hidden" },
      history: [],
      createdAt: "2026-08-03",
    });
    await ctx.db.insert("inboxActions", { ...pendingAction, candidates: [] });
  });

  const res = await t.query(api.mail.getActions, { user: "u1", secret: SECRET });
  expect(res.applications).toEqual([
    expect.objectContaining({ short: "111111111111", company: "Acme", location: "Austin" }),
    expect.objectContaining({ short: "222222222222", company: "Quiet Co", status: "phone_screen" }),
  ]);
  expect(res.applications).not.toContainEqual(expect.objectContaining({ company: "Private Co" }));
  expect(res.actions[0].candidates).toHaveLength(1);
});

// -- resolveAction ----------------------------------------------------------

test("resolveAction resolves a pending action with a status", async () => {
  const t = convexTest(schema);
  const id = await t.run(async (ctx) => {
    await ctx.db.insert("applications", {
      user: "u1", short: "ab12cd34ef56", status: "applied",
      snapshot: pendingAction.candidates[0], history: [], createdAt: "2026-08-06",
    });
    return ctx.db.insert("inboxActions", { ...pendingAction });
  });
  await t.mutation(api.mail.resolveAction, {
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

test("resolveAction atomically creates a manual application for the email", async () => {
  const t = convexTest(schema);
  const id = await t.run(async (ctx) => ctx.db.insert("inboxActions", { ...pendingAction }));
  const requestId = "bd55d9f9-8d9a-46e0-a9aa-b086772d9520";

  const result = await t.mutation(api.mail.resolveAction, {
    user: "u1",
    id,
    newApplication: {
      requestId,
      draft: { company: "Honeywell Aerospace", status: "phone_screen" },
    },
    secret: SECRET,
  });

  const action = await t.run(async (ctx) => ctx.db.get(id));
  const applications = await t.run(async (ctx) => ctx.db.query("applications").collect());
  expect(result).toMatchObject({ short: expect.stringMatching(/^[0-9a-f]{12}$/), status: "phone_screen" });
  expect(action).toMatchObject({
    state: "resolved",
    resolution: { short: result.short, status: "phone_screen", requestId },
  });
  expect(applications).toHaveLength(1);
  expect(applications[0]).toMatchObject({
    short: result.short,
    status: "phone_screen",
    snapshot: { company: "Honeywell Aerospace", source: "manual-application" },
  });
  expect(applications[0].history.at(-1)?.note).toContain('from email: "mentions HackerRank and a next step"');

  await expect(
    t.mutation(api.mail.resolveAction, {
      user: "u1",
      id,
      newApplication: {
        requestId: "227317be-6b20-4f0a-be2c-c690f691b2e1",
        draft: { company: "Another company" },
      },
      secret: SECRET,
    }),
  ).rejects.toThrow("already resolved");

  await t.mutation(api.tracker.recordStatus, {
    user: "u1",
    short: result.short,
    status: "interview",
    secret: SECRET,
  });
  const retry = await t.mutation(api.mail.resolveAction, {
    user: "u1",
    id,
    newApplication: {
      requestId,
      draft: { company: "Honeywell Aerospace", status: "phone_screen" },
    },
    secret: SECRET,
  });
  expect(retry).toEqual(result);
  expect(await t.run(async (ctx) => ctx.db.query("applications").collect())).toHaveLength(1);
  expect((await t.run(async (ctx) => ctx.db.query("applications").first()))?.status)
    .toBe("interview");
});

test("resolveAction rejects an unknown application without creating a blank row", async () => {
  const t = convexTest(schema);
  const id = await t.run(async (ctx) => ctx.db.insert("inboxActions", { ...pendingAction }));
  await expect(
    t.mutation(api.mail.resolveAction, {
      user: "u1",
      id,
      short: "ab12cd34ef56",
      status: "oa",
      secret: SECRET,
    }),
  ).rejects.toThrow("application not found");
  expect(await t.run(async (ctx) => ctx.db.query("applications").collect())).toEqual([]);
  expect((await t.run(async (ctx) => ctx.db.get(id)))?.state).toBe("pending");
});

test("resolveAction dismisses a pending action", async () => {
  const t = convexTest(schema);
  const id = await t.run(async (ctx) => ctx.db.insert("inboxActions", { ...pendingAction }));
  await t.mutation(api.mail.resolveAction, { user: "u1", id, dismiss: true, secret: SECRET });
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
    t.mutation(api.mail.resolveAction, {
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
    t.mutation(api.mail.resolveAction, {
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
  await t.mutation(api.mail.resolveAction, { user: "u1", id, dismiss: true, secret: SECRET });
  await expect(
    t.mutation(api.mail.resolveAction, {
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
    t.action(api.mail.setMailAccount, {
      user: "u1",
      email: "a@example.com",
      refreshToken: "r1",
      secret: "wrong",
    }),
  ).rejects.toThrow("bad secret");
  await expect(t.query(api.mail.getActions, { user: "u1", secret: "wrong" })).rejects.toThrow(
    "bad secret",
  );
  const id = await t.run(async (ctx) => ctx.db.insert("inboxActions", { ...pendingAction }));
  await expect(
    t.mutation(api.mail.resolveAction, {
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
