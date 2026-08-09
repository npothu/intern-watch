import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { credentialsKey, decryptJson, encryptJson, maskTail } from "./credentials_crypto";

// Per-user third-party credentials for the Connections page.
//
// The plaintext fields are encrypted to AES-256-GCM ciphertext before they
// touch the database, and only ever leave it inside an action that is about to
// make the outbound call using the real secret. Everything a client can read
// (listCredentials) is limited to the non-secret display fields, so a leaked
// query result or a debug-printed row can't hand out a key.
//
// The secret here is the same TRACKER_SECRET as tracker.ts - these endpoints
// sit behind the same webui / Python driver and are not public. Storing a
// credential therefore reuses that gate: a caller that can already write
// tracker state is trusted to manage these rows.

// The TRACKER_SECRET env var set in the Convex dashboard, used verbatim from
// tracker.ts so every backend endpoint shares one auth story.
function checkSecret(secret: string) {
  if (secret !== process.env.TRACKER_SECRET) {
    throw new Error("bad secret");
  }
}

// Re-exported under the old local name so the call sites below read unchanged.
// The getter itself moved to credentials_crypto.ts when mail.ts started
// encrypting the Gmail refresh token with the same key.
const credKey = credentialsKey;

// Non-secret display fields shown on the Connections card, derived per the
// provider's field shape. hint is the masked tail of the primary secret;
// label identifies the account (project id, email, ...). Neither is the value.
function displayFor(
  provider: string,
  fields: Record<string, string>,
): { hint?: string; label?: string } {
  switch (provider) {
    case "gemini":
      return { hint: maskTail(fields.apiKey ?? "") };
    case "browserbase":
      return { hint: maskTail(fields.apiKey ?? ""), label: fields.projectId };
    case "jobright":
      return { label: fields.email };
    case "smtp":
      return { label: fields.address };
    case "google":
      return { label: fields.accountEmail };
    default:
      return {};
  }
}

// -- reads ----------------------------------------------------------------

// The one endpoint a client can call to list a user's connections. It must
// never return ciphertext, iv, or any decrypted field - only the display
// fields, so a card can render "AIza...7f2c / Connected" without the value
// ever leaving the backend.
export const listCredentials = query({
  args: { user: v.string(), secret: v.string() },
  handler: async (ctx, { user, secret }) => {
    checkSecret(secret);
    const rows = await ctx.db
      .query("credentials")
      .withIndex("by_user", (q) => q.eq("user", user))
      .collect();
    return rows.map((r) => ({
      provider: r.provider,
      hint: r.hint ?? null,
      label: r.label ?? null,
      status: r.status,
      lastCheckedAt: r.lastCheckedAt ?? null,
      lastError: r.lastError ?? null,
      updatedAt: r.updatedAt,
    }));
  },
});

// -- writes ---------------------------------------------------------------

// Encrypt + upsert a credential. This runs as an action because encryption
// needs Web Crypto; the resulting ciphertext is written by an internal
// mutation, never seen by or returned to the caller.
export const putCredential = action({
  args: {
    user: v.string(),
    secret: v.string(),
    provider: v.string(),
    fields: v.record(v.string(), v.string()),
  },
  handler: async (ctx, { user, secret, provider, fields }) => {
    checkSecret(secret);
    const { ciphertext, iv } = await encryptJson(credKey(), fields);
    const { hint, label } = displayFor(provider, fields);
    await ctx.runMutation(internal.credentials.upsertCredential, {
      user,
      provider,
      ciphertext,
      iv,
      hint,
      label,
      status: "untested",
    });
    return { ok: true };
  },
});

export const deleteCredential = mutation({
  args: { user: v.string(), secret: v.string(), provider: v.string() },
  handler: async (ctx, { user, secret, provider }) => {
    checkSecret(secret);
    const existing = await ctx.db
      .query("credentials")
      .withIndex("by_user_provider", (q) => q.eq("user", user).eq("provider", provider))
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
    return { ok: true };
  },
});

// -- testing --------------------------------------------------------------

// Short human phrase for an HTTP status, kept free of any secret material
// (never echo headers, bodies, or the URL that carried a key).
function httpDetail(status: number): string {
  switch (status) {
    case 400: return "400 - bad request";
    case 401: return "401 - key rejected";
    case 403: return "403 - forbidden";
    case 404: return "404 - not found";
    case 429: return "429 - rate limited";
    default: return `${status} - request failed`;
  }
}

