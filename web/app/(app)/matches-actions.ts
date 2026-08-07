"use server";

/**
 * Matches-page mutations. Batched tick writes against the shared Convex
 * store. The tracker user is ALWAYS re-resolved server-side - never accepted
 * from the client - so a signed-in user can only ever write their own rows.
 */

import { resolveTrackerUser } from "@/lib/user";
import {
  setTicks,
  getResumeUrls,
  requestResumeBuild as convexRequestBuild,
  fetchBuildStatus as convexFetchBuildStatus,
  type TickWrite,
  type BuildStatus,
} from "@/lib/convex";

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

export type ResumeBuildResult = { ok: true } | { ok: false; error: string };

/**
 * Kick off an on-demand resume build for one match by calling the Convex
 * `resume:requestBuild` mutation (which schedules the internal build action).
 * The tracker user is re-resolved server-side (never trusted from the client),
 * and the short is validated as 12 hex chars before anything leaves the server.
 * Returns {ok:true} once the mutation has accepted the build; the caller then
 * polls fetchBuildStatus until the resume URL appears.
 */
export async function requestResumeBuild(
  short: string
): Promise<ResumeBuildResult> {
  const user = await resolveTrackerUser();
  if (!user) {
    return {
      ok: false,
      error: "This account isn't provisioned - no tracker user to build for.",
    };
  }
  if (typeof short !== "string" || !SHORT_RE.test(short)) {
    return { ok: false, error: "Invalid short key." };
  }
  try {
    const res = await convexRequestBuild(user, short);
    if (!res.ok) {
      return { ok: false, error: res.error ?? "Couldn't start the resume build." };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Build request failed." };
  }
}

/**
 * Re-resolve the user and return the live build status for one short (per the
 * `resume:getBuildStatus` query): "building" while the action runs, the failure
 * payload once it patched to "failed", or null once the build row is cleared
 * (success or never requested). Polled by the client while a build is in the
 * air. Returns null on any unprovidable condition (no user, bad short).
 */
export async function fetchBuildStatus(short: string): Promise<BuildStatus> {
  const user = await resolveTrackerUser();
  if (!user) return null;
  if (typeof short !== "string" || !SHORT_RE.test(short)) return null;
  return convexFetchBuildStatus(user, short);
}

/**
 * Re-resolve the user and return the built resume URL for one short, or null
 * when it isn't built yet. Polled by the client once the build status row is
 * cleared, to surface the finished docx.
 */
export async function fetchResumeUrl(short: string): Promise<string | null> {
  const user = await resolveTrackerUser();
  if (!user) return null;
  if (typeof short !== "string" || !SHORT_RE.test(short)) return null;
  const urls = await getResumeUrls(user);
  return urls[short] ?? null;
}
