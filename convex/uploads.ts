import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, httpAction, internalMutation } from "./_generated/server";

const TTL = 30 * 60_000;
const MAX_BYTES = 5 * 1024 * 1024;
const headers = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };

async function digest(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, "0")).join("");
}

/** A single-use upload capability, bound to the authenticated owner. */
export const prepare = action({
  args: { user: v.string(), secret: v.string() },
  handler: async (ctx, { user, secret }): Promise<string> => {
    if (!process.env.TRACKER_SECRET || secret !== process.env.TRACKER_SECRET) throw new Error("bad secret");
    const origin = process.env.CONVEX_SITE_URL;
    if (!origin) throw new Error("Upload service is not configured.");
    const token = crypto.randomUUID() + crypto.randomUUID();
    await ctx.runMutation(internal.uploads.issue, { user, tokenHash: await digest(token) });
    return `${origin}/profile/import/upload?token=${encodeURIComponent(token)}`;
  },
});

export const issue = internalMutation({
  args: { user: v.string(), tokenHash: v.string() },
  handler: async (ctx, { user, tokenHash }) => {
    const recent = await ctx.db.query("profileUploads").withIndex("by_user", (q) => q.eq("user", user)).collect();
    if (recent.filter((r) => r.expiresAt > Date.now()).length >= 5) throw new Error("Too many pending uploads. Try again later.");
    const id = await ctx.db.insert("profileUploads", { user, tokenHash, state: "issued", expiresAt: Date.now() + TTL });
    await ctx.scheduler.runAfter(TTL, internal.uploads.expire, { id });
  },
});

export const reserve = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const row = await ctx.db.query("profileUploads").withIndex("by_token", (q) => q.eq("tokenHash", tokenHash)).unique();
    if (!row || row.expiresAt <= Date.now() || row.state !== "issued") return null;
    await ctx.db.patch(row._id, { state: "uploading" });
    return row._id;
  },
});

export const finish = internalMutation({
  args: { id: v.id("profileUploads"), storageId: v.id("_storage") },
  handler: async (ctx, { id, storageId }) => {
    const row = await ctx.db.get(id);
    if (!row || row.state !== "uploading" || row.expiresAt <= Date.now()) {
      await ctx.storage.delete(storageId);
      return false;
    }
    await ctx.db.patch(id, { storageId, state: "uploaded" });
    return true;
  },
});

export const expire = internalMutation({
  args: { id: v.id("profileUploads") },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.get(id);
    if (!row) return;
    if (row.storageId) await ctx.storage.delete(row.storageId);
    await ctx.db.delete(id);
  },
});

export const preflight = httpAction(async () => new Response(null, {
  status: 204,
  headers: { ...headers, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" },
}));

export const upload = httpAction(async (ctx, request) => {
  const token = new URL(request.url).searchParams.get("token");
  if (!token || token.length > 100) return new Response("Invalid upload", { status: 403, headers });
  const id = await ctx.runMutation(internal.uploads.reserve, { tokenHash: await digest(token) });
  if (!id) return new Response("Upload expired or already used", { status: 403, headers });
  let storageId;
  try {
    const reader = request.body?.getReader();
    if (!reader) return new Response("Empty upload", { status: 400, headers });
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel();
          return new Response("Resume files must be 5 MB or smaller", { status: 413, headers });
        }
        chunks.push(new Uint8Array(value));
      }
    } finally {
      reader.releaseLock();
    }
    if (!size) return new Response("Empty upload", { status: 400, headers });
    storageId = await ctx.storage.store(new Blob(chunks, { type: request.headers.get("Content-Type") ?? "application/octet-stream" }));
    const saved = await ctx.runMutation(internal.uploads.finish, { id, storageId });
    if (!saved) return new Response("Upload expired", { status: 403, headers });
    return Response.json({ storageId }, { headers });
  } catch {
    if (storageId) await ctx.storage.delete(storageId);
    return new Response("Upload failed. Please retry.", { status: 500, headers });
  }
});
