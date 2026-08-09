import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { classifyReply, decideTransition, scoreCandidates, stripHtml } from "./classify";
import { credentialsKey, decryptJson, encryptJson } from "./credentials_crypto";
import { applyStatus } from "./ledger";

// Gmail push -> mail-sync backend.
//
// The drive is push-based: Gmail notifies a Cloud Pub/Sub topic on mail
// change, the subscription POSTs to the /gmail/push HTTP action (convex/http.ts),
// that action only stamps lastPushAt and schedules `sync`, and sync does the
// actual Gmail read + recruit classification. Splitting the doorbell from the
// work keeps the HTTP handler under Pub/Sub's ~10s ack deadline.
//
// Phase 1 is the skeleton: schema-backed account/action CRUD plus the internal
// action stubs (sync / startWatch / renewWatches / reconcile). The Gmail API
// calls and the recruiter classification land in Phase 2.
//
// The secret here is the same TRACKER_SECRET as tracker.ts - these endpoints
// sit behind the same webui / Python driver and are not public.

// The TRACKER_SECRET env var set in the Convex dashboard.
function checkSecret(secret: string) {
  if (secret !== process.env.TRACKER_SECRET) {
    throw new Error("bad secret");
  }
}

// Statuses resolveAction accepts when writing an application status through
// to the ledger (matches src/ledger.py set_status).
const VALID_STATUSES = [
  "applied",
  "oa",
  "phone_screen",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
] as const;

// -- mail accounts ----------------------------------------------------------

/**
 * Whether mail-sync is configured on this deployment.
 *
 * Mail-sync is OPT-IN, and deliberately so. Standing it up costs a Google
 * Cloud project, an OAuth consent screen, a Pub/Sub topic and a public push
 * URL - by far the biggest barrier to self-hosting this template, and the only
 * reason a hosted instance runs into Google's 100-user cap and its annual
 * security assessment for the restricted gmail.readonly scope. A deployment
 * that skips it should get a watcher that works, not a broken-looking Inbox.
 *
 * The client id and secret are the minimum: without them no token can be
 * refreshed, so nothing downstream can function. CREDENTIALS_KEY belongs in
 * the same set because setMailAccount encrypts the refresh token with it -
 * leaving it out let the page declare mail-sync "enabled" on a deployment
 * where connecting a mailbox always died on a variable the setup never named.
 */
export function mailSyncEnabled(): boolean {
  return Boolean(
    process.env.GMAIL_CLIENT_ID &&
      process.env.GMAIL_CLIENT_SECRET &&
      process.env.CREDENTIALS_KEY,
  );
}

/** Public, non-secret: lets the web app say "off" instead of showing a
 *  feature that silently never fires. */
export const getMailSyncStatus = query({
  args: { secret: v.string() },
  handler: async (_ctx, { secret }) => {
    checkSecret(secret);
    return {
      enabled: mailSyncEnabled(),
      // Named so the UI can tell a self-hoster exactly what is missing.
      missing: [
        !process.env.GMAIL_CLIENT_ID && "GMAIL_CLIENT_ID",
        !process.env.GMAIL_CLIENT_SECRET && "GMAIL_CLIENT_SECRET",
        !process.env.CREDENTIALS_KEY && "CREDENTIALS_KEY",
        !process.env.MAIL_PUBSUB_TOPIC && "MAIL_PUBSUB_TOPIC",
        !process.env.MAIL_PUSH_TOKEN && "MAIL_PUSH_TOKEN",
      ].filter((x): x is string => typeof x === "string"),
    };
  },
});

// Register (or refresh) a user's Gmail account. Upserts by user so re-running
// idempotently; a refresh keeps the OAuth refresh token in sync and clears any
// prior error so a healthy config isn't masked by a stale one.
// An ACTION rather than a mutation because it encrypts before storing, and
// AES-GCM needs a fresh random IV - randomness belongs in an action, not in a
// mutation that Convex may re-execute. The public name and arguments are
// unchanged; only the endpoint kind moved, which src/store.py mirrors.
export const setMailAccount = action({
  args: {
    user: v.string(),
    email: v.string(),
    refreshToken: v.string(),
    secret: v.string(),
  },
  handler: async (ctx, { user, email, refreshToken, secret }): Promise<void> => {
    checkSecret(secret);
    // Fail loudly at the point of connection rather than accepting a token
    // that nothing can ever use.
    if (!mailSyncEnabled()) {
      throw new Error(
        "mail-sync is not enabled on this deployment - set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET first",
      );
    }
    const { ciphertext, iv } = await encryptJson(credentialsKey(), refreshToken);
    await ctx.runMutation(internal.mail.storeMailAccount, {
      user,
      email,
      refreshToken: ciphertext,
      refreshTokenIv: iv,
    });
  },
});

