import { v } from "convex/values";
import { internalQuery, httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

export const lookup = internalQuery({
  args: { user: v.string(), short: v.string(), slot: v.string() },
  handler: async (ctx, { user, short, slot }) => {
    const row = await ctx.db.query("resumes").withIndex("by_user_short", (q) => q.eq("user", user).eq("short", short)).unique();
    if (!row) return null;
    switch (slot) {
      case "current": return { id: row.storageId, filename: row.filename, format: row.artifactFormat ?? "docx" };
      case "docx": {
        const id = row.docxStorageId ?? (row.artifactFormat === "pdf" ? undefined : row.storageId);
        return id ? { id, filename: row.docxFilename ?? row.filename, format: "docx" } : null;
      }
      case "previous": return row.prevStorageId ? { id: row.prevStorageId, filename: row.prevFilename ?? "resume", format: row.prevArtifactFormat ?? "docx" } : null;
      case "previous-docx": {
        const id = row.prevDocxStorageId ?? (row.prevArtifactFormat === "pdf" ? undefined : row.prevStorageId);
        return id ? { id, filename: row.prevDocxFilename ?? row.prevFilename ?? "resume.docx", format: "docx" } : null;
      }
      default: return null;
    }
  },
});

/** The web server authenticates the user before requesting this stream. */
export const download = httpAction(async (ctx, request) => {
  const secret = process.env.TRACKER_SECRET;
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
  if (!secret || request.headers.get("Authorization") !== `Bearer ${secret}`) return new Response(null, { status: 401, headers });
  const params = new URL(request.url).searchParams;
  const user = params.get("user"), short = params.get("short"), slot = params.get("slot");
  if (!user || !short || !slot) return new Response(null, { status: 400, headers });
  const file = await ctx.runQuery(internal.resume_files.lookup, { user, short, slot });
  if (!file) return new Response(null, { status: 404, headers });
  const blob = await ctx.storage.get(file.id);
  if (!blob) return new Response(null, { status: 404, headers });
  return new Response(blob, { headers: {
    ...headers,
    "Content-Type": file.format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
  } });
});
