"use server";

import { revalidatePath } from "next/cache";
import { resolveTrackerUser } from "@/lib/user";
import {
  putCredential,
  testCredential as runCredentialTest,
  deleteCredential,
  setResumeLlm,
} from "@/lib/convex";

/**
 * Connections-page server actions. Secrets land in Convex as opaque per-user
 * fields and are never returned to the client - save/test/remove are the only
 * surface for them. The user is re-resolved server-side on every call, so the
 * client can never act as someone else.
 */

// `detail` carries the provider's own short verdict ("Responded in 34 ms") so
// a successful test says something, rather than silently going green. The
// failure path puts the same sentence in `error`.
export type CredentialResult =
  | { ok: true; detail?: string }
  | { ok: false; error: string };

/** Resolve the signed-in user, or the standard not-provisioned error. */
async function requireUser(): Promise<string | null> {
  const user = await resolveTrackerUser();
  if (!user) return null;
  return user;
}

function notSignedIn(): CredentialResult {
  return { ok: false, error: "Not signed in, or this account isn't provisioned." };
}

/** Save (or replace) one provider's secret fields. */
export async function saveCredential(
  provider: string,
  fields: Record<string, string>
): Promise<CredentialResult> {
  const user = await requireUser();
  if (!user) return notSignedIn();
  try {
    await putCredential(user, provider, fields);
    revalidatePath("/settings/connections");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Couldn't save the credential." };
  }
}

/** Ping the provider with the saved credential and report its detail. */
export async function testCredential(
  provider: string
): Promise<CredentialResult> {
  const user = await requireUser();
  if (!user) return notSignedIn();
  try {
    const { ok, detail } = await runCredentialTest(user, provider);
    revalidatePath("/settings/connections");
    return ok ? { ok: true, detail } : { ok: false, error: detail };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Couldn't test the credential." };
  }
}

/**
 * Choose which model tailors this user's resumes.
 *
 * `provider: null` means "use whatever the operator provides" - the default
 * every user starts on, and the state a user returns to by picking the shared
 * model again. There is deliberately no separate reset action.
 *
 * This carries no secret: the optional API key behind a choice is saved
 * through saveCredential like any other credential.
 */
export async function saveResumeModel(
  provider: string | null,
  model: string | null
): Promise<CredentialResult> {
  const user = await requireUser();
  if (!user) return notSignedIn();
  try {
    await setResumeLlm(user, provider, model);
    revalidatePath("/settings/connections");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Couldn't save the model choice." };
  }
}

/** Delete one provider's stored credential. */
export async function removeCredential(
  provider: string
): Promise<CredentialResult> {
  const user = await requireUser();
  if (!user) return notSignedIn();
  try {
    await deleteCredential(user, provider);
    revalidatePath("/settings/connections");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Couldn't remove the credential." };
  }
}