// The storage half of setMailAccount. Internal: the plaintext token must have
// exactly one way in, and it is the action above.
export const storeMailAccount = internalMutation({
  args: {
    user: v.string(),
    email: v.string(),
    refreshToken: v.string(),
    refreshTokenIv: v.string(),
  },
  handler: async (ctx, { user, email, refreshToken, refreshTokenIv }) => {
    const existing = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("user", user))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        email,
        refreshToken,
        refreshTokenIv,
        lastError: undefined,
        lastErrorAt: undefined,
      });
    } else {
      await ctx.db.insert("mailAccounts", { user, email, refreshToken, refreshTokenIv });
    }
    // Kick the (idempotent) watch setup right away so a freshly configured
    // account starts receiving pushes without waiting for the daily cron.
    await ctx.scheduler.runAfter(0, internal.mail.startWatch, { user });
  },
});

export const getActions = query({
  args: { user: v.string(), secret: v.string() },
  handler: async (ctx, { user, secret }) => {
    checkSecret(secret);
    const rows = await ctx.db
      .query("inboxActions")
      .withIndex("by_user_state", (q) => q.eq("user", user).eq("state", "pending"))
      .collect();
    const actions = rows.map((r) => ({
      id: r._id,
      gmailMessageId: r.gmailMessageId,
      threadId: r.threadId,
      accountEmail: r.accountEmail,
      from: r.from,
      subject: r.subject,
      receivedAt: r.receivedAt,
      signal: r.signal,
      evidence: r.evidence,
      source: r.source,
      candidates: r.candidates,
      createdAt: r.createdAt,
    }));
    const account = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("user", user))
      .first();
    const health = account
      ? {
          email: account.email,
          lastPushAt: account.lastPushAt ?? null,
          lastSyncAt: account.lastSyncAt ?? null,
          lastError: account.lastError ?? null,
          lastErrorAt: account.lastErrorAt ?? null,
          watchExpiration: account.watchExpiration ?? null,
          historyId: account.historyId ?? null,
        }
      : null;
    return { actions, health };
  },
});

export const resolveAction = mutation({
  args: {
    user: v.string(),
    id: v.id("inboxActions"),
    short: v.optional(v.string()),
    status: v.optional(v.string()),
    dismiss: v.optional(v.boolean()),
    secret: v.string(),
  },
  handler: async (ctx, { user, id, short, status, dismiss, secret }) => {
    checkSecret(secret);
    const row = await ctx.db.get(id);
    if (!row || row.user !== user) {
      throw new Error("not found");
    }
    if (row.state !== "pending") {
      throw new Error("already resolved");
    }
    const at = new Date().toISOString();
    if (dismiss) {
      await ctx.db.patch(id, { state: "dismissed", resolution: { at } });
      return;
    }
    if (!short || !status) {
      throw new Error("missing short/status");
    }
    if (!(VALID_STATUSES as readonly string[]).includes(status)) {
      throw new Error("bad status");
    }
    await ctx.db.patch(id, {
      state: "resolved",
      resolution: { short, status, at },
    });
    // Write through to the applications ledger via the shared helper, so a
    // resolved action is indistinguishable from a hand-set status (snapshot
    // backfill included). The note keeps the email evidence + deep link.
    await applyStatus(ctx.db, {
      user,
      short,
      status,
      note: `from email: "${row.evidence}" - ${gmailLink(row.accountEmail, row.gmailMessageId)}`,
    });
  },
});

// -- internal queries (read seams for the actions) --------------------------

// Load a single account row by user (or null when unconfigured).
export const getAccount = internalQuery({
  args: { user: v.string() },
  handler: async (ctx, { user }) => {
    return ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("user", user))
      .first();
  },
});

// Load every account row - used by the daily renew/reconcile sweeps.
export const listAccounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    return ctx.db.query("mailAccounts").collect();
  },
});

// The gmailMessageIds already recorded for a user. `sync` uses this to avoid
// re-fetching messages from Gmail it has already seen; recordOutcome's own
// re-check is still the hard idempotency barrier for concurrent runs.
export const listMessageIds = internalQuery({
  args: { user: v.string() },
  handler: async (ctx, { user }) => {
    const rows = await ctx.db
      .query("mailMessages")
      .withIndex("by_user", (q) => q.eq("user", user))
      .collect();
    return rows.map((r) => r.gmailMessageId);
  },
});

// The user's tracked applications shaped for the candidate scorer: display
// fields from the snapshot plus the live status. `sync` runs the scorer in
// the action; recordOutcome re-reads the chosen row transactionally.
export const listApplications = internalQuery({
  args: { user: v.string() },
  handler: async (ctx, { user }) => {
    const rows = await ctx.db
      .query("applications")
      .withIndex("by_user", (q) => q.eq("user", user))
      .collect();
    return rows.map((r) => {
      const snap = (r.snapshot ?? {}) as {
        company?: string;
        title?: string;
        url?: string;
      };
      return {
        short: r.short,
        company: snap.company ?? "",
        title: snap.title ?? "",
        url: snap.url ?? "",
        status: r.status,
      };
    });
  },
});

