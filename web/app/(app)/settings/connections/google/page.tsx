import { resolveTrackerUser } from "@/lib/user";
import { listCredentials } from "@/lib/convex";
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

export default async function ConnectGooglePage() {
  const user = await resolveTrackerUser();
  if (!user) return null; // layout already rendered NotProvisioned

  // listCredentials can fail transiently; a failure must not crash the page,
  // so treat it as "not connected yet" and let the user retry by re-opening.
  const rows = await listCredentials(user).catch(() => []);
  const googleConnected = rows.some((r) => r.provider === "google");

  const presence = await getEnvPresence();
  // Clamp the presence projection so client state starts from server truth.
  const routeWired = false; // the /api/google/start route is not implemented in this build

  return (
    <GoogleWizard
      convexSiteUrl={convexSiteOrigin() ?? ""}
      presence={presence}
      googleConnected={googleConnected}
      adminAvailable={Boolean(process.env.CONVEX_ADMIN_KEY)}
      routeWired={routeWired}
    />
  );
}

