import { isAdminUser, resolveTrackerUser } from "@/lib/user";
import { getMailAccount, getOAuthConfig } from "@/lib/convex";
import { GoogleWizard } from "@/components/settings/google-wizard";
import { getEnvPresence } from "./google-actions";

export const metadata = { title: "Connect Google - intern-watch" };

export const dynamic = "force-dynamic";

/**
 * Settings -> Connections -> Connect Google. A server component that computes
 * the wizard's real server state (deployment env presence, whether a `google`
 * credential row exists, whether the admin key and OAuth route are available)
 * and hands it to the client wizard. No secret values ever cross this boundary
 * - only booleans plus the public Convex site origin used to build URLs.
 */
/**
 * The origin that serves Convex HTTP actions, which is NOT the client API
 * origin. `/gmail/callback` and `/gmail/push` are both httpAction routes
 * (convex/http.ts), so they live on the site origin: `*.convex.site` in the
 * cloud, and a different local port for a local deployment (3212 vs 3213).
 *
 * Handing out the client-API origin here would produce a redirect URI that
 * Google accepts and then redirects to nothing, which is exactly the silent,
 * character-for-character failure this wizard exists to prevent. So prefer the
 * explicit CONVEX_SITE_URL, fall back to the documented cloud mapping, and
 * return null rather than guess - the wizard renders an honest "set
 * CONVEX_SITE_URL" note instead of a confidently wrong URL.
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

export default async function ConnectGooglePage({
  searchParams,
}: {
  // Set by the Convex /gmail/callback redirect at the end of the consent flow.
  // Read here rather than with useSearchParams so the wizard stays a plain
  // client component with no Suspense boundary to arrange.
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
  const googleConnected = account !== null;

  const presence = await getEnvPresence();

  // Whether the consent flow can run, and if not, exactly what is missing.
  //
  // Every input is read from where it actually lives: the client id from the
  // Convex deployment (the wizard's step 4 writes it there), the shared secret
  // under its WEB name CONVEX_SECRET, and the site origin from config. The
  // previous version read GMAIL_CLIENT_ID and TRACKER_SECRET from this server's
  // env - neither of which is set here - so it was false on every deployment
  // and the feature was unreachable with no explanation.
  const oauth = await getOAuthConfig().catch(() => null);
  const site = convexSiteOrigin();
  const routeBlockers = [
    !oauth && "the Convex deployment is unreachable",
    ...(oauth?.missing ?? []).map((m) => `${m} on the deployment`),
    !process.env.CONVEX_SECRET && "CONVEX_SECRET on the web server",
    !site && "CONVEX_SITE_URL on the web server",
  ].filter((x): x is string => typeof x === "string");
  const routeWired = routeBlockers.length === 0;

  // The wizard's write steps change deployment-wide vars, so they are gated on
  // admin membership for the display AND re-checked inside each server action.
  const admin = await isAdminUser(user);

  return (
    <GoogleWizard
      convexSiteUrl={convexSiteOrigin() ?? ""}
      presence={presence}
      googleConnected={googleConnected}
      adminAvailable={Boolean(process.env.CONVEX_ADMIN_KEY)}
      routeWired={routeWired}
      routeBlockers={routeBlockers}
      // Truth about step 4 comes from the CONVEX deployment, which is where
      // those values live. getEnvPresence reads this server's env and reports
      // false there, which kept step 5 disabled even after step 4 succeeded.
      clientConfigured={Boolean(
        oauth && !oauth.missing.includes("GMAIL_CLIENT_ID") &&
          !oauth.missing.includes("GMAIL_CLIENT_SECRET"),
      )}
      // ONLY the query param. Falling back to the stored address made a failed
      // return render the green "Connected" banner above the red failure one,
      // and made every ordinary visit open on step 5 claiming success.
      connectedEmail={connected}
      alreadyConnectedEmail={account?.email}
      oauthError={googleError}
      admin={admin}
    />
  );
}