// -- internal mutations (state writes called from the actions) --------------

// Persist a freshly issued OAuth access token + expiry. Refresh keeps a read-
// token trust, so the access token only lives in the account row, never in the
// request path.
// Access tokens are no longer cached in the row (see refreshAccessToken).
// This drops any value an older build left behind, so the plaintext bearer
// token does not outlive the change that stopped writing it.
export const clearCachedAccessToken = internalMutation({
  args: { rowId: v.id("mailAccounts") },
  handler: async (ctx, { rowId }) => {
    await ctx.db.patch(rowId, {
      accessToken: undefined,
      accessTokenExpiry: undefined,
    });
  },
});

// Stamp a rolling error (lastError + lastErrorAt) so the webui health banner
// can surface a broken account. Never throws - broken sync/watch must not
// crash-loop the scheduler.
export const stampError = internalMutation({
  args: { rowId: v.id("mailAccounts"), message: v.string() },
  handler: async (ctx, { rowId, message }) => {
    await ctx.db.patch(rowId, { lastError: message, lastErrorAt: Date.now() });
  },
});

// stampError + the accounting timestamps on a clean run. Clears a prior error
// so a recovered account looks healthy again.
export const stampSyncOk = internalMutation({
  args: { rowId: v.id("mailAccounts"), lastSyncAt: v.number() },
  handler: async (ctx, { rowId, lastSyncAt }) => {
    await ctx.db.patch(rowId, {
      lastSyncAt,
      lastError: undefined,
      lastErrorAt: undefined,
    });
  },
});

// Set watchExpiration and anchor historyId. The cursor is only anchored when
// the row has no historyId yet (startWatch's first arm); a later arm never
// regresses an existing cursor.
export const armWatch = internalMutation({
  args: {
    rowId: v.id("mailAccounts"),
    expiration: v.number(),
    historyId: v.optional(v.string()),
  },
  handler: async (ctx, { rowId, expiration, historyId }) => {
    const row = await ctx.db.get(rowId);
    if (!row) return;
    const patch: { watchExpiration: number; historyId?: string } = {
      watchExpiration: expiration,
    };
    if (historyId !== undefined && row.historyId === undefined) {
      patch.historyId = historyId;
    }
    await ctx.db.patch(rowId, patch);
  },
});

// Advance the history cursor MONOTONICALLY. The real cursor is a large Gmail
// history id, so it is compared as BigInt; a stale/out-of-order sync result
// (or a concurrent sync that already moved past it) never regresses the
// stored cursor. The comparison happens inside the mutation, so it is atomic
// against racing syncs.
export const advanceHistory = internalMutation({
  args: { rowId: v.id("mailAccounts"), historyId: v.string() },
  handler: async (ctx, { rowId, historyId }) => {
    const row = await ctx.db.get(rowId);
    if (!row) return;
    const cur = row.historyId;
    if (cur === undefined || BigInt(historyId) > BigInt(cur)) {
      await ctx.db.patch(rowId, { historyId });
    }
  },
});

// Reconcile's "watch lapsed" stamp. Only writes when there is no fresher error
// already on the row (i.e. lastErrorAt is not after the watch actually
// expired) so a more relevant failure isn't clobbered by the generic one.
export const stampWatchExpired = internalMutation({
  args: { rowId: v.id("mailAccounts"), expiration: v.number() },
  handler: async (ctx, { rowId, expiration }) => {
    const row = await ctx.db.get(rowId);
    if (!row) return;
    if (row.lastErrorAt != null && row.lastErrorAt > expiration) return;
    await ctx.db.patch(rowId, {
      lastError: "gmail watch expired",
      lastErrorAt: Date.now(),
    });
  },
});

// The Gmail deep link stored in ledger notes and used by the webui rows.
function gmailLink(accountEmail: string, gmailMessageId: string): string {
  return (
    "https://mail.google.com/mail/?authuser=" +
    encodeURIComponent(accountEmail) +
    "#all/" +
    encodeURIComponent(gmailMessageId)
  );
}

// Auto-apply bar: exactly one candidate decisively ahead of the runner-up.
// The webui preselects the top candidate with the SAME rule, so what the
// backend would have auto-applied is what the human sees preselected.
function decisiveCandidate(
  cands: Array<{ short: string; score: number }>,
): string | null {
  if (cands.length === 0 || cands[0].score < 3) return null;
  if (cands.length > 1 && cands[1].score * 2 > cands[0].score) return null;
  return cands[0].short;
}

// RFC 2822 Date header -> ISO string (webui rows slice(0, 10) it). Falls back
// to "now" when the header is missing or unparseable.
function receivedAtIso(dateHeader: string): string {
  const t = Date.parse(dateHeader);
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
}

