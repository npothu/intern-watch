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
 * derived from the same helper as the connection page rather than rebuilt here.
 */

export const dynamic = "force-dynamic";

const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** Mirrors convexSiteOrigin() in the connection page - see the note there on why
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

/** Send the user back to the connection page rather than showing raw
 *  JSON: every caller of this route arrived by clicking a button in it. */
function backToConnection(req: Request, params: Record<string, string>) {
  const target = new URL("/settings/connections/google", new URL(req.url).origin);
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
  return NextResponse.redirect(target);
}

export async function GET(req: Request) {
  const user = await resolveTrackerUser();
  if (!user) return backToConnection(req, { googleError: "not_signed_in" });

  const site = convexSiteOrigin();
  if (!site) {
    console.error("Google OAuth is unavailable: CONVEX_SITE_URL could not be resolved");
    return backToConnection(req, {
      googleError: "Google sign-in is temporarily unavailable. Try again later.",
    });
  }

  // The shared secret is called CONVEX_SECRET here. TRACKER_SECRET is its name
  // on the CONVEX deployment and is never set on this server - reading that
  // name made this route unreachable on every correctly configured deployment.
  const secret = process.env.CONVEX_SECRET;
  if (!secret) {
    console.error("Google OAuth is unavailable: CONVEX_SECRET is not set");
    return backToConnection(req, {
      googleError: "Google sign-in is temporarily unavailable. Try again later.",
    });
  }

  // The client id comes from the Convex deployment, where the operator sets it.
  // Reading process.env here would look in the wrong process.
  const config = await getOAuthConfig().catch(() => null);
  if (!config) {
    console.error("Google OAuth is unavailable: could not read Convex OAuth configuration");
    return backToConnection(req, {
      googleError: "Google sign-in is temporarily unavailable. Try again later.",
    });
  }
  // Check every mail-sync precondition before sending anyone to Google, not
  // just the client id. Never ask for a Gmail grant that the deployment cannot
  // use, including when its push topic or endpoint token is not ready yet.
  // `missing` is derived from the same env reads as clientId, so an empty list
  // implies a client id - but assert it rather than assume, since these are two
  // separate fields on the wire and only one of them is load-bearing here.
  if (config.missing.length > 0 || !config.clientId) {
    console.error(
      `Google OAuth is unavailable: missing ${config.missing.join(", ") || "GMAIL_CLIENT_ID"}`,
    );
    return backToConnection(req, {
      googleError: "Google sign-in is temporarily unavailable. Try again later.",
    });
  }
  const clientId = config.clientId;

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
    return backToConnection(req, {
      googleError: "Could not start the sign-in flow. Try again.",
    });
  }
  const signed = await signState(secret, state);

  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id", clientId);
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
