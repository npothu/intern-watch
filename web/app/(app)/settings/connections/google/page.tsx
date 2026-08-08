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
      convexSiteUrl={process.env.CONVEX_URL ?? ""}
      presence={presence}
      googleConnected={googleConnected}
      adminAvailable={Boolean(process.env.CONVEX_ADMIN_KEY)}
      routeWired={routeWired}
    />
  );
}
