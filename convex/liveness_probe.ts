// Periodic closed-posting probe (cron in crons.ts).
//
// Each run claims a small batch of match rows whose `livenessDueAt` has come
// up (never-probed rows first: an absent field sorts before every number),
// probes them one at a time with a pause between requests, and folds each
// verdict into the row's `liveness` record (liveness.nextLiveness). A row is
// marked closed only after CLOSED_CONFIRMATIONS consecutive closed verdicts,
// and an `unknown` verdict never moves it toward closed.
//
// What is never probed or marked:
//  - applied rows (tick or snapshot flag) and any row with an applications
//    ledger entry. The ledger is only READ here, never written;
//  - hidden (dismissed) rows - the user already dealt with them;
//  - URLs validateUrl rejects (private hosts etc.).
// Skipped rows get only their `livenessDueAt` pushed back so they stop
// occupying the front of the index; nothing else on them changes.
//
// Write budget (matches-table writes). Per run, at most:
//   BATCH_LIMIT lease writes + BATCH_LIMIT verdict writes
//   + MAX_SKIP_WRITES skip reschedules        = 12 + 12 + 40 = 64
// At 72 runs/day (every 20 min) that caps the probe at 4,608 match writes a
// day, of which skip reschedules are at most 2,880. Past the skip cap a run
// still scans for probeable rows but leaves the extra skippable ones as they
// are; later runs drain them 40 at a time.
//
// Network: requests are sequential, PACE_MS apart, at most 2 per row. Every
// redirect is followed by hand (at most MAX_REDIRECTS hops) and each hop's URL
// goes through validateUrl before it is fetched, so a public posting can't
// bounce the probe to a private address. Bodies are streamed and cut at
// MAX_BODY_BYTES.

