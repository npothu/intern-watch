"use server";

import { revalidatePath } from "next/cache";
import { isAdminUser, resolveTrackerUser } from "@/lib/user";
import { armMailWatch, getInboxActions, getOAuthConfig } from "@/lib/convex";
import { setDeploymentEnv } from "@/lib/convex-admin";

/**
 * Server actions for the Google connect wizard. Steps 4 and 6 write deployment
 * env vars through the allowlisted management client (never direct process.env
 * writes), and every mutation re-reads the resulting presence so the UI can
 * advance based on real server state rather than the checkbox's word.
 *
 * The env writes are deployment-wide - one user saving them sets them for every
 * user - so each writer re-checks admin status server-side. The UI also hides
 * the controls for non-admins, but never trusts that: a direct call to these
 * actions must fail the same way.
 */

/** Shared guard for the three deployment-writing actions. */
async function requireAdminWrite(user: string | null): Promise<string | null> {
  if (!user) return "Not signed in, or this account isn't provisioned.";
  if (!(await isAdminUser(user))) {
    return "Only an administrator can change the deployment's Google configuration.";
  }
  return null;
}

export type ActionResult =
  | { ok: true; detail?: string; presence?: EnvPresence }
  | { ok: false; error: string };

/** Which of the four wizard-managed deployment vars are currently set. */
export type EnvPresence = {
  clientId: boolean;
  clientSecret: boolean;
  pushToken: boolean;
  pubsubTopic: boolean;
};

/**
 * Read deployment-var presence as booleans only. No admin key, no values.
 *
 * Asked of the CONVEX DEPLOYMENT, not of this server's process.env.
 *
 * That distinction is the single root cause behind three separate defects
 * found in review: the wizard WRITES all four of these variables to Convex, so
 * reading them back from Next always answered false. Step 4 stayed grey after
 * a successful save, step 5's sign-in stayed disabled, and step 6 reported
 * "Not set yet" - inviting the admin to regenerate MAIL_PUSH_TOKEN, which
 * silently invalidates the token in the already-registered Pub/Sub push URL
 * and kills mail-sync with a 403 on every push. Patching the callers one at a
 * time kept missing one; asking the right process fixes the class.
 *
 * On failure it reports UNKNOWN, not false.
 *
 * An earlier version degraded to all-false, reasoning that "not set" merely
 * prompts a retry. That is exactly wrong for MAIL_PUSH_TOKEN, where the retry
 * IS the destructive act: regenerating it overwrites the value already baked
 * into the registered Pub/Sub push URL, so every Gmail push starts returning
 * 403 and mail-sync dies silently. A permanent cause is easy to hit too - a
 * CONVEX_SECRET that no longer matches the deployment makes every call here
 * throw while the admin-key write path still works. So an unreachable
 * deployment must say "could not check", never "not set".
 */
export type EnvPresenceResult =
  | { known: true; present: EnvPresence }
  | { known: false };

export async function getEnvPresenceResult(): Promise<EnvPresenceResult> {
  const config = await getOAuthConfig().catch(() => null);
  return config ? { known: true, present: config.present } : { known: false };
}

/** Booleans only, for callers that cannot express "unknown". Treats unknown as
 *  SET, so a failed check never invites a destructive re-save. */
export async function getEnvPresence(): Promise<EnvPresence> {
  const res = await getEnvPresenceResult();
  return res.known
    ? res.present
    : { clientId: true, clientSecret: true, pushToken: true, pubsubTopic: true };
}

/** Resolve the signed-in user, or null when not provisioned. */
async function requireUser(): Promise<string | null> {
  return resolveTrackerUser();
}

/** Step 4: save the OAuth client id and secret to the deployment. */
export async function saveClientCredentials(
  clientId: string,
  clientSecret: string
): Promise<ActionResult> {
  const user = await requireUser();
  const denied = await requireAdminWrite(user);
  if (denied) return { ok: false, error: denied };
  try {
    await setDeploymentEnv({
      GMAIL_CLIENT_ID: clientId,
      GMAIL_CLIENT_SECRET: clientSecret,
    });
    revalidatePath("/settings/connections");
    return { ok: true, detail: "Saved to the deployment", presence: await getEnvPresence() };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Couldn't save the credentials." };
  }
}

/** Step 6: save the generated push token to the deployment. */
export async function savePushToken(token: string): Promise<ActionResult> {
  const user = await requireUser();
  const denied = await requireAdminWrite(user);
  if (denied) return { ok: false, error: denied };
  try {
    await setDeploymentEnv({ MAIL_PUSH_TOKEN: token });
    revalidatePath("/settings/connections");
    return { ok: true, detail: "Saved to the deployment", presence: await getEnvPresence() };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Couldn't save the push token." };
  }
}

/** Step 6: save the Pub/Sub topic string to the deployment. */
export async function savePubSubTopic(topic: string): Promise<ActionResult> {
  if (!topic.trim()) {
    return { ok: false, error: "Topic can't be empty." };
  }
  const user = await requireUser();
  const denied = await requireAdminWrite(user);
  if (denied) return { ok: false, error: denied };
  try {
    await setDeploymentEnv({ MAIL_PUBSUB_TOPIC: topic.trim() });
    // A mailbox connected BEFORE the topic existed had its watch deferred, and
    // nothing else would arm it until the next daily cron - so the very next
    // step, "Verify push", could not pass in the same session. Arm it here.
    //
    // armWatchNow reports its failure modes by RETURNING {ok:false, reason},
    // not by throwing, so a try/catch alone silently dropped them and printed
    // a clean "Saved to the deployment" over a watch that was never armed.
    // The topic really is saved either way, so this reports rather than fails -
    // but it must report, or the next step is unpassable with no reason given.
    let watchNote = "";
    try {
      const armed = user ? await armMailWatch(user) : { ok: false, reason: "not signed in" };
      if (!armed.ok) {
        watchNote = ` Topic saved, but the Gmail watch is not armed yet (${armed.reason ?? "unknown"}) - connect a mailbox in step 5, then re-save this topic.`;
      }
    } catch (err) {
      watchNote = ` Topic saved, but arming the Gmail watch failed (${(err as Error).message}). Re-save this topic to retry.`;
    }
    revalidatePath("/settings/connections");
    return {
      ok: true,
      detail: `Saved to the deployment.${watchNote}`,
      presence: await getEnvPresence(),
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Couldn't save the topic." };
  }
}

/** Step 6: confirm a real Pub/Sub push reached /gmail/push recently.
 *
 * `mailAccounts.lastPushAt` is stamped by the push doorbell the moment a valid
 * payload arrives. "Recently" means within the last ten minutes - enough to
 * survive a quick yank test without being stale enough to be meaningless. */
export async function verifyPush(): Promise<ActionResult> {
  const user = await requireUser();
  if (!user) return { ok: false, error: "Not signed in, or this account isn't provisioned." };
  try {
    const { health } = await getInboxActions(user);
    if (!health?.lastPushAt) {
      return { ok: false, error: "No push has arrived yet. Send yourself a test email and try again." };
    }
    const ageMs = Date.now() - health.lastPushAt;
    if (ageMs <= 10 * 60 * 1000) {
      return { ok: true, detail: "A real push landed within the last 10 minutes." };
    }
    // lastPushAt exists but is stale - a push used to work but has stopped.
    return { ok: false, error: "The last push is older than 10 minutes. Send a test email and verify again." };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Couldn't check for a push." };
  }
}
