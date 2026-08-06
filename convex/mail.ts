import {
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

// Register (or refresh) a user's Gmail account. Upserts by user so re-running
// idempotently; a refresh keeps the OAuth refresh token in sync and clears any
// prior error so a healthy config isn't masked by a stale one.
export const setMailAccount = mutation({
  args: {
    user: v.string(),
    email: v.string(),
    refreshToken: v.string(),
    secret: v.string(),
  },
  handler: async (ctx, { user, email, refreshToken, secret }) => {
    checkSecret(secret);
    const existing = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("user", user))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        email,
        refreshToken,
        lastError: undefined,
        lastErrorAt: undefined,
      });
    } else {
      await ctx.db.insert("mailAccounts", { user, email, refreshToken });
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
    // TODO(Phase 3): write through to the applications ledger for this
    // (user, short) via recordStatus so a resolved action lands in the
    // permanent ledger. Phase 1 keeps the change scoped to the inboxActions
    // row only.
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

// -- internal mutations (state writes called from the actions) --------------

// Persist a freshly issued OAuth access token + expiry. Refresh keeps a read-
// token trust, so the access token only lives in the account row, never in the
// request path.
export const updateTokens = internalMutation({
  args: {
    rowId: v.id("mailAccounts"),
    accessToken: v.string(),
    accessTokenExpiry: v.number(),
  },
  handler: async (ctx, { rowId, accessToken, accessTokenExpiry }) => {
    await ctx.db.patch(rowId, { accessToken, accessTokenExpiry });
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

// Record a processed Gmail message. This is the idempotency barrier: a user +
// gmailMessageId that already has a row (outcome auto | action | ignored) is
// never processed twice, no matter how Pub/Sub redelivers or how many syncs
// race. `sync` pre-checks listMessageIds only to avoid re-fetching from Gmail.
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
    body: v.string(),
  },
  handler: async (ctx, { user, gmailMessageId, threadId }) => {
    const existing = await ctx.db
      .query("mailMessages")
      .withIndex("by_user_message", (q) =>
        q.eq("user", user).eq("gmailMessageId", gmailMessageId),
      )
      .first();
    if (existing) return;

    // TODO(Phase 3): classifier + dispatch. Replace this "ignored" branch with
    // the classify-and-route logic:
    //   1. classify the recruiter signal from headers.from/headers.subject and
    //      the decoded body (TypeScript port of src/* classifyReply).
    //   2. if a recruiter signal, match against this user's applications
    //      (local short/status + the mail-sync heuristics in src/mail_sync)
    //      via threadId / message-id correlation.
    //   3. on a match, either auto-update the application status (outcome
    //      "auto") or enqueue an inboxAction (outcome "action"), using the
    //      account email + receivedAt so the dashboard rows populate.
    // The args already carry everything Phase 3 needs (headers + body) - only
    // this branch changes.
    await ctx.db.insert("mailMessages", {
      user,
      gmailMessageId,
      threadId,
      processedAt: Date.now(),
      outcome: "ignored",
    });
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
function extractBody(payload: any): string | null {
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
      if (text.trim()) return text;
    } else if (
      typeof data === "string" &&
      part.mimeType === "text/html" &&
      html === null
    ) {
      html = base64urlDecode(data);
    }
  }
  return html;
}

// Refresh the OAuth access token for an account, persisting it via an internal
// mutation. The access token is reused when it still has > 60s of life.
async function refreshAccessToken(
  ctx: ActionCtx,
  account: Doc<"mailAccounts"> & { _id: Id<"mailAccounts"> },
): Promise<string> {
  const now = Date.now();
  if (
    account.accessToken &&
    account.accessTokenExpiry &&
    account.accessTokenExpiry > now + 60_000
  ) {
    return account.accessToken;
  }
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: account.refreshToken,
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
  const accessToken = data.access_token;
  const accessTokenExpiry = now + (data.expires_in ?? 3600) * 1000;
  await ctx.runMutation(internal.mail.updateTokens, {
    rowId: account._id,
    accessToken,
    accessTokenExpiry,
  });
  return accessToken;
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
        const body = extractBody(msg?.payload) ?? "";
        await ctx.runMutation(internal.mail.recordOutcome, {
          user,
          gmailMessageId: id,
          threadId: msg?.threadId ?? "",
          headers,
          body,
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
