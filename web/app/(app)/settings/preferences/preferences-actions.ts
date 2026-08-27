"use server";

import { revalidatePath } from "next/cache";
import { resolveTrackerUser } from "@/lib/user";
import { setWatchSettings, type WatchPrefs } from "@/lib/convex";

/**
 * Settings > Preferences server action. The tracker user is re-resolved
 * server-side on every call so a signed-in user can only ever write their
 * own preferences. Validation proper lives in the Convex mutation
 * (convex/watch_schema.ts normalizeWatch); this only makes sure a
 * client-side bug cannot post something that isn't even an object.
 */

export type SaveWatchResult =
  | { ok: true; watch: WatchPrefs }
  | { ok: false; error: string };

export async function savePreferences(watch: WatchPrefs): Promise<SaveWatchResult> {
  const user = await resolveTrackerUser();
  if (!user) {
    return { ok: false, error: "Not signed in, or this account isn't provisioned." };
  }
  if (!watch || typeof watch !== "object" || Array.isArray(watch)) {
    return { ok: false, error: "Invalid settings payload." };
  }
  try {
    const saved = await setWatchSettings(user, watch);
    revalidatePath("/settings/preferences");
    return { ok: true, watch: saved };
  } catch (err) {
    // Convex wraps thrown Errors as "Uncaught Error: <message>" inside the
    // errorMessage; keep only the sentence normalizeWatch wrote.
    const raw = (err as Error).message || "Couldn't save the settings.";
    const m = /Uncaught Error: ([^\n]+)/.exec(raw);
    return { ok: false, error: m ? m[1] : raw };
  }
}
