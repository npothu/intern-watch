"use server";

/**
 * Matches-page mutations. Batched tick writes against the shared Convex
 * store. The tracker user is ALWAYS re-resolved server-side - never accepted
 * from the client - so a signed-in user can only ever write their own rows.
 */

import { resolveTrackerUser } from "@/lib/user";
import { setTicks, type TickWrite } from "@/lib/convex";

// The first 12 hex chars of a match key's sha1 (see lib/shortkey.ts).
const SHORT_RE = /^[0-9a-f]{12}$/i;
const FIELDS = new Set(["applied", "saved", "dismissed"]);
const MAX_WRITES = 500;

export async function writeTicks(
  writes: TickWrite[]
): Promise<{ ok: true; count: number }> {
  const user = await resolveTrackerUser();
  if (!user) {
    throw new Error("This account isn't provisioned - no tracker user to write to.");
  }
  if (!Array.isArray(writes)) {
    throw new Error("Invalid write payload.");
  }
  if (writes.length > MAX_WRITES) {
    throw new Error(`Too many writes in one batch (max ${MAX_WRITES}).`);
  }
  const clean: TickWrite[] = [];
  for (const w of writes) {
    if (!w || typeof w.short !== "string" || !SHORT_RE.test(w.short)) {
      throw new Error("Invalid short key.");
    }
    if (!FIELDS.has(w.field)) {
      throw new Error("Invalid tick field.");
    }
    if (typeof w.value !== "boolean") {
      throw new Error("Invalid tick value.");
    }
    clean.push({ short: w.short, field: w.field, value: w.value });
  }
  if (!clean.length) return { ok: true, count: 0 };
  await setTicks(user, clean);
  return { ok: true, count: clean.length };
}
