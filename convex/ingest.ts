import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { canonicalUrl, validateUrl } from "./ingest_extract";

// Re-export pure helpers for tests (canonicalUrl/validateUrl already in ingest_extract)
export { canonicalUrl, validateUrl } from "./ingest_extract";

function checkSecret(secret: string) {
  if (secret !== process.env.TRACKER_SECRET) {
    throw new Error("bad secret");
  }
}

// -- SHA1 helpers (pure JS, no WebCrypto dependency) ----------------------
// Minimal synchronous SHA1 for dedupKey -> short derivation.
// Adapted from public domain implementation.
function sha1HexSync(str: string): string {
  const data = new TextEncoder().encode(str);
  // Use WebCrypto if available and we are async context, but sync fallback is simpler.
  // Pure JS SHA1
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return sha1Pure(data);
}

function sha1Pure(data: Uint8Array): string {
  // SHA1 constants
  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  // Pre-processing: padding
  const ml = data.length * 8;
  const withOne = new Uint8Array(data.length + 1);
  withOne.set(data);
  withOne[data.length] = 0x80;
  let len = withOne.length;
  // pad to 448 mod 512
  while ((len * 8) % 512 !== 448) len++;
  const padded = new Uint8Array(len + 8);
  padded.set(withOne);
  // append length as 64-bit big-endian
  const view = new DataView(padded.buffer);
  // high 32 bits of length (always 0 for our sizes)
  view.setUint32(len, Math.floor(ml / 0x100000000), false);
  view.setUint32(len + 4, ml >>> 0, false);

  const w = new Uint32Array(80);
  for (let i = 0; i < padded.length; i += 64) {
    for (let j = 0; j < 16; j++) {
      w[j] = view.getUint32(i + j * 4, false);
    }
    for (let j = 16; j < 80; j++) {
      const v = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
      w[j] = (v << 1) | (v >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let j = 0; j < 80; j++) {
      let f: number, k: number;
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) >>> 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const toHex = (n: number) => n.toString(16).padStart(8, "0");
  return toHex(h0) + toHex(h1) + toHex(h2) + toHex(h3) + toHex(h4);
}

// Extract jobright 24-hex id if present
function extractJobrightId(input: string): string | null {
  const m = input.match(/jobright\.ai\/jobs\/info\/([0-9a-f]{24})/i) || input.match(/\bjr_id=([0-9a-f]{24})\b/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Derive the dedup identity for a URL.
 *
 * `raw` matters: canonicalUrl() strips `jr_id` as a tracking parameter, so a
 * jobright-sourced employer link (jobs.ashbyhq.com/...?jr_id=<24hex>) has no
 * jobright id left by the time it reaches here. Reading the id from the raw
 * URL first means such a link derives the same `jr:<id>` key - and therefore
 * the same short - that the watcher assigns when it finds the job itself.
 * Without this, adding a job by hand and having the watcher pick it up later
 * produces two rows for one job.
 */
export function dedupInfoForUrl(canonical: string, raw?: string): { dedupKey: string; short: string } {
  const jr = extractJobrightId(raw ?? canonical) || extractJobrightId(canonical);
  let dedupKey: string;
  if (jr) dedupKey = `jr:${jr}`;
  else dedupKey = `manual:${sha1HexSync(canonical)}`;
  const short = sha1HexSync(dedupKey).slice(0, 12);
  return { dedupKey, short };
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
export const requestIngest = mutation({
  args: { user: v.string(), url: v.string(), secret: v.string() },
  handler: async (ctx, { user, url, secret }) => {
    checkSecret(secret);
    // Validate and canonicalize
    validateUrl(url);
    const canonical = canonicalUrl(url);
    const { dedupKey, short } = dedupInfoForUrl(canonical, url);

    // Rate limit before duplicate check so duplicates don't bypass it? Check after validation.
    await checkRateLimit(ctx, user);

    // Dedup checks:
    // 1. Existing manualIngests for same canonicalUrl (any status except failed)
    const existingManual = await ctx.db
      .query("manualIngests")
      .withIndex("by_user", (q: any) => q.eq("user", user))
      .collect();
    for (const row of existingManual) {
      if (row.canonicalUrl === canonical && row.status !== "failed") {
        return { status: "already_exists" as const, short: row.short, ingestId: row._id };
      }
      // Also check by short (same dedupKey)
      if (row.short === short && row.status !== "failed") {
        return { status: "already_exists" as const, short: row.short, ingestId: row._id };
      }
    }

    // 2. Existing matches (by short or canonical url)
    const matches = await ctx.db
      .query("matches")
      .withIndex("by_user", (q: any) => q.eq("user", user))
      .collect();
    for (const m of matches) {
      if (m.short === short) {
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
        const itemCanon = canonicalUrl(itemUrl);
        if (itemCanon === canonical) {
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

    // Not a duplicate -> insert fetching row and schedule ingest
    const now = Date.now();
    const ingestId = await ctx.db.insert("manualIngests", {
      user,
      short,
      url,
      canonicalUrl: canonical,
      status: "fetching",
      dedupKey,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.ingest_node.runIngest, { user, ingestId });
    return { ingestId, status: "fetching" as const, short };
  },
});

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
    dedupKey: v.optional(v.string()),
    short: v.optional(v.string()),
    canonicalUrl: v.optional(v.string()),
  },
  handler: async (ctx, { ingestId, status, error, dedupKey, short, canonicalUrl: canon }) => {
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (status !== undefined) patch.status = status;
    if (error !== undefined) patch.error = error;
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
  },
  handler: async (ctx, { user, short, item }) => {
    const existing = await ctx.db
      .query("matches")
      .withIndex("by_user_short", (q: any) => q.eq("user", user).eq("short", short))
      .first();
    const row = { user, short, item, pushedAt: Date.now() };
    if (existing) {
      await ctx.db.patch(existing._id, row);
    } else {
      await ctx.db.insert("matches", row);
    }
  },
});
