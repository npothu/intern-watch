"use server";

import { resolveTrackerUser } from "@/lib/user";
import { getProfile, putProfile } from "@/lib/convex";
import { toV2 } from "../../../../convex/profile_schema";

/**
 * Profile-page server actions. The profile is a resume "bank" JSON stored as
 * an opaque string (the Convex putProfile mutation validates it server-side).
 * The user is re-resolved server-side on every call.
 */

const MAX_PROFILE_BYTES = 256 * 1024; // 256KB

export type FetchProfileResult =
  | { ok: true; data?: string }
  | { ok: false; error: string };

/** Read the user's saved resume profile JSON. */
export async function fetchProfile(): Promise<FetchProfileResult> {
  const user = await resolveTrackerUser();
  if (!user) {
    return {
      ok: false,
      error: "Not signed in, or this account isn't provisioned.",
    };
  }
  try {
    const { data } = await getProfile(user);
    return { ok: true, data: data ?? undefined };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Couldn't load the profile." };
  }
}

export type SaveProfileResult = { ok: true } | { ok: false; error: string };

/** Save the user's resume profile JSON (must parse and stay under 256KB). */
export async function saveProfile(data: string): Promise<SaveProfileResult> {
  if (typeof data !== "string") {
    return { ok: false, error: "Profile data must be a string." };
  }
  if (new Blob([data]).size > MAX_PROFILE_BYTES) {
    return { ok: false, error: "Profile is too large (max 256KB)." };
  }
  try {
    JSON.parse(data);
  } catch {
    return { ok: false, error: "Profile data must be valid JSON." };
  }
  const user = await resolveTrackerUser();
  if (!user) {
    return {
      ok: false,
      error: "Not signed in, or this account isn't provisioned.",
    };
  }
  try {
    await putProfile(user, data);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Couldn't save the profile." };
  }
}

/**
 * Upgrade the stored profile JSON to v2 if it is still v1, then save it back.
 *
 * Server actions only ever run on the server and are never bundled to the
 * browser, so this file can import convex/profile_schema.ts (which has zero
 * imports of its own) directly - unlike the client bundle, which must use the
 * mirror types/helpers in lib/profile.ts. A missing or already-v2 profile is a
 * no-op success.
 */
export async function upgradeProfile(): Promise<SaveProfileResult> {
  const user = await resolveTrackerUser();
  if (!user) {
    return {
      ok: false,
      error: "Not signed in, or this account isn't provisioned.",
    };
  }
  try {
    const { data } = await getProfile(user);
    if (data) {
      const parsed: unknown = JSON.parse(data);
      const v2 = toV2(parsed);
      await putProfile(user, JSON.stringify(v2, null, 2));
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Couldn't upgrade the profile." };
  }
}
