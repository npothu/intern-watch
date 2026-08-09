import { NextResponse } from "next/server";
import { resolveTrackerUser } from "@/lib/user";
import { newState, signState } from "@/lib/oauth-state";

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

  const clientId = process.env.GMAIL_CLIENT_ID;
  const secret = process.env.TRACKER_SECRET;
  if (!clientId) {
    return backToWizard(req, {
      googleError: "GMAIL_CLIENT_ID is not set on the web server.",
    });
  }
  if (!secret) {
    return backToWizard(req, {
      googleError: "TRACKER_SECRET is not set on the web server.",
    });
  }

  const state = await signState(
    secret,
    newState(user, new URL(req.url).origin),
  );

  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.searchParams.set("client_id", clientId);
  auth.searchParams.set("redirect_uri", `${site}/gmail/callback`);
  auth.searchParams.set("response_type", "code");
  auth.searchParams.set("scope", SCOPE);
  // offline + consent together are what actually yield a refresh token: Google
  // withholds it on a repeat authorisation unless consent is forced, and a
  // mailbox connected without one silently stops syncing within the hour.
  auth.searchParams.set("access_type", "offline");
  auth.searchParams.set("prompt", "consent");
  auth.searchParams.set("include_granted_scopes", "true");
  auth.searchParams.set("state", state);

  return NextResponse.redirect(auth.toString());
}