const CLASSIFICATION = v.object({
  signal: v.string(),
  evidence: v.string(),
  source: v.string(), // "regex" | "llm"
});

const CANDIDATE = v.object({
  short: v.string(),
  company: v.string(),
  title: v.string(),
  score: v.number(),
});

// Record a processed Gmail message and dispatch its outcome. This is the
// idempotency barrier AND the transactional decision point: a user +
// gmailMessageId that already has a row (outcome auto | action | ignored) is
// never processed twice, no matter how Pub/Sub redelivers or how many syncs
// race, and the auto-vs-queue decision re-reads the application's CURRENT
// status inside the mutation so racing syncs can't double-advance it.
//
// Outcomes:
//  - no classification -> "ignored" row only.
//  - decisive candidate + regex source + forward transition -> "auto": the
//    shared ledger helper writes the status with an evidence + deep-link note.
//  - decisive but the transition says "skip" (already at that status) ->
//    "ignored" (signal kept on the row for debugging).
//  - everything else (ambiguous, LLM-sourced, backward/terminal transition)
//    -> "action": a pending inboxActions row for human resolution; a pending
//    action on the same thread is UPDATED, not duplicated, so an email chain
//    yields one queue entry.
export const recordOutcome = internalMutation({
  args: {
    user: v.string(),
    gmailMessageId: v.string(),
    threadId: v.string(),
    headers: v.object({
      from: v.string(),
      subject: v.string(),
      date: v.string(),
      messageId: v.string(),
    }),
    accountEmail: v.string(),
    classification: v.optional(CLASSIFICATION),
    candidates: v.optional(v.array(CANDIDATE)),
  },
  handler: async (
    ctx,
    { user, gmailMessageId, threadId, headers, accountEmail, classification, candidates },
  ) => {
    const existing = await ctx.db
      .query("mailMessages")
      .withIndex("by_user_message", (q) =>
        q.eq("user", user).eq("gmailMessageId", gmailMessageId),
      )
      .first();
    if (existing) return;

    const record = async (outcome: string, signal?: string, short?: string) => {
      await ctx.db.insert("mailMessages", {
        user,
        gmailMessageId,
        threadId,
        processedAt: Date.now(),
        outcome,
        signal,
        short,
      });
    };

    if (!classification) {
      await record("ignored");
      return;
    }
    const { signal, evidence, source } = classification;
    const cands = candidates ?? [];

    // Auto path: regex-sourced only (LLM verdicts always queue), decisively
    // matched, and a forward transition against the CURRENT status.
    const decisive = source === "regex" ? decisiveCandidate(cands) : null;
    if (decisive) {
      const app = await ctx.db
        .query("applications")
        .withIndex("by_user_short", (q) =>
          q.eq("user", user).eq("short", decisive),
        )
        .first();
      const decision = decideTransition(app?.status ?? null, signal);
      if (decision === "apply") {
        await applyStatus(ctx.db, {
          user,
          short: decisive,
          status: signal,
          note: `auto from email: "${evidence}" - ${gmailLink(accountEmail, gmailMessageId)}`,
        });
        await record("auto", signal, decisive);
        return;
      }
      if (decision === "skip") {
        // Already at this status - nothing to change, nothing to ask.
        await record("ignored", signal, decisive);
        return;
      }
      // "queue": backward or from-terminal transitions need a human.
    }

    // Action path: one pending queue entry per thread - a follow-up email in
    // the same thread refreshes the entry instead of duplicating it.
    const pending = await ctx.db
      .query("inboxActions")
      .withIndex("by_user_state", (q) =>
        q.eq("user", user).eq("state", "pending"),
      )
      .collect();
    const sameThread =
      threadId === "" ? undefined : pending.find((a) => a.threadId === threadId);
    const fields = {
      gmailMessageId,
      accountEmail,
      from: headers.from,
      subject: headers.subject,
      receivedAt: receivedAtIso(headers.date),
      signal,
      evidence,
      source,
      candidates: cands,
    };
    if (sameThread) {
      await ctx.db.patch(sameThread._id, fields);
    } else {
      await ctx.db.insert("inboxActions", {
        user,
        threadId,
        state: "pending",
        createdAt: new Date().toISOString(),
        ...fields,
      });
    }
    await record("action", signal);
  },
});

// Per-account daily LLM budget. Returns whether one more call is allowed
// (and consumes it). The counter lives on the account row and resets when
// the (UTC) day changes.
const LLM_DAILY_CAP = 20;

export const bumpLlmCap = internalMutation({
  args: { rowId: v.id("mailAccounts") },
  handler: async (ctx, { rowId }) => {
    const row = await ctx.db.get(rowId);
    if (!row) return false;
    const today = new Date().toISOString().slice(0, 10);
    const used = row.llmCapDate === today ? (row.llmCallsToday ?? 0) : 0;
    if (used >= LLM_DAILY_CAP) return false;
    await ctx.db.patch(rowId, { llmCallsToday: used + 1, llmCapDate: today });
    return true;
  },
});

