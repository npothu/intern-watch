import { assertNotMaintenance } from "./maintenance";
import type { WithoutSystemFields } from "convex/server";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { canonicalUrl, postingIdentity, preferredApplyUrl, validateUrl } from "./ingest_extract";
import { dedupInfoForUrl } from "./short_key";
import { detectAtsBoard, isAtsSupported, isBoardWatched, normalizeFoundVia } from "./ats_detect";

export { dedupInfoForUrl } from "./short_key";

// Re-export pure helpers for tests (canonicalUrl/validateUrl already in ingest_extract)
export { canonicalUrl, validateUrl } from "./ingest_extract";

function checkSecret(secret: string) {
  assertNotMaintenance();
  if (secret !== process.env.TRACKER_SECRET) {
    throw new Error("bad secret");
  }
}

// Rate limit: simple counts in last 60s and 24h. Throws if over limit.
async function checkRateLimit(ctx: any, user: string) {
  const rows = await ctx.db
    .query("manualIngests")
    .withIndex("by_user", (q: any) => q.eq("user", user))
    .collect();
  const now = Date.now();
  let last60 = 0;
  let last24h = 0;
  for (const r of rows) {
    const age = now - r.createdAt;
    if (age < 60 * 1000) last60++;
    if (age < 24 * 60 * 60 * 1000) last24h++;
  }
  if (last60 >= 10) throw new Error("rate limited: too many requests (10 per minute)");
  if (last24h >= 100) throw new Error("rate limited: too many requests (100 per day)");
}

// ---------------------------------------------------------------------------
// Public mutation: requestIngest
// ---------------------------------------------------------------------------
// Caller-supplied posting fields. With jdText the JD is the caller's (it is
// stored as a user override, like a pasted JD); title/company/location fill
// in what a bot-walled or JS-only page cannot give. Bounds match the REST
// schema (web/lib/api/endpoints.ts).
const MANUAL_LIMITS = { jdText: 20_000, title: 300, company: 200, location: 300 } as const;
export const manualArgs = {
  jdText: v.optional(v.string()),
  title: v.optional(v.string()),
  company: v.optional(v.string()),
  location: v.optional(v.string()),
};

