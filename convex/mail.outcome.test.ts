import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import * as mail from "./mail";

// Phase 3 tests: the classify-and-dispatch decision core. End-to-end through
// `sync` where the shape matters (regex auto path, LLM fallback), and through
// `recordOutcome` directly where only the transactional decision is under
// test (transitions, thread dedupe). Gmail/OAuth/Gemini HTTP is stubbed via
// vi.stubGlobal("fetch", ...).

const SECRET = "test-tracker-secret";

beforeAll(() => {
  process.env.TRACKER_SECRET = SECRET;
  process.env.GMAIL_CLIENT_ID = "client-id";
  process.env.GMAIL_CLIENT_SECRET = "client-secret";
  process.env.MAIL_PUBSUB_TOPIC = "projects/p/topics/gmail";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GEMINI_API_KEY;
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

// A single-part text/plain message (newlines preserved end to end).
function plainMessage(
  id: string,
  threadId: string,
  from: string,
  subject: string,
  bodyText: string,
): unknown {
  return {
    id,
    threadId,
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: from },
        { name: "Subject", value: subject },
        { name: "Date", value: "Wed, 5 Aug 2026 14:03:00 -0400" },
        { name: "Message-ID", value: `<${id}@mail.example>` },
      ],
      body: { data: b64url(bodyText) },
    },
  };
}

type T = Awaited<ReturnType<typeof convexTest>>;

async function seedAccount(t: T, fields?: Record<string, unknown>) {
  await t.run(async (ctx) => {
    await ctx.db.insert("mailAccounts", {
      user: "u1",
      email: "me@gmail.com",
      refreshToken: "r1",
      historyId: "100",
      ...fields,
    });
  });
}

async function seedApp(
  t: T,
  short: string,
  status: string,
  snapshot: Record<string, unknown>,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("applications", {
      user: "u1",
      short,
      status,
      history: [{ status: "applied", at: "2026-07-20T00:00:00Z" }],
      snapshot,
      createdAt: "2026-07-20T00:00:00Z",
    });
  });
}

async function getApp(t: T, short: string) {
  return t.run(async (ctx) =>
    ctx.db
      .query("applications")
      .withIndex("by_user_short", (q) => q.eq("user", "u1").eq("short", short))
      .first(),
  );
}

async function pendingActions(t: T) {
  return t.run(async (ctx) =>
    ctx.db
      .query("inboxActions")
      .withIndex("by_user_state", (q) => q.eq("user", "u1").eq("state", "pending"))
      .collect(),
  );
}

async function messageRows(t: T) {
  return t.run(async (ctx) => ctx.db.query("mailMessages").collect());
}

// A router that serves token + one history page + one message, and fails on
// anything else (so an unexpected Gemini call breaks the test loudly).
function syncRouter(message: unknown): (url: string) => Response {
  return (url) => {
    if (url.includes("/token")) return okJson({ access_token: "tok", expires_in: 3600 });
    if (url.includes("/history"))
      return okJson({ historyId: "200", history: [{ id: "150", messages: [{ id: "gm1" }] }] });
    if (url.includes("/messages/")) return okJson(message);
    throw new Error(`unexpected url: ${url}`);
  };
}

const REJECTION = "We have decided not to move forward with your application.";

// -- auto path ---------------------------------------------------------------

test("decisive regex rejection auto-applies with an evidence + deep-link note", async () => {
  const t = convexTest(schema);
  await seedAccount(t);
  await seedApp(t, "aaaaaaaaaaaa", "applied", {
    company: "Acme",
    title: "SWE Intern",
    url: "https://careers.acme.com/jobs/1",
  });
  stub(syncRouter(plainMessage(
    "gm1", "th-1", '"Acme Recruiting" <no-reply@acme.com>',
    "Update on your application", REJECTION,
  )));

  await t.action(mail.sync, { user: "u1" });

  const app = await getApp(t, "aaaaaaaaaaaa");
  expect(app!.status).toBe("rejected");
  const last = app!.history[app!.history.length - 1];
  expect(last.status).toBe("rejected");
  expect(last.note).toContain('auto from email: "decided not to move forward"');
  expect(last.note).toContain("https://mail.google.com/mail/?authuser=me%40gmail.com#all/gm1");

  const rows = await messageRows(t);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ outcome: "auto", signal: "rejected", short: "aaaaaaaaaaaa" });
  expect(await pendingActions(t)).toHaveLength(0);
});