// -- internal actions -------------------------------------------------------

const GMAIL_ME = "https://gmail.googleapis.com/gmail/v1/users/me";

// Gmail historyIds are large numbers that overflow Number, so they are kept as
// strings and compared as BigInt. An error carrying an HTTP status so callers
// can branch on e.g. a 404 expired-historyId.
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Short, stable human message for an unknown failure (kept under a size that
// is comfortable to render in the webui health banner).
function shortError(err: unknown): string {
  if (err instanceof Error) {
    const m = err.message;
    return m.length > 200 ? `${m.slice(0, 197)}...` : m;
  }
  return String(err);
}

// base64url / base64 decode (Gmail message body data). Uses web-standard
// atob + TextDecoder, NOT Buffer: actions run in Convex's default runtime
// which has no Node globals (the test VM does, so a Buffer regression would
// pass tests and die in prod).
function base64urlDecode(s: string): string {
  try {
    const pad = "=".repeat((4 - (s.length % 4)) % 4);
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function getHeader(msg: any, name: string): string {
  const headers: Array<{ name?: string; value?: string }> =
    msg?.payload?.headers ?? [];
  const hit = headers.find(
    (h) => typeof h?.name === "string" && h.name.toLowerCase() === name.toLowerCase(),
  );
  return typeof hit?.value === "string" ? hit.value : "";
}

// Best-effort body extraction from a message payload: recursively walks parts
// preferring a text/plain part, falling back to the first text/html part.
// The html flag matters downstream: HTML bodies go through stripHtml before
// classification, but plain-text bodies must NOT (stripHtml collapses
// newlines, and the classifier's `.{0,40}` deliberately does not cross them).
function extractBody(payload: any): { text: string; html: boolean } | null {
  if (!payload) return null;
  let html: string | null = null;
  const queue: any[] = [payload];
  while (queue.length) {
    const part = queue.shift();
    const sub = part?.parts;
    if (Array.isArray(sub)) queue.push(...sub);
    const data = part?.body?.data;
    if (typeof data === "string" && data.length > 0 && part.mimeType === "text/plain") {
      const text = base64urlDecode(data);
      if (text.trim()) return { text, html: false };
    } else if (
      typeof data === "string" &&
      part.mimeType === "text/html" &&
      html === null
    ) {
      html = base64urlDecode(data);
    }
  }
  return html === null ? null : { text: html, html: true };
}

// '"Acme Recruiting" <no-reply@acme.com>' -> { name, addr } (mirrors the
// webui's parser so the scorer and the UI agree on the sender identity).
function fromParts(from: string): { name: string; addr: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from || "");
  return m
    ? { name: m[1].trim(), addr: m[2].trim() }
    : { name: "", addr: (from || "").trim() };
}

// Cheap pre-filter for the LLM fallback: only recruiting-ish mail is worth a
// paid call. Anything that gets past classifyReply's negatives AND mentions
// application/interview/recruiting vocabulary qualifies.
const RECRUITING_HINT =
  /\bapplic|interview|recruit|assessment|candidat|position|role|offer|hiring|talent\b/i;

function looksRecruiting(headers: { from: string; subject: string }, body: string): boolean {
  return RECRUITING_HINT.test(
    `${headers.subject}\n${headers.from}\n${body.slice(0, 500)}`,
  );
}

// Queue-only Gemini fallback for mail the regexes can't read. Mirrors the
// watcher's Gemini call shape (src/llm.py _call_gemini): JSON response mime,
// temperature 0, x-goog-api-key header. Gated by looksRecruiting and the
// per-account daily cap; every failure path returns null (the regex verdict
// already ran, LLM trouble must never block a sync).
async function llmClassify(
  ctx: ActionCtx,
  account: Doc<"mailAccounts"> & { _id: Id<"mailAccounts"> },
  headers: { from: string; subject: string },
  body: string,
): Promise<{ signal: string; evidence: string; source: string } | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const allowed = await ctx.runMutation(internal.mail.bumpLlmCap, {
    rowId: account._id,
  });
  if (!allowed) return null;
  const prompt =
    "You classify recruiter emails about a job application. " +
    'Reply with JSON only: {"signal": <one of "oa","phone_screen","interview","rejected","offer" or null>, ' +
    '"evidence": <short verbatim quote from the email>}. ' +
    "signal must be null unless the email clearly advances or closes THIS applicant's application " +
    "(job ads, newsletters, application-received confirmations are null).\n\n" +
    `From: ${headers.from}\nSubject: ${headers.subject}\n\n${body.slice(0, 4000)}`;
  try {
    const res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            maxOutputTokens: 512,
          },
        }),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const parsed = JSON.parse(text) as { signal?: unknown; evidence?: unknown };
    const signal = typeof parsed.signal === "string" ? parsed.signal : "";
    if (!["oa", "phone_screen", "interview", "rejected", "offer"].includes(signal)) {
      return null;
    }
    const evidence =
      typeof parsed.evidence === "string" && parsed.evidence
        ? parsed.evidence
        : headers.subject;
    return { signal, evidence, source: "llm" };
  } catch (err) {
    console.warn("gemini fallback failed", err);
    return null;
  }
}

