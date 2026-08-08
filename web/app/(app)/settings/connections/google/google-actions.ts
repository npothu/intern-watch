"use server";

import { revalidatePath } from "next/cache";
import { resolveTrackerUser } from "@/lib/user";
import { getInboxActions } from "@/lib/convex";
import { setDeploymentEnv } from "@/lib/convex-admin";

/**
 * Server actions for the Google connect wizard. Steps 4 and 6 write deployment
 * env vars through the allowlisted management client (never direct process.env
 * writes), and every mutation re-reads the resulting presence so the UI can
 * advance based on real server state rather than the checkbox's word.
 */

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
  if (!user) return { ok: false, error: "Not signed in, or this account isn't provisioned." };
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
  if (!user) return { ok: false, error: "Not signed in, or this account isn't provisioned." };
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
  if (!user) return { ok: false, error: "Not signed in, or this account isn't provisioned." };
  try {
    await setDeploymentEnv({ MAIL_PUBSUB_TOPIC: topic.trim() });
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