// -- queue paths --------------------------------------------------------------

test("ambiguous candidates queue an inbox action instead of auto-applying", async () => {
  const t = convexTest(schema);
  await seedAccount(t);
  await seedApp(t, "aaaaaaaaaaaa", "applied", {
    company: "Acme", title: "SWE Intern", url: "https://careers.acme.com/jobs/1",
  });
  await seedApp(t, "bbbbbbbbbbbb", "applied", {
    company: "Acme", title: "Data Intern", url: "https://careers.acme.com/jobs/2",
  });
  stub(syncRouter(plainMessage(
    "gm1", "th-1", "no-reply@acme.com", "Update on your application", REJECTION,
  )));

  await t.action(mail.sync, { user: "u1" });

  expect((await getApp(t, "aaaaaaaaaaaa"))!.status).toBe("applied");
  expect((await getApp(t, "bbbbbbbbbbbb"))!.status).toBe("applied");
  const actions = await pendingActions(t);
  expect(actions).toHaveLength(1);
  expect(actions[0]).toMatchObject({ signal: "rejected", source: "regex", state: "pending" });
  expect(actions[0].candidates).toHaveLength(2);
  expect(actions[0].receivedAt.slice(0, 10)).toBe("2026-08-05");
  expect((await messageRows(t))[0].outcome).toBe("action");
});

test("a follow-up in the same thread updates the pending action, not duplicates it", async () => {
  const t = convexTest(schema);
  const headers = {
    from: "no-reply@acme.com", subject: "Update",
    date: "Wed, 5 Aug 2026 14:03:00 -0400", messageId: "<m1@x>",
  };
  const base = {
    user: "u1", threadId: "th-1", headers, accountEmail: "me@gmail.com",
    classification: { signal: "oa", evidence: "online assessment", source: "regex" },
    candidates: [],
  };
  await t.mutation(mail.recordOutcome, { ...base, gmailMessageId: "gm1" });
  await t.mutation(mail.recordOutcome, {
    ...base,
    gmailMessageId: "gm2",
    classification: { signal: "interview", evidence: "schedule an interview", source: "regex" },
  });

  const actions = await pendingActions(t);
  expect(actions).toHaveLength(1);
  expect(actions[0]).toMatchObject({ gmailMessageId: "gm2", signal: "interview" });
  expect(await messageRows(t)).toHaveLength(2);
});

test("backward/from-terminal transitions queue for a human", async () => {
  const t = convexTest(schema);
  await seedApp(t, "aaaaaaaaaaaa", "offer", {
    company: "Acme", title: "SWE Intern", url: "https://careers.acme.com/jobs/1",
  });
  await t.mutation(mail.recordOutcome, {
    user: "u1", gmailMessageId: "gm1", threadId: "th-1",
    headers: { from: "no-reply@acme.com", subject: "Update", date: "", messageId: "" },
    accountEmail: "me@gmail.com",
    classification: { signal: "rejected", evidence: "decided not to move forward", source: "regex" },
    candidates: [{ short: "aaaaaaaaaaaa", company: "Acme", title: "SWE Intern", score: 5 }],
  });

  expect((await getApp(t, "aaaaaaaaaaaa"))!.status).toBe("offer");
  expect(await pendingActions(t)).toHaveLength(1);
  expect((await messageRows(t))[0].outcome).toBe("action");
});

// -- skip / ignore ------------------------------------------------------------

test("same-status signal is recorded as ignored, no action and no history spam", async () => {
  const t = convexTest(schema);
  await seedApp(t, "aaaaaaaaaaaa", "rejected", {
    company: "Acme", title: "SWE Intern", url: "https://careers.acme.com/jobs/1",
  });
  await t.mutation(mail.recordOutcome, {
    user: "u1", gmailMessageId: "gm1", threadId: "th-1",
    headers: { from: "no-reply@acme.com", subject: "Update", date: "", messageId: "" },
    accountEmail: "me@gmail.com",
    classification: { signal: "rejected", evidence: "decided not to move forward", source: "regex" },
    candidates: [{ short: "aaaaaaaaaaaa", company: "Acme", title: "SWE Intern", score: 5 }],
  });

  const app = await getApp(t, "aaaaaaaaaaaa");
  expect(app!.history).toHaveLength(1); // untouched
  expect(await pendingActions(t)).toHaveLength(0);
  expect((await messageRows(t))[0]).toMatchObject({ outcome: "ignored", signal: "rejected" });
});