/**
 * The account's refresh token in plaintext, for use in an outbound token
 * request and nowhere else.
 *
 * Rows written before the token was encrypted have no `refreshTokenIv` and
 * still hold plaintext. Those keep working rather than locking a user out of
 * their own mailbox - the alternative would have been a migration that forces
 * everyone to re-run the OAuth flow. A legacy row is upgraded to ciphertext
 * the next time setMailAccount runs for that user.
 */
async function readRefreshToken(account: Doc<"mailAccounts">): Promise<string> {
  if (!account.refreshTokenIv) return account.refreshToken;
  return decryptJson<string>(
    credentialsKey(),
    account.refreshToken,
    account.refreshTokenIv,
  );
}

// Refresh the OAuth access token for an account, persisting it via an internal
// Mint a fresh OAuth access token for an account.
//
// This deliberately does NOT cache the token in the row any more. It used to,
// which meant a live gmail.readonly bearer token sat in the database in
// plaintext right next to the refresh token we just went to the trouble of
// encrypting - the same database dump still bought mailbox access for the
// token's remaining hour, so the protection was only half a protection.
// Minting one costs a single POST per sync, which is nothing next to the Gmail
// history and message reads it precedes.
async function refreshAccessToken(
  ctx: ActionCtx,
  account: Doc<"mailAccounts"> & { _id: Id<"mailAccounts"> },
): Promise<string> {
  const now = Date.now();
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: await readRefreshToken(account),
    client_id: process.env.GMAIL_CLIENT_ID ?? "",
    client_secret: process.env.GMAIL_CLIENT_SECRET ?? "",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) {
    // invalid_grant (revoked consent) and other failures go straight to the
    // health banner and rethrow so the caller surfaces the real cause.
    let detail = `token refresh failed: ${res.status}`;
    try {
      const body = (await res.json()) as {
        error?: string;
        error_description?: string;
      };
      if (body.error) detail += ` ${body.error}`;
      if (body.error_description) detail += ` (${body.error_description})`;
    } catch {
      // not JSON - keep the status-only message
    }
    await ctx.runMutation(internal.mail.stampError, {
      rowId: account._id,
      message: detail,
    });
    throw new Error(detail);
  }
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new Error("token refresh returned no access_token");
  }
  // Any access token cached by an older build is now dead weight; clear it so
  // the plaintext does not linger in the row after this change ships.
  if (account.accessToken) {
    await ctx.runMutation(internal.mail.clearCachedAccessToken, { rowId: account._id });
  }
  return data.access_token;
}