// smtp and jobright deliberately do no network call from Convex: SMTP has no
// public test hook and a jobright login attempt would burn a real session or
// trip their anti-bot. The actual send/login happens on the next watcher run,
// so the credential is marked untested until the watcher proves it works.
const NO_TEST_DETAIL: Record<string, string> = {
  smtp: "Saved - a test send runs from the watcher",
  jobright: "Saved - verified on the next watcher run",
};

async function testGemini(apiKey: string): Promise<{ ok: boolean; detail: string; status: string }> {
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "ping" }] }],
          generationConfig: { maxOutputTokens: 1 },
        }),
      },
    );
  } catch {
    return { ok: false, detail: "network error contacting Gemini", status: "error" };
  }
  if (res.ok) {
    return { ok: true, detail: `Responded in ${Date.now() - startedAt} ms`, status: "ok" };
  }
  return { ok: false, detail: httpDetail(res.status), status: "error" };
}

async function testBrowserbase(
  apiKey: string,
  projectId: string,
): Promise<{ ok: boolean; detail: string; status: string }> {
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await fetch("https://api.browserbase.com/v1/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-BB-API-Key": apiKey },
      body: JSON.stringify({ projectId }),
    });
  } catch {
    return { ok: false, detail: "network error contacting Browserbase", status: "error" };
  }
  if (res.status !== 200 && res.status !== 201) {
    return { ok: false, detail: httpDetail(res.status), status: "error" };
  }
  const detail = `Responded in ${Date.now() - startedAt} ms`;
  // The cred check just created a (metered) session - shut it back down so
  // the free-plan minute budget isn't burned. A failed cleanup still counts
  // as a successful test: the key and project are clearly valid.
  let sessionId: string | undefined;
  try {
    const data = (await res.json()) as { id?: unknown };
    if (typeof data.id === "string") sessionId = data.id;
  } catch {
    // Non-JSON body - there is no session id to clean up.
  }
  if (sessionId) {
    let cleanedUp = true;
    try {
      const del = await fetch(
        `https://api.browserbase.com/v1/sessions/${encodeURIComponent(sessionId)}`,
        { method: "DELETE", headers: { "X-BB-API-Key": apiKey } },
      );
      cleanedUp = del.ok;
    } catch {
      cleanedUp = false;
    }
    if (!cleanedUp) {
      return { ok: true, detail: `${detail} (session cleanup failed)`, status: "ok" };
    }
  }
  return { ok: true, detail, status: "ok" };
}

async function testGoogle(refreshToken: string): Promise<{ ok: boolean; detail: string; status: string }> {
  const startedAt = Date.now();
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: process.env.GMAIL_CLIENT_ID ?? "",
    client_secret: process.env.GMAIL_CLIENT_SECRET ?? "",
  });
  let res: Response;
  try {
    res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  } catch {
    return { ok: false, detail: "network error contacting Google", status: "error" };
  }
  if (res.ok) {
    return { ok: true, detail: `Responded in ${Date.now() - startedAt} ms`, status: "ok" };
  }
  return { ok: false, detail: httpDetail(res.status), status: "error" };
}

async function runTest(
  provider: string,
  fields: Record<string, string>,
): Promise<{ ok: boolean; detail: string; status: string }> {
  if (provider === "smtp" || provider === "jobright") {
    // See NO_TEST_DETAIL above - these are verified by the watcher, not here.
    return { ok: true, detail: NO_TEST_DETAIL[provider], status: "untested" };
  }
  switch (provider) {
    case "gemini":
      return testGemini(fields.apiKey ?? "");
    case "browserbase":
      return testBrowserbase(fields.apiKey ?? "", fields.projectId ?? "");
    case "google":
      return testGoogle(fields.refreshToken ?? "");
    default:
      return { ok: false, detail: "unknown provider", status: "error" };
  }
}

