"use server";

import { revalidatePath } from "next/cache";
import { isAdminUser, resolveTrackerUser } from "@/lib/user";
import { armMailWatch, getInboxActions } from "@/lib/convex";
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
 * Read deployment-var presence as booleans only, straight from this server's
 * process.env exactly like the deploy checklist. No admin key, no values.
 */
// Async because every export of a "use server" module must be an async
// function - Next rejects a synchronous export at build time even though this
// one only reads booleans and never crosses the network.
export async function getEnvPresence(): Promise<EnvPresence> {
  return {
    clientId: Boolean(process.env.GMAIL_CLIENT_ID),
    clientSecret: Boolean(process.env.GMAIL_CLIENT_SECRET),
    pushToken: Boolean(process.env.MAIL_PUSH_TOKEN),
    pubsubTopic: Boolean(process.env.MAIL_PUBSUB_TOPIC),
  };
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
    // step, "Verify push", could not pass in the same session. Arm it here,
    // now that there is finally a topic to point at. Best effort: the topic is
    // saved either way, and the cron remains the backstop.
    try {
      if (user) await armMailWatch(user);
    } catch {
      // Deliberately swallowed - failing the save would be worse than a
      // slightly later watch, and verifyPush reports the real state anyway.
    }
    revalidatePath("/settings/connections");
    return { ok: true, detail: "Saved to the deployment", presence: await getEnvPresence() };
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
