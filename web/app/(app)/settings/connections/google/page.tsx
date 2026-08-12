import { resolveTrackerUser } from "@/lib/user";
import { getMailAccount, getOAuthConfig } from "@/lib/convex";
import { GoogleConnection } from "@/components/settings/google-connection";

export const metadata = { title: "Connect Gmail - intern-watch" };

export const dynamic = "force-dynamic";

/**
 * Settings -> Connections -> Connect Gmail.
 *
 * Deployment configuration belongs to the operator and stays out of this user
 * flow. The page only reports whether sign-in is available, shows the current
 * mailbox, and starts OAuth.
 */
/**
 * The origin that serves Convex HTTP actions, which is NOT the client API
 * origin. `/gmail/callback` and `/gmail/push` are both httpAction routes
 * (convex/http.ts), so they live on the site origin: `*.convex.site` in the
 * cloud, and a different local port for a local deployment (3212 vs 3213).
 *
 * Handing out the client-API origin here would produce a redirect URI that
 * Google accepts and then redirects to nothing, which is exactly the silent,
 * character-for-character failure this flow exists to prevent. So prefer the
 * explicit CONVEX_SITE_URL, fall back to the documented cloud mapping, and
 * return null rather than guess.
 */
function convexSiteOrigin(): string | null {
  const explicit = process.env.CONVEX_SITE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const api = process.env.CONVEX_URL?.replace(/\/+$/, "");
  if (api && api.includes(".convex.cloud")) {
    return api.replace(".convex.cloud", ".convex.site");
  }
  return null;
}

export default async function ConnectGmailPage({
  searchParams,
}: {
  // Set by the Convex /gmail/callback redirect at the end of the consent flow.
  searchParams: Promise<{ connected?: string; googleError?: string }>;
}) {
  const user = await resolveTrackerUser();
  if (!user) return null; // layout already rendered NotProvisioned
  const { connected, googleError } = await searchParams;

  // Ask the table the OAuth flow actually writes. This used to check the
  // `credentials` table, which nothing in the flow touches, so a successful
  // connect left the step permanently unchecked while the banner said it had
  // worked. A transient failure must not crash the page, so it degrades to
  // "not connected" and the user can retry by re-opening.
  const account = await getMailAccount(user).catch(() => null);

  // Check every OAuth prerequisite, but expose only one availability bit to the
  // end user. Missing environment variables are an operator concern.
  const oauth = await getOAuthConfig().catch(() => null);
  const site = convexSiteOrigin();
  const available = Boolean(
    oauth &&
      oauth.missing.length === 0 &&
      oauth.clientId &&
      process.env.CONVEX_SECRET &&
      site,
  );
  const callbackConfirmed = Boolean(connected && account?.email === connected);

  return (
    <GoogleConnection
      available={available}
      // Only show callback success when the authoritative stored mailbox
      // agrees with the query parameter.
      connectedEmail={callbackConfirmed ? account?.email : undefined}
      alreadyConnectedEmail={account?.email}
      oauthError={googleError}
    />
  );
}
