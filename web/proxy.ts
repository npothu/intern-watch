import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

/**
 * Protects the whole app except the Clerk sign-in/sign-up routes. Runs only
 * at request time (never at build), so dummy env keys can't break `next build`.
 */
// Sign-in/up are catch-all routes: Clerk mounts subpaths under them (e.g.
// /sign-in/sso-callback for OAuth), so the whole prefix must stay public.
const PUBLIC_RE = /^(\/sign-(in|up)(\/.*)?|\/lavish(\/.*)?)$/;

export default clerkMiddleware(async (auth, req) => {
  const { userId } = await auth();
  const { pathname } = req.nextUrl;

  if (!userId && !PUBLIC_RE.test(pathname)) {
    const signIn = new URL("/sign-in", req.url);
    signIn.searchParams.set("redirect_url", pathname);
    return NextResponse.redirect(signIn);
  }
  return NextResponse.next();
});

export const config = {
  // Match all app routes except Next internals and files with a dot in the
  // path (static assets), so sign-in/sign-up are still caught and whitelisted
  // inside the handler.
  matcher: ["/((?!_next|.*\\..*).*)"],
};
