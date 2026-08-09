import { NextResponse } from "next/server";
import { resolveTrackerUser } from "@/lib/user";
import { newState, signState } from "@/lib/oauth-state";
import { getOAuthConfig, registerOAuthNonce } from "@/lib/convex";

/**
 * Start the Google consent flow for the signed-in user.
 *
 * This route exists so the browser is sent to Google with a state parameter
 * that the Convex callback can trust. It is the only place that knows BOTH who
 * is signed in (the Clerk session) and the secret used to sign that state, and
 * it deliberately does nothing else - no token ever passes through here.
 *
 * The redirect URI points at the Convex SITE origin, not at this app: the
 * callback is a Convex httpAction so the refresh token can be exchanged and
 * encrypted without crossing another process. The value must match what is
 * registered in Google Cloud character for character, which is why it is
 * derived from the same helper the wizard displays rather than rebuilt here.
 */

export const dynamic = "force-dynamic";

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** Mirrors convexSiteOrigin() in the wizard page - see the note there on why
 *  the site origin differs from the client API origin. */
function convexSiteOrigin(): string | null {
  const explicit = process.env.CONVEX_SITE_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  const api = process.env.CONVEX_URL?.replace(/\/+$/, "");
  if (api && api.includes(".convex.cloud")) {
    return api.replace(".convex.cloud", ".convex.site");
  }
  return null;
}

/** Send the user back to the wizard with a message rather than showing raw
 *  JSON: every caller of this route arrived by clicking a button in it. */
function backToWizard(req: Request, params: Record<string, string>) {
  const target = new URL("/settings/connections/google", new URL(req.url).origin);
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
  return NextResponse.redirect(target);
}

export async function GET(req: Request) {
  const user = await resolveTrackerUser();
  if (!user) return backToWizard(req, { googleError: "not_signed_in" });

  const site = convexSiteOrigin();
  if (!site) {
    return backToWizard(req, {
      googleError:
        "CONVEX_SITE_URL is not set, so the redirect URI cannot be built. Set it on the web server.",
    });
  }

  // The shared secret is called CONVEX_SECRET here. TRACKER_SECRET is its name
  // on the CONVEX deployment and is never set on this server - reading that
  // name made this route unreachable on every correctly configured deployment.
  const secret = process.env.CONVEX_SECRET;
  if (!secret) {
    return backToWizard(req, {
      googleError: "CONVEX_SECRET is not set on the web server.",
    });
  }

  // The client id comes from the Convex deployment, which is where the wizard's
  // step 4 writes it. Reading process.env here meant the wizard could never
  // satisfy its own precondition: the value it had just saved lived in a
  // different process.
  const config = await getOAuthConfig().catch(() => null);
  if (!config?.clientId) {
    return backToWizard(req, {
      googleError: config
        ? `Not configured on the deployment yet: ${config.missing.join(", ")}.`
        : "Could not reach the Convex deployment to read the Google client id.",
    });
  }

  const redirectUri = `${site}/gmail/callback`;
  // APP_ORIGIN over the request's own Host header: the Host is attacker
  // influenceable, and this origin ends up inside a state WE sign and is then
  // used as a redirect target by the callback. Pinning it keeps a forged Host
  // from turning our signature into an endorsement of someone else's domain.
  const appOrigin = process.env.APP_ORIGIN?.replace(/\/+$/, "") || new URL(req.url).origin;

  const state = newState(user, appOrigin, redirectUri);
  // Register before redirecting so the callback can spend it exactly once.
  // If this fails the flow must not start - an unregistered nonce would be
  // rejected at the far end anyway, and failing here says why.
  try {
    await registerOAuthNonce(state.nonce, user, state.exp);
  } catch {
    return backToWizard(req, {
      googleError: "Could not start the sign-in flow. Try again.",
    });
  }
  const signed = await signState(secret, state);

  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id", config.clientId);
  auth.searchParams.set("redirect_uri", redirectUri);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", SCOPE);
  // offline + consent together are what actually yield a refresh token: Google
  // withholds it on a repeat authorisation unless consent is forced, and a
  // mailbox connected without one silently stops syncing within the hour.
  auth.searchParams.set("access_type", "offline");
  auth.searchParams.set("prompt", "consent");
  auth.searchParams.set("include_granted_scopes", "true");
  auth.searchParams.set("state", signed);

  return NextResponse.redirect(auth.toString());
}