// Arm a Gmail watch for an account (refreshes auth, POSTs users.watch) and
// persists watchExpiration + a first-time historyId anchor. Throws (after
// stamping) on failure so callers can decide to swallow per-account.
async function armWatchAccount(
  ctx: ActionCtx,
  account: Doc<"mailAccounts"> & { _id: Id<"mailAccounts"> },
): Promise<void> {
  const token = await refreshAccessToken(ctx, account);
  const res = await fetch(`${GMAIL_ME}/watch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      topicName: process.env.MAIL_PUBSUB_TOPIC,
      labelIds: ["INBOX"],
    }),
  });
  if (!res.ok) {
    const msg = `gmail watch failed: ${res.status}`;
    await ctx.runMutation(internal.mail.stampError, { rowId: account._id, message: msg });
    throw new Error(msg);
  }
  // Both fields are int64s that Gmail serializes as strings; accept numbers
  // too so a lenient fixture or API change can't silently drop the anchor.
  const data = (await res.json()) as {
    historyId?: string | number;
    expiration?: string | number;
  };
  const armArgs: {
    rowId: Id<"mailAccounts">;
    expiration: number;
    historyId?: string;
  } = { rowId: account._id, expiration: Number(data.expiration ?? 0) };
  if (data.historyId != null) armArgs.historyId = String(data.historyId);
  await ctx.runMutation(internal.mail.armWatch, armArgs);
}

// Paginated history.list since a cursor, returning the messageAdded ids found
// and the highest history id consumed (the new monotonic cursor candidate).
async function historyList(
  token: string,
  startHistoryId: string,
): Promise<{ messageIds: string[]; cursor: string | null }> {
  const base = `${GMAIL_ME}/history?startHistoryId=${encodeURIComponent(
    startHistoryId,
  )}&historyTypes=messageAdded`;
  let url: string | null = base;
  const messageIds: string[] = [];
  // Gmail serializes history ids as STRINGS (uint64) - a number-only check
  // would never see them and the cursor would never advance. Track the max as
  // BigInt and accept both shapes, including the response's top-level
  // historyId (the current mailbox cursor, present on every page).
  let maxId = 0n;
  const bump = (value: unknown) => {
    if (typeof value !== "string" && typeof value !== "number") return;
    try {
      const b = BigInt(value);
      if (b > maxId) maxId = b;
    } catch {
      // non-integer id - ignore
    }
  };
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 404) {
      throw new HttpError(404, "gmail history expired");
    }
    if (!res.ok) {
      throw new Error(`gmail history.list failed: ${res.status}`);
    }
    const data = (await res.json()) as {
      history?: Array<{ id?: number | string; messages?: Array<{ id?: string }> }>;
      historyId?: number | string;
      nextPageToken?: string;
    };
    bump(data.historyId);
    for (const item of data.history ?? []) {
      bump(item.id);
      for (const m of item.messages ?? []) {
        if (typeof m.id === "string") messageIds.push(m.id);
      }
    }
    url = data.nextPageToken
      ? `${base}&pageToken=${encodeURIComponent(data.nextPageToken)}`
      : null;
  }
  return { messageIds, cursor: maxId > 0n ? maxId.toString() : null };
}

// Paginated messages.list, e.g. the full-sync fallback query.
async function listMessages(token: string, q: string): Promise<string[]> {
  const base = `${GMAIL_ME}/messages?q=${encodeURIComponent(q)}`;
  let url: string | null = base;
  const ids: string[] = [];
  while (url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`gmail messages.list failed: ${res.status}`);
    }
    const data = (await res.json()) as {
      messages?: Array<{ id?: string }>;
      nextPageToken?: string;
    };
    for (const m of data.messages ?? []) {
      if (typeof m.id === "string") ids.push(m.id);
    }
    url = data.nextPageToken
      ? `${base}&pageToken=${encodeURIComponent(data.nextPageToken)}`
      : null;
  }
  return ids;
}

// The current profile historyId - used to re-anchor the cursor after a
// full-sync fallback.
async function profileCursor(token: string): Promise<string> {
  const res = await fetch(`${GMAIL_ME}/profile`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`gmail profile failed: ${res.status}`);
  }
  const data = (await res.json()) as { historyId?: number | string };
  return String(data.historyId ?? 0);
}

// Full re-read when there is no cursor yet or the stored one has expired
// (history.list 404): list recent inbox messages and re-anchor from profile.
async function fullSync(
  token: string,
): Promise<{ ids: string[]; cursor: string }> {
  const ids = await listMessages(token, "newer_than:7d in:inbox");
  const cursor = await profileCursor(token);
  return { ids, cursor };
}

async function fetchMessage(token: string, id: string): Promise<any> {
  const res = await fetch(`${GMAIL_ME}/messages/${encodeURIComponent(id)}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`gmail messages.get failed: ${res.status}`);
  }
  return res.json();
}

export const notePush = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const row = await ctx.db
      .query("mailAccounts")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first();
    if (!row) {
      // A push for an account we've never configured. Deliberately NOT an
      // error: the HTTP handler acks every valid-token push, and a throw here
      // would surface as a retry/500 storm in Pub/Sub for a benign case.
      console.warn(`gmail push for unconfigured account ${email}`);
      return;
    }
    await ctx.db.patch(row._id, { lastPushAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.mail.sync, { user: row.user });
  },
});

