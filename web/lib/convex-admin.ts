import "server-only";

/**
 * The ONE thing the Google wizard is allowed to write to the deployment: a
 * narrow setter for exactly four environment variable names, through the
 * Convex management API.
 *
 * WHY the allowlist is the whole point of this file:
 * A Convex admin key can set or overwrite ANY environment variable on the
 * deployment, including TRACKER_SECRET and CREDENTIALS_KEY. Overwriting
 * CREDENTIALS_KEY would make every stored connection credential permanently
 * undecryptable. So instead of a generic setter (which hands that foot-gun to
 * any future caller), this module exposes exactly one setter over four known
 * names and deliberately exposes NO generic setter and NO getter. Unknown
 * names are rejected by throwing, before any network request.
 *
 * The wire contract below was read out of the installed CLI source
 * (node_modules/convex/dist/cjs/cli/lib/env.js and .../cli/lib/utils/utils.js):
 *
 *   POST {CONVEX_URL}/api/update_environment_variables
 *   Authorization: Convex {CONVEX_ADMIN_KEY}
 *   Content-Type: application/json
 *   Body: {"changes":[{"name":"GMAIL_CLIENT_ID","value":"..."}]}
 *
 * A `value` of null would delete a variable; we never call it with null
 * (deleting is out of scope for the wizard), it is noted here only to keep the
 * contract faithful to the CLI.
 *
 * Presence checks do NOT go through the admin key or this module: they are
 * plain server-side `process.env` reads in the page component, exactly like
 * the deploy checklist, so reading a value never requires admin power.
 */

const CONVEX_URL = process.env.CONVEX_URL?.replace(/\/+$/, "") ?? "";

/** The ONLY names this app is allowed to write. Anything else throws. */
const SETTABLE = [
  "GMAIL_CLIENT_ID",
  "GMAIL_CLIENT_SECRET",
  "MAIL_PUBSUB_TOPIC",
  "MAIL_PUSH_TOKEN",
] as const;

export type SettableEnv = (typeof SETTABLE)[number];

/**
 * Write one or more deployment env vars. Values are strings; there is no
 * delete path. Throws on an unknown name (before any fetch), a missing admin
 * key, or a non-2xx response (the response body text is surfaced).
 */
export async function setDeploymentEnv(
  vars: Partial<Record<SettableEnv, string>>
): Promise<void> {
  const entries = Object.entries(vars) as [SettableEnv, string][];
  if (entries.length === 0) return;

  // Reject unknown names BEFORE the fetch so an accidental typo can never
  // forward a name to the admin endpoint. This is the safety property of the
  // allowlist made explicit.
  for (const [name] of entries) {
    if (!SETTABLE.includes(name)) {
      throw new Error(`refusing to set non-allowlisted env var "${name}"`);
    }
  }

  const adminKey = process.env.CONVEX_ADMIN_KEY;
  if (!adminKey) {
    throw new Error(
      "CONVEX_ADMIN_KEY is not set - the Google wizard cannot write deployment settings"
    );
  }
  if (!CONVEX_URL) {
    throw new Error("CONVEX_URL is not set - cannot reach the Convex deployment");
  }

  const changes = entries.map(([name, value]) => ({ name, value }));
  let resp: Response;
  try {
    resp = await fetch(`${CONVEX_URL}/api/update_environment_variables`, {
      method: "POST",
      headers: {
        Authorization: `Convex ${adminKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ changes }),
      // Management writes must never be served from a cache.
      cache: "no-store",
    });
  } catch (err) {
    throw new Error(
      `failed to reach the Convex management API: ${(err as Error).message}`
    );
  }

  if (!resp.ok) {
    // Surface the response body in the error - a bare status loses the actual
    // reason (e.g. an expired key or a 400 with a detailed message).
    const body = await resp.text();
    throw new Error(
      `Convex management API error (HTTP ${resp.status}): ${body || "unknown"}`
    );
  }
}
