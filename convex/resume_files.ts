import { v } from "convex/values";
import { internalQuery, internalMutation, internalAction, httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const fileFields = ["storageId", "docxStorageId", "prevStorageId", "prevDocxStorageId"] as const;

export const legacyRows = internalQuery({
  args: {},
  handler: ctx => ctx.db.query("resumes").filter(q => q.neq(q.field("privateLinksVersion"), 1)).take(10),
});

export const replaceLegacyFiles = internalMutation({
  args: {
    rowId: v.id("resumes"),
    files: v.array(v.object({ field: v.union(v.literal("storageId"), v.literal("docxStorageId"), v.literal("prevStorageId"), v.literal("prevDocxStorageId")), oldId: v.id("_storage"), newId: v.id("_storage") })),
  },
  handler: async (ctx, { rowId, files }) => {
    const row = await ctx.db.get(rowId);
    if (!row || row.privateLinksVersion === 1 || files.some(f => row[f.field] !== f.oldId) || fileFields.some(field => row[field] && !files.some(f => f.field === field))) {
      for (const id of new Set(files.map(f => f.newId))) await ctx.storage.delete(id);
      return false;
    }
    await ctx.db.patch(rowId, { ...Object.fromEntries(files.map(f => [f.field, f.newId])), privateLinksVersion: 1 });
    // Operator-uploaded files may have been reused across jobs. Keep each old
    // object until all resume references have moved, including concurrent builds.
    for (const id of new Set(files.map(f => f.oldId))) {
      const reference = await ctx.db.query("resumes").filter(q => q.or(...fileFields.map(field => q.eq(q.field(field), id)))).first();
      if (!reference) await ctx.storage.delete(id);
    }
    return true;
  },
});

/** Operator-only, run after a verified backup to invalidate old bearer URLs. */
export const rotateLegacyLinks = internalAction({
  args: {},
  handler: async (ctx): Promise<{ rotated: number; remaining: boolean }> => {
    const rows = await ctx.runQuery(internal.resume_files.legacyRows, {});
    let rotated = 0;
    for (const row of rows) {
      const copies = new Map<typeof row.storageId, typeof row.storageId>();
      const files = [];
      try {
        for (const field of fileFields) {
          const oldId = row[field];
          if (!oldId) continue;
          let newId = copies.get(oldId);
          if (!newId) {
            const blob = await ctx.storage.get(oldId);
            if (!blob) throw new Error("A resume file is missing; investigate before rotating links.");
            newId = await ctx.storage.store(blob);
            copies.set(oldId, newId);
          }
          files.push({ field, oldId, newId });
        }
      } catch (error) {
        for (const id of copies.values()) await ctx.storage.delete(id);
        throw error;
      }
      // A mutation response can be lost after commit. Leave copies intact after
      // dispatch because they may already be the live resume.
      if (await ctx.runMutation(internal.resume_files.replaceLegacyFiles, { rowId: row._id, files })) rotated++;
    }
    return { rotated, remaining: (await ctx.runQuery(internal.resume_files.legacyRows, {})).length > 0 };
  },
});

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