export const sync = internalAction({
  args: { user: v.string() },
  handler: async (ctx, { user }) => {
    const account = await ctx.runQuery(internal.mail.getAccount, { user });
    if (!account) return; // unconfigured account - nothing to sync
    const rowId = account._id;
    try {
      const token = await refreshAccessToken(ctx, account);

      // Build the candidate set of message ids this run should look at, plus
      // the cursor it will advance to (monotonically, see advanceHistory).
      let candidateIds: string[];
      let cursor: string | null;
      if (account.historyId) {
        // Incremental: everything since the stored cursor.
        try {
          const hist = await historyList(token, account.historyId);
          candidateIds = hist.messageIds;
          cursor = hist.cursor;
        } catch (err) {
          if (err instanceof HttpError && err.status === 404) {
            // Stored historyId expired - fall back to a full re-read.
            const fb = await fullSync(token);
            candidateIds = fb.ids;
            cursor = fb.cursor;
          } else {
            throw err;
          }
        }
      } else {
        // No cursor yet - a full sync both finds messages and anchors it.
        const fb = await fullSync(token);
        candidateIds = fb.ids;
        cursor = fb.cursor;
      }

      // Fetch + record each candidate message not already recorded. The
      // recordOutcome mutation re-checks, so this pre-filter only avoids
      // re-fetching known messages from Gmail - it is not the barrier.
      const recorded = new Set(
        await ctx.runQuery(internal.mail.listMessageIds, { user }),
      );
      for (const id of candidateIds) {
        if (recorded.has(id)) continue;
        const msg = await fetchMessage(token, id);
        const headers = {
          from: getHeader(msg, "From"),
          subject: getHeader(msg, "Subject"),
          date: getHeader(msg, "Date"),
          messageId: getHeader(msg, "Message-ID"),
        };
        // HTML-only mail gets tag-stripped BEFORE classification; plain text
        // keeps its newlines (the classifier depends on them).
        const extracted = extractBody(msg?.payload);
        const bodyText = extracted
          ? extracted.html
            ? stripHtml(extracted.text)
            : extracted.text
          : "";

        // Classify here in the action (regex first, Gemini fallback for
        // recruiting-ish mail the regexes can't read) and score candidates;
        // recordOutcome makes the final auto/queue/ignore call transactionally.
        let classification = ((): { signal: string; evidence: string; source: string } | null => {
          const hit = classifyReply(headers.subject, bodyText);
          return hit ? { ...hit, source: "regex" } : null;
        })();
        if (!classification && looksRecruiting(headers, bodyText)) {
          classification = await llmClassify(ctx, account, headers, bodyText);
        }
        let candidates: Array<{ short: string; company: string; title: string; score: number }> = [];
        if (classification) {
          const apps = await ctx.runQuery(internal.mail.listApplications, { user });
          const f = fromParts(headers.from);
          candidates = scoreCandidates(
            { fromAddr: f.addr, fromName: f.name, subject: headers.subject, body: bodyText },
            apps,
          );
        }
        await ctx.runMutation(internal.mail.recordOutcome, {
          user,
          gmailMessageId: id,
          threadId: msg?.threadId ?? "",
          headers,
          accountEmail: account.email,
          classification: classification ?? undefined,
          candidates,
        });
      }

      // Advance the cursor MONOTONICALLY (never regress), then clock the run.
      if (cursor != null) {
        await ctx.runMutation(internal.mail.advanceHistory, {
          rowId,
          historyId: cursor,
        });
      }
      await ctx.runMutation(internal.mail.stampSyncOk, {
        rowId,
        lastSyncAt: Date.now(),
      });
    } catch (err) {
      // A broken sync must not crash-loop the scheduler: stamp and swallow.
      await ctx.runMutation(internal.mail.stampError, {
        rowId,
        message: shortError(err),
      });
      console.error("gmail sync failed", err);
    }
  },
});

export const startWatch = internalAction({
  args: { user: v.string() },
  handler: async (ctx, { user }) => {
    const account = await ctx.runQuery(internal.mail.getAccount, { user });
    if (!account) return;
    await armWatchAccount(ctx, account); // stamps lastError + rethrows on failure
  },
});

export const renewWatches = internalAction({
  args: {},
  handler: async (ctx) => {
    // Announce the skip rather than looping over zero accounts in silence -
    // a self-hoster reading logs should be able to tell "off" from "broken".
    if (!mailSyncEnabled()) {
      console.log("mail-sync is off (no GMAIL_CLIENT_ID/SECRET) - skipping watch renewal");
      return;
    }
    const accounts = await ctx.runQuery(internal.mail.listAccounts, {});
    // One account failing (e.g. revoked grant) must not stop the rest.
    for (const account of accounts) {
      const exp = account.watchExpiration;
      if (exp != null && exp > Date.now() + 48 * 3600 * 1000) continue;
      try {
        await armWatchAccount(ctx, account);
      } catch (err) {
        console.error(`gmail watch renewal failed for ${account.email}`, err);
      }
    }
  },
});

export const reconcile = internalAction({
  args: {},
  handler: async (ctx) => {
    if (!mailSyncEnabled()) {
      console.log("mail-sync is off (no GMAIL_CLIENT_ID/SECRET) - skipping reconcile sweep");
      return;
    }
    const accounts = await ctx.runQuery(internal.mail.listAccounts, {});
    // Backstop sync for accounts that missed a push (dropped notif, expired
    // watch, transient failure), jittered so N accounts don't burst together.
    for (let i = 0; i < accounts.length; i++) {
      const account = accounts[i];
      await ctx.scheduler.runAfter(
        i * 5000,
        internal.mail.sync,
        { user: account.user },
      );
      // Surface accounts whose watch lapsed so the webui health banner shows
      // it (unless a fresher error is already there).
      const exp = account.watchExpiration;
      if (exp != null && exp < Date.now()) {
        await ctx.runMutation(internal.mail.stampWatchExpired, {
          rowId: account._id,
          expiration: exp,
        });
      }
    }
  },
});