import { internalAction, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";
import { maintenanceOn } from "./maintenance";
import { validateUrl } from "./ingest_extract";
import {
  checkLiveness,
  nextLiveness,
  probePlan,
  RECHECK_MS,
  type Fetcher,
  type HttpResult,
} from "./liveness";

/** Rows probed per run. With the cron every 20 min that is ~860 rows/day. */
export const BATCH_LIMIT = 12;
/** Due rows examined per claim, so a run of skippable rows can't stall it. */
const SCAN_LIMIT = 200;
/** A claimed row is re-claimable after this if its run died mid-probe. */
const LEASE_MS = 60 * 60 * 1000;
/** Pause before every request after the first (polite, sequential). */
const PACE_MS = 1_500;
const FETCH_TIMEOUT_MS = 15_000;
/** Ashby boards are one JSON for the whole company and can be large. */
export const MAX_BODY_BYTES = 3_000_000;
/** Redirect hops followed per request (Greenhouse/Avature use one or two). */
export const MAX_REDIRECTS = 5;
/** Skip reschedules written per claim (see the write budget above). */
export const MAX_SKIP_WRITES = 40;

// The career sites serve these pages to browsers; a browser-like UA avoids
// the generic-bot 403 some CDNs hand out. No cookies, no auth, no challenge
// solving - a bot wall simply reads as `unknown`.
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

type Claimed = { id: Doc<"matches">["_id"]; url: string };

async function skipReason(ctx: MutationCtx, row: Doc<"matches">): Promise<string | null> {
  const url = row.item?.url;
  if (typeof url !== "string" || !url) return "no-url";
  try {
    validateUrl(url);
  } catch {
    return "bad-url";
  }
  if (!probePlan(url)) return "unprobeable";
  const tick = await ctx.db
    .query("ticks")
    .withIndex("by_user_short", (q) => q.eq("user", row.user).eq("short", row.short))
    .first();
  // Tick rows override the snapshot flags, exactly as the web app reads them.
  const applied = tick ? tick.applied : row.item?.applied === true;
  const dismissed = tick ? tick.dismissed : row.item?.dismissed === true;
  if (applied) return "applied";
  if (dismissed) return "hidden";
  const ledger = await ctx.db
    .query("applications")
    .withIndex("by_user_short", (q) => q.eq("user", row.user).eq("short", row.short))
    .first();
  if (ledger) return "in-ledger";
  return null;
}

/**
 * Claim up to `limit` due rows. Claimed rows get a lease (dueAt pushed an
 * hour out) so an overlapping run can't probe them twice; skipped rows are
 * rotated to the back.
 */
export const claimBatch = internalMutation({
  args: { now: v.number(), limit: v.number() },
  handler: async (ctx, { now, limit }): Promise<Claimed[]> => {
    const rows = await ctx.db
      .query("matches")
      .withIndex("by_liveness_due")
      .order("asc")
      .take(SCAN_LIMIT);
    const out: Claimed[] = [];
    let skipWrites = 0;
    for (const row of rows) {
      if (out.length >= limit) break;
      if (row.livenessDueAt !== undefined && row.livenessDueAt > now) break; // index order: rest not due
      const skip = await skipReason(ctx, row);
      if (skip) {
        // Capped so a long run of skippable rows can't turn one claim into
        // SCAN_LIMIT writes; the rest stay due and drain on later runs.
        if (skipWrites < MAX_SKIP_WRITES) {
          await ctx.db.patch(row._id, { livenessDueAt: now + RECHECK_MS.skipped });
          skipWrites += 1;
        }
        continue;
      }
      await ctx.db.patch(row._id, { livenessDueAt: now + LEASE_MS });
      out.push({ id: row._id, url: row.item.url as string });
    }
    return out;
  },
});

/** Fold one verdict into the row. Re-checks eligibility: the user may have
 * applied or hidden it while the probe was in flight. */
export const recordVerdict = internalMutation({
  args: {
    id: v.id("matches"),
    url: v.string(),
    state: v.union(v.literal("open"), v.literal("closed"), v.literal("unknown")),
    reason: v.string(),
    now: v.number(),
  },
  handler: async (ctx, { id, url, state, reason, now }) => {
    const row = await ctx.db.get(id);
    if (!row) return { recorded: false as const, why: "gone" };
    // The watcher re-pushed a different URL meanwhile: this verdict is about
    // a URL the row no longer shows. Make it due again for the new one.
    if (row.item?.url !== url) {
      await ctx.db.patch(id, { livenessDueAt: now });
      return { recorded: false as const, why: "url-changed" };
    }
    const skip = await skipReason(ctx, row);
    if (skip) {
      await ctx.db.patch(id, { livenessDueAt: now + RECHECK_MS.skipped });
      return { recorded: false as const, why: skip };
    }
    const { record, dueAt } = nextLiveness(row.liveness, url, { state, reason }, now);
    await ctx.db.patch(id, { liveness: record, livenessDueAt: dueAt });
    return { recorded: true as const, closed: Boolean(record.closedAt) };
  },
});

/** Clamped to BATCH_LIMIT so a manual `npx convex run` stays inside the
 * per-run write budget documented above. */
export function clampBatchLimit(limit: number | undefined): number {
  const n = Number.isFinite(limit) ? Math.floor(limit as number) : BATCH_LIMIT;
  return Math.max(1, Math.min(n, BATCH_LIMIT));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HEADERS = {
  "User-Agent": UA,
  Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

/** Read at most `maxBytes` of a body, cancelling the stream at the cap. */
export async function readCapped(
  resp: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  if (!resp.body) return { body: "", truncated: false };
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { body: body + decoder.decode(), truncated: false };
    const room = maxBytes - bytes;
    if (value.byteLength > room) {
      body += decoder.decode(value.subarray(0, room));
      await reader.cancel().catch(() => undefined);
      return { body, truncated: true };
    }
    bytes += value.byteLength;
    body += decoder.decode(value, { stream: true });
  }
}

/**
 * GET with redirects followed by hand: every hop (the first included) must
 * pass validateUrl before it is requested, and at most `maxRedirects` hops
 * are followed. A blocked hop or a redirect loop throws, which the
 * classifier turns into `unknown`. `rawFetch` is injectable for tests.
 */
export async function fetchPublic(
  url: string,
  rawFetch: typeof fetch = fetch,
  opts: { maxRedirects?: number; maxBytes?: number; timeoutMs?: number } = {},
): Promise<HttpResult> {
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      validateUrl(current);
      const resp = await rawFetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: HEADERS,
      });
      const location = resp.headers.get("location");
      if (resp.status >= 300 && resp.status < 400 && location) {
        await resp.body?.cancel().catch(() => undefined);
        if (hop >= maxRedirects) throw new Error(`too many redirects (>${maxRedirects})`);
        current = new URL(location, current).toString();
        continue;
      }
      // An opaque manual-redirect response (no status, no Location) gives
      // nothing to validate - treat it like a failed fetch.
      if (resp.type === "opaqueredirect" || resp.status === 0) {
        throw new Error("opaque redirect");
      }
      const { body, truncated } = await readCapped(resp, opts.maxBytes ?? MAX_BODY_BYTES);
      return { status: resp.status, finalUrl: current, body, truncated };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Sequential fetcher that waits PACE_MS before every request but the first. */
function pacedFetcher(): Fetcher {
  let first = true;
  return async (url) => {
    if (!first) await sleep(PACE_MS);
    first = false;
    return fetchPublic(url);
  };
}

export const probeBatch = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }): Promise<{ probed: number; closed: number; skipped?: string }> => {
    // Same switch the mail crons honor: nothing writes per-user rows while
    // an operator migration is rewriting them.
    if (maintenanceOn()) return { probed: 0, closed: 0, skipped: "maintenance" };
    const claimed: Claimed[] = await ctx.runMutation(internal.liveness_probe.claimBatch, {
      now: Date.now(),
      limit: clampBatchLimit(limit),
    });
    const fetcher = pacedFetcher();
    let closed = 0;
    for (const row of claimed) {
      const verdict = await checkLiveness(row.url, fetcher);
      const res: { recorded: boolean; closed?: boolean } = await ctx.runMutation(internal.liveness_probe.recordVerdict, {
        id: row.id,
        url: row.url,
        state: verdict.state,
        reason: verdict.reason,
        now: Date.now(),
      });
      if (res.recorded && res.closed) closed += 1;
    }
    return { probed: claimed.length, closed };
  },
});
