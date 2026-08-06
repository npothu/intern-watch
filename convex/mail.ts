import { internalAction, internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";

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

// -- internal actions -------------------------------------------------------

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
  handler: async (_ctx, { user }) => {
    // TODO(Phase 2): the real Gmail sync. Refresh the OAuth access token if
    // near expiry, users.watch to (re)arm the push, messages.list / history
    // since the stored historyId, then for each new message: fetch it,
    // classify the recruiter signal, and either auto-update the application
    // status or write a mailMessages row + enqueue an inbox action. The
    // mailMessages row is the idempotency barrier - a message already there
    // (outcome "auto" | "action" | "ignored") is never processed twice.
  },
});

export const startWatch = internalAction({
  args: { user: v.string() },
  handler: async (_ctx, { user }) => {
    // TODO(Phase 2): call Gmail users.watch to arm a push subscription and
    // store watchExpiration + the initial historyId on the user's
    // mailAccounts row.
  },
});

export const renewWatches = internalAction({
  args: {},
  handler: async (_ctx) => {
    // TODO(Phase 2): run by a daily cron; renew every mailAccounts row whose
    // watchExpiration is near (Gmail watches last ~7 days), refreshing the
    // auth token as needed before calling users.watch.
  },
});

export const reconcile = internalAction({
  args: {},
  handler: async (_ctx) => {
    // TODO(Phase 2): run by a daily cron; a backstop that re-reads history
    // for accounts that missed a push (so a dropped notification still gets
    // synced) and surfaces accounts stuck in a known error state.
  },
});