export const requestIngest = mutation({
  args: {
    user: v.string(),
    url: v.string(),
    secret: v.string(),
    ...manualArgs,
    // Where the user found the link ("instagram", "linkedin", ...), counted by
    // the coverage-gap report.
    foundVia: v.optional(v.string()),
  },
  handler: async (ctx, { user, url, secret, foundVia, ...fields }) => {
    checkSecret(secret);
    // Validate and canonicalize
    validateUrl(url);
    const manual: Record<string, string> = {};
    for (const [k, limit] of Object.entries(MANUAL_LIMITS)) {
      const val = (fields as Record<string, string | undefined>)[k]?.trim();
      if (!val) continue;
      if (val.length > limit) throw new Error(`invalid ${k}: longer than ${limit} characters`);
      manual[k] = val;
    }
    const canonical = canonicalUrl(url);
    const identity = postingIdentity(url) ?? canonical;
    const { dedupKey, short } = dedupInfoForUrl(canonical, url);

    // Rate limit before duplicate check so duplicates don't bypass it? Check after validation.
    await checkRateLimit(ctx, user);

    // Dedup checks:
    // 1. A prior ingest of the same URL (or the same dedup identity).
    //
    // A finished ingest record only proves the job is already here for as long
    // as the match it produced still exists. These records are never otherwise
    // cleaned up, so once a match is deleted its ingest row would refuse the
    // re-add forever - the job could never be added again. A record whose
    // match is gone is stale: drop it and let this request proceed.
    const existingManual = await ctx.db
      .query("manualIngests")
      .withIndex("by_user", (q: any) => q.eq("user", user))
      .collect();
    const stale: Id<"manualIngests">[] = [];
    for (const row of existingManual) {
      const sameJob = (postingIdentity(row.url) ?? canonicalUrl(row.url)) === identity
        || row.short === short;
      if (!sameJob || row.status === "failed") continue;

      // An in-flight ingest always blocks: it has no match yet by definition,
      // and a second submit would race the first. It is not `already_exists`
      // - no match backs its short yet - so the caller follows that ingest.
      if (row.status === "fetching" || row.status === "extracting") {
        return { status: "in_progress" as const, short: row.short, ingestId: row._id };
      }

      const match = await ctx.db
        .query("matches")
        .withIndex("by_user_short", (q: any) => q.eq("user", user).eq("short", row.short))
        .first();
      if (match) {
        await ctx.db.patch(match._id, {
          item: { ...match.item, url: preferredApplyUrl(match.item?.url ?? "", canonical) },
        });
        return { status: "already_exists" as const, short: row.short, ingestId: row._id };
      }
      stale.push(row._id);
    }
    for (const id of stale) {
      await ctx.db.delete(id);
    }

    // 2. Existing matches (by short or canonical url)
    const matches = await ctx.db
      .query("matches")
      .withIndex("by_user", (q: any) => q.eq("user", user))
      .collect();
    for (const m of matches) {
      if (m.short === short) {
        await ctx.db.patch(m._id, {
          item: { ...m.item, url: preferredApplyUrl(m.item?.url ?? "", canonical) },
        });
        // Create an already_exists ingest record for traceability, unless one already exists
        const now = Date.now();
        const id = await ctx.db.insert("manualIngests", {
          user,
          short,
          url,
          canonicalUrl: canonical,
          status: "already_exists",
          dedupKey,
          createdAt: now,
          updatedAt: now,
        });
        return { status: "already_exists" as const, short, ingestId: id };
      }
      const itemUrl = m.item?.url as string | undefined;
      if (itemUrl) {
        const itemIdentity = postingIdentity(itemUrl) ?? canonicalUrl(itemUrl);
        if (itemIdentity === identity) {
          await ctx.db.patch(m._id, {
            item: { ...m.item, url: preferredApplyUrl(itemUrl, canonical) },
          });
          const now = Date.now();
          const id = await ctx.db.insert("manualIngests", {
            user,
            short: m.short,
            url,
            canonicalUrl: canonical,
            status: "already_exists",
            dedupKey: m.item?.key || dedupKey,
            createdAt: now,
            updatedAt: now,
          });
          return { status: "already_exists" as const, short: m.short, ingestId: id };
        }
      }
    }

    // Not a duplicate -> insert fetching row and schedule ingest. A manual add
    // is a posting the watcher missed: record which board it came from and
    // whether the watcher polls that board, so the add result can offer to
    // close the gap.
    const gap = await coverageGap(ctx, user, canonical, foundVia);
    const now = Date.now();
    const ingestId = await ctx.db.insert("manualIngests", {
      user,
      short,
      url,
      canonicalUrl: canonical,
      status: "fetching",
      dedupKey,
      ...gap,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.ingest_node.runIngest, {
      user, ingestId, ...(Object.keys(manual).length ? { manual } : {}),
    });
    return { ingestId, status: "fetching" as const, short, ...gap };
  },
});

async function coverageGap(ctx: any, user: string, url: string, foundVia?: string) {
  const hit = detectAtsBoard(url);
  const settings = await ctx.db
    .query("settings")
    .withIndex("by_user", (q: any) => q.eq("user", user))
    .first();
  const watched = isBoardWatched(hit, settings?.watchReport);
  const supported = isAtsSupported(hit, settings?.watchReport);
  const via = normalizeFoundVia(foundVia);
  return {
    ...(hit ? { ats: hit.ats } : {}),
    ...(hit?.board ? { atsBoard: hit.board } : {}),
    ...(watched !== undefined ? { boardWatched: watched } : {}),
    ...(supported !== undefined ? { atsSupported: supported } : {}),
    ...(via ? { foundVia: via } : {}),
  };
}

// ---------------------------------------------------------------------------
// Public query: getIngestStatus
// ---------------------------------------------------------------------------
export const getIngestStatus = query({
  args: { user: v.string(), ingestId: v.id("manualIngests"), secret: v.string() },
  handler: async (ctx, { user, ingestId, secret }) => {
    checkSecret(secret);
    const row = await ctx.db.get(ingestId);
    if (!row || row.user !== user) return null;
    return row;
  },
});

// ---------------------------------------------------------------------------
// Internal helpers for the Node action
// ---------------------------------------------------------------------------
export const getIngestInternal = internalQuery({
  args: { ingestId: v.id("manualIngests") },
  handler: async (ctx, { ingestId }) => {
    return await ctx.db.get(ingestId);
  },
});

export const patchIngestInternal = internalMutation({
  args: {
    ingestId: v.id("manualIngests"),
    status: v.optional(v.string()),
    error: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    dedupKey: v.optional(v.string()),
    short: v.optional(v.string()),
    canonicalUrl: v.optional(v.string()),
  },
  handler: async (ctx, { ingestId, status, error, errorCode, dedupKey, short, canonicalUrl: canon }) => {
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (status !== undefined) patch.status = status;
    if (error !== undefined) patch.error = error;
    if (errorCode !== undefined) patch.errorCode = errorCode;
    if (dedupKey !== undefined) patch.dedupKey = dedupKey;
    if (short !== undefined) patch.short = short;
    if (canon !== undefined) patch.canonicalUrl = canon;
    await ctx.db.patch(ingestId, patch);
  },
});

export const upsertMatchInternal = internalMutation({
  args: {
    user: v.string(),
    short: v.string(),
    item: v.any(),
    jobDescription: v.optional(v.string()),
    // The caller pasted this JD: store it as a user override, which a later
    // automatic acquisition never replaces.
    jobDescriptionIsManual: v.optional(v.boolean()),
  },
  handler: async (ctx, { user, short, item, jobDescription, jobDescriptionIsManual }) => {
    let existing = await ctx.db
      .query("matches")
      .withIndex("by_user_short", (q: any) => q.eq("user", user).eq("short", short))
      .first();
    // The watcher or another manual fetch can finish after requestIngest's
    // initial check. Recheck at the atomic write, preserving the existing key.
    if (!existing && typeof item.url === "string") {
      const identity = postingIdentity(item.url) ?? canonicalUrl(item.url);
      const matches = await ctx.db.query("matches")
        .withIndex("by_user", (q) => q.eq("user", user)).collect();
      existing = matches.find((m) => typeof m.item?.url === "string"
        && (postingIdentity(m.item.url) ?? canonicalUrl(m.item.url)) === identity) ?? null;
    }
    if (existing) {
      short = existing.short;
      item = { ...existing.item, url: preferredApplyUrl(existing.item?.url ?? "", item.url ?? "") };
    } else if (item.source === "manual") {
      // Carry the add's coverage facts onto the match (and from there into the
      // ledger snapshot) so the gap report can count misses by ATS and source.
      const ingest = await ctx.db
        .query("manualIngests")
        .withIndex("by_user_short", (q) => q.eq("user", user).eq("short", short))
        .first();
      const hit = typeof item.url === "string" ? detectAtsBoard(item.url) : null;
      item = {
        ...item,
        ...(hit ? { ats: hit.ats } : {}),
        ...(hit?.board ? { atsBoard: hit.board } : {}),
        ...(ingest?.foundVia ? { foundVia: ingest.foundVia } : {}),
      };
    }
    const row: WithoutSystemFields<Doc<"matches">> = { user, short, item, pushedAt: Date.now() };
    // A freshly acquired JD wins over an older auto-acquired one, but a
    // user-pasted override (which also stamps jobDescriptionUpdatedAt via
    // requestBuild) is never silently replaced by re-ingesting the URL.
    if (jobDescription && jobDescriptionIsManual) {
      row.jobDescription = jobDescription;
      row.jobDescriptionUpdatedAt = Date.now();
    } else if (jobDescription && !(existing?.jobDescriptionUpdatedAt && existing?.jobDescription)) {
      row.jobDescription = jobDescription;
    }
    if (existing) {
      await ctx.db.patch(existing._id, row);
    } else {
      await ctx.db.insert("matches", row);
    }
    return { short, dedupKey: item.key as string, url: item.url as string };
  },
});