// Make the real outbound test call, then record the outcome. The secret is
// decrypted here, used immediately, and never included in the returned detail.
export const testCredential = action({
  args: { user: v.string(), secret: v.string(), provider: v.string() },
  handler: async (ctx, { user, secret, provider }) => {
    checkSecret(secret);
    const row = await ctx.runQuery(internal.credentials.getCredentialRow, { user, provider });
    if (!row) {
      return { ok: false, detail: "no saved credential for this provider" };
    }
    let result: { ok: boolean; detail: string; status: string };
    try {
      const fields = await decryptJson<Record<string, string>>(credKey(), row.ciphertext, row.iv);
      result = await runTest(provider, fields);
    } catch (err) {
      // A rotated key or corrupt row cannot be tested; surface the friendly
      // message (which never contains the key) as an error state.
      const msg = err instanceof Error ? err.message : "unknown error";
      result = { ok: false, detail: msg, status: "error" };
    }
    await ctx.runMutation(internal.credentials.recordTestResult, {
      rowId: row._id,
      status: result.status,
      checkedAt: Date.now(),
      error: result.status === "error" ? result.detail : undefined,
    });
    return { ok: result.ok, detail: result.detail };
  },
});

// -- internal accessors ---------------------------------------------------

// The raw stored row (ciphertext included) so actions that need to decrypt
// can read it. Internal only - never reachable from a client.
export const getCredentialRow = internalQuery({
  args: { user: v.string(), provider: v.string() },
  handler: async (ctx, { user, provider }) => {
    return ctx.db
      .query("credentials")
      .withIndex("by_user_provider", (q) => q.eq("user", user).eq("provider", provider))
      .first();
  },
});

// Decrypted fields for server-side use (the watcher, the apply pipeline, ...).
// This is the "internal query + action pair": getCredentialRow reaches the DB,
// this action decrypts and hands the plaintext back. Internal only, so the
// plaintext secret has no client-facing route.
// The explicit Promise return annotation is load-bearing: this handler calls
// back into `internal.credentials.*`, so its inferred type would route through
// the generated api.d.ts and reference itself, which TypeScript reports as a
// circular initializer (TS7022/TS7023). Annotating breaks the cycle.
export const getCredentialFields = internalAction({
  args: { user: v.string(), provider: v.string() },
  handler: async (ctx, { user, provider }): Promise<Record<string, string> | null> => {
    const row = await ctx.runQuery(internal.credentials.getCredentialRow, {
      user,
      provider,
    });
    if (!row) return null;
    return decryptJson<Record<string, string>>(credKey(), row.ciphertext, row.iv);
  },
});

// The user's own API key for one LLM provider, or null when they have not
// configured one.
//
// HISTORY, because this reverses an explicit decision rather than forgetting
// it: this used to be `resolveGeminiKey`, and it carried a comment forbidding
// any fallback to the deployment's own key - the worry being that one user
// could silently spend the host's quota. That worry was right for an anonymous
// multi-tenant service and wrong for an invite-only one, where the effect was
// simply to make every user do sysadmin work before the feature did anything.
//
// The protection now lives where it belongs, as a per-user daily allowance on
// the OPERATOR's key (settings.ts OPERATOR_DAILY_CAP). A user's own key is
// still preferred and is never capped. So: the fallback is intentional, and so
// is the cap - do not remove either without replacing the other.
export const resolveProviderKey = internalAction({
  args: { user: v.string(), provider: v.string() },
  // Annotated for the same circular-initializer reason as getCredentialFields.
  handler: async (ctx, { user, provider }): Promise<string | null> => {
    const fields = await ctx.runAction(internal.credentials.getCredentialFields, {
      user,
      provider,
    });
    return fields?.apiKey ?? null;
  },
});

// -- internal state writes ------------------------------------------------

// One row per (user, provider); a repeat save patches in place so the set of
// connection cards stays stable across edits.
export const upsertCredential = internalMutation({
  args: {
    user: v.string(),
    provider: v.string(),
    ciphertext: v.string(),
    iv: v.string(),
    hint: v.optional(v.string()),
    label: v.optional(v.string()),
    status: v.string(),
  },
  handler: async (ctx, { user, provider, ciphertext, iv, hint, label, status }) => {
    const existing = await ctx.db
      .query("credentials")
      .withIndex("by_user_provider", (q) => q.eq("user", user).eq("provider", provider))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        ciphertext,
        iv,
        hint,
        label,
        status,
        lastError: undefined,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("credentials", {
        user,
        provider,
        ciphertext,
        iv,
        hint,
        label,
        status,
        updatedAt: Date.now(),
      });
    }
  },
});

export const recordTestResult = internalMutation({
  args: {
    rowId: v.id("credentials"),
    status: v.string(),
    checkedAt: v.number(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { rowId, status, checkedAt, error }) => {
    await ctx.db.patch(rowId, {
      status,
      lastCheckedAt: checkedAt,
      lastError: error,
      updatedAt: Date.now(),
    });
  },
});