// -- LLM fallback -------------------------------------------------------------

test("LLM fallback is queue-only even with a decisive candidate", async () => {
  const t = convexTest(schema);
  process.env.GEMINI_API_KEY = "gk";
  await seedAccount(t);
  await seedApp(t, "aaaaaaaaaaaa", "applied", {
    company: "Acme", title: "SWE Intern", url: "https://careers.acme.com/jobs/1",
  });
  // No regex signal in this body; "candidacy" trips the recruiting pre-filter.
  const message = plainMessage(
    "gm1", "th-1", '"Acme Recruiting" <no-reply@acme.com>',
    "Acme next steps", "We'd love to chat about your candidacy next week.",
  );
  stub((url) => {
    if (url.includes("generativelanguage"))
      return okJson({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ signal: "interview", evidence: "love to chat" }) }] } }],
      });
    return syncRouter(message)(url);
  });

  await t.action(mail.sync, { user: "u1" });

  expect((await getApp(t, "aaaaaaaaaaaa"))!.status).toBe("applied"); // never auto
  const actions = await pendingActions(t);
  expect(actions).toHaveLength(1);
  expect(actions[0]).toMatchObject({ signal: "interview", source: "llm" });
  const account = await t.run(async (ctx) =>
    ctx.db.query("mailAccounts").withIndex("by_user", (q) => q.eq("user", "u1")).first());
  expect(account!.llmCallsToday).toBe(1);
});

test("LLM daily cap: at the cap the fallback is skipped entirely", async () => {
  const t = convexTest(schema);
  process.env.GEMINI_API_KEY = "gk";
  const today = new Date().toISOString().slice(0, 10);
  await seedAccount(t, { llmCallsToday: 20, llmCapDate: today });
  // syncRouter throws on a generativelanguage URL, so a call would fail loudly.
  stub(syncRouter(plainMessage(
    "gm1", "th-1", "no-reply@acme.com", "Acme next steps",
    "We'd love to chat about your candidacy next week.",
  )));

  await t.action(mail.sync, { user: "u1" });

  expect((await messageRows(t))[0].outcome).toBe("ignored");
  expect(await pendingActions(t)).toHaveLength(0);
});

// -- resolveAction write-through ----------------------------------------------

test("resolveAction writes through to the ledger and backfills the snapshot", async () => {
  const t = convexTest(schema);
  await t.run(async (ctx) => {
    await ctx.db.insert("matches", {
      user: "u1", short: "cccccccccccc",
      item: { short: "cccccccccccc", company: "Beta", title: "PM Intern", url: "https://beta.co/j/1" },
      pushedAt: 1,
    });
  });
  const id = await t.run(async (ctx) =>
    ctx.db.insert("inboxActions", {
      user: "u1", gmailMessageId: "gm9", threadId: "th-9",
      accountEmail: "me@gmail.com", from: "hr@beta.co", subject: "OA invite",
      receivedAt: "2026-08-05T00:00:00Z", signal: "oa",
      evidence: "online assessment", source: "regex", candidates: [],
      state: "pending", createdAt: "2026-08-05T00:05:00Z",
    }),
  );

  await t.mutation(mail.resolveAction, {
    user: "u1", id, short: "cccccccccccc", status: "oa", secret: SECRET,
  });

  const app = await getApp(t, "cccccccccccc");
  expect(app!.status).toBe("oa");
  expect(app!.snapshot).toMatchObject({ company: "Beta", title: "PM Intern" });
  expect(app!.history[app!.history.length - 1].note).toContain('from email: "online assessment"');
  const action = await t.run(async (ctx) => ctx.db.get(id));
  expect(action!.state).toBe("resolved");
  expect(action!.resolution).toMatchObject({ short: "cccccccccccc", status: "oa" });
});

// -- helpers ------------------------------------------------------------------

function stub(router: (url: string) => Response) {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => router(String(input))));
}
