"use server";

/**
 * Matches-page mutations. Batched tick writes against the shared Convex
 * store. The tracker user is ALWAYS re-resolved server-side - never accepted
 * from the client - so a signed-in user can only ever write their own rows.
 */

import { revalidatePath } from "next/cache";
import { resolveTrackerUser } from "@/lib/user";
import {
  setTicks,
  getResumeUrls,
  restoreResume,
  deleteResume as convexDeleteResume,
  requestResumeBuild as convexRequestBuild,
  fetchBuildStatus as convexFetchBuildStatus,
  getJobDescription as convexGetJobDescription,
  saveJobDescription as convexSaveJobDescription,
  type TickWrite,
  type BuildStatus,
  type JobDescription,
  type ResumeMeta,
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
  short: string,
  opts: { jdText?: string } = {}
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
    const jdText =
      typeof opts.jdText === "string"
        ? opts.jdText.trim().slice(0, 20_000) || undefined
        : undefined;
    const res = await convexRequestBuild(user, short, { jdText });
    if (!res.ok) {
      return { ok: false, error: res.error ?? "Couldn't start the resume build." };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Build request failed." };
  }
}

export async function fetchJobDescription(
  short: string
): Promise<JobDescription> {
  const user = await resolveTrackerUser();
  if (!user || typeof short !== "string" || !SHORT_RE.test(short)) {
    return { text: null, updatedAt: null };
  }
  return convexGetJobDescription(user, short);
}

export async function saveJobDescription(
  short: string,
  jdText: string
): Promise<{ ok: boolean; error?: string; text?: string; updatedAt?: number }> {
  const user = await resolveTrackerUser();
  if (!user) return { ok: false, error: "Not signed in." };
  if (typeof short !== "string" || !SHORT_RE.test(short)) {
    return { ok: false, error: "Bad short key." };
  }
  if (typeof jdText !== "string" || !jdText.trim()) {
    return { ok: false, error: "Job description cannot be empty." };
  }
  return convexSaveJobDescription(user, short, jdText.slice(0, 20_000));
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
  return urls[short]?.url ?? null;
}

/**
 * Full build metadata for one short - the report dialog's payload (report,
 * previous-version URL) - fetched on demand when the dialog opens or after a
 * rebuild completes.
 */
export async function fetchResumeMeta(
  short: string
): Promise<ResumeMeta | null> {
  const user = await resolveTrackerUser();
  if (!user) return null;
  if (typeof short !== "string" || !SHORT_RE.test(short)) return null;
  const urls = await getResumeUrls(user);
  return urls[short] ?? null;
}

/**
 * Rebuild with refinements from the report dialog's Edit tab: pasted JD,
 * free-form LLM instructions, hand-edited bullet overrides. Validated to the
 * same caps requestBuild enforces server-side.
 */
export async function requestResumeRebuild(
  short: string,
  opts: {
    jdText?: string;
    instructions?: string;
    overrides?: { name: string; bullets: string[] }[];
    variant?: string;
  }
): Promise<{ ok: boolean; error?: string }> {
  const user = await resolveTrackerUser();
  if (!user) return { ok: false, error: "Not signed in." };
  if (typeof short !== "string" || !SHORT_RE.test(short)) {
    return { ok: false, error: "Bad short key." };
  }
  const jdText =
    typeof opts.jdText === "string" ? opts.jdText.slice(0, 20_000) : undefined;
  const instructions =
    typeof opts.instructions === "string"
      ? opts.instructions.slice(0, 1000)
      : undefined;
  const overrides = Array.isArray(opts.overrides)
    ? opts.overrides
        .filter(
          (o) =>
            o &&
            typeof o.name === "string" &&
            Array.isArray(o.bullets) &&
            o.bullets.every((b) => typeof b === "string")
        )
        .slice(0, 12)
    : undefined;
  const variant =
    typeof opts.variant === "string" && opts.variant.trim()
      ? opts.variant.trim().slice(0, 40)
      : undefined;
  try {
    return await convexRequestBuild(user, short, {
      jdText,
      instructions,
      overrides,
      variant,
    });
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Swap back to the previous kept build (keep-N=2 restore). */
export async function requestResumeRestore(
  short: string
): Promise<{ ok: boolean; error?: string }> {
  const user = await resolveTrackerUser();
  if (!user) return { ok: false, error: "Not signed in." };
  if (typeof short !== "string" || !SHORT_RE.test(short)) {
    return { ok: false, error: "Bad short key." };
  }
  try {
    return await restoreResume(user, short);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Delete a built resume for one match (the report dialog's Delete button).
 * Re-resolves the tracker user server-side, and invalidates the page cache so
 * the match's document icon / resume count reflect the deletion immediately.
 */
export async function removeResume(
  short: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await resolveTrackerUser();
  if (!user) {
    return {
      ok: false,
      error: "This account isn't provisioned - no tracker user to delete for.",
    };
  }
  if (typeof short !== "string" || !SHORT_RE.test(short)) {
    return { ok: false, error: "Invalid short key." };
  }
  try {
    const res = await convexDeleteResume(user, short);
    if (!res.ok) {
      return {
        ok: false,
        error: res.reason === "not_found" ? "This resume is already gone." : "Couldn't delete the resume.",
      };
    }
    revalidatePath("/");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Delete request failed." };
  }
}
