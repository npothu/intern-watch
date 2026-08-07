"use server";

/**
 * Matches-page mutations. Batched tick writes against the shared Convex
 * store. The tracker user is ALWAYS re-resolved server-side - never accepted
 * from the client - so a signed-in user can only ever write their own rows.
 */

import { resolveTrackerUser } from "@/lib/user";
import { setTicks, getResumeUrls, type TickWrite } from "@/lib/convex";

// Server-side resume build dispatch. GITHUB_TOKEN is a fine-grained PAT with
// `actions: write` on the repository (GITHUB_REPOSITORY = "owner/repo"); the
// token and repo are server-only and never sent to the client. When either is
// unset the dispatch is refused with a clear error rather than silently
// swallowed. GITHUB_API_URL is respected for GitHub Enterprise deployments and
// defaulted to github.com.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY ?? "";
const GITHUB_API_URL = process.env.GITHUB_API_URL ?? "https://api.github.com";

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
 * Kick off an on-demand resume build for one match by dispatching the
 * `resume-build` workflow. The tracker user is re-resolved server-side (never
 * trusted from the client), and the short is validated as 12 hex chars before
 * anything leaves the server. Returns {ok:true} once GitHub has accepted the
 * dispatch; the caller then polls fetchResumeUrl until the URL appears.
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
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) {
    return {
      ok: false,
      error:
        "Resume building isn't configured (GITHUB_TOKEN / GITHUB_REPOSITORY).",
    };
  }
  try {
    const resp = await fetch(
      `${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/actions/workflows/resume-build.yml/dispatches`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({
          ref: "main",
          inputs: { user, shorts: short },
        }),
        cache: "no-store",
      }
    );
    if (!resp.ok) {
      return {
        ok: false,
        error: `Build dispatch failed (HTTP ${resp.status}).`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Build dispatch request failed." };
  }
}

/**
 * Re-resolve the user and return the built resume URL for one short, or null
 * when it isn't built yet. Polled by the client while a build is in flight.
 */
export async function fetchResumeUrl(short: string): Promise<string | null> {
  const user = await resolveTrackerUser();
  if (!user) return null;
  if (typeof short !== "string" || !SHORT_RE.test(short)) return null;
  const urls = await getResumeUrls(user);
  return urls[short] ?? null;
}
