import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server";

/**
 * Protects browser routes except Clerk sign-in/sign-up. Runs only
 * at request time (never at build), so dummy env keys can't break `next build`.
 */
// Sign-in/up are catch-all routes: Clerk mounts subpaths under them (e.g.
// /sign-in/sso-callback for OAuth), so the whole prefix must stay public.
const PUBLIC_RE = /^\/sign-(in|up)(\/.*)?$/;

const browserMiddleware = clerkMiddleware(async (auth, req) => {
  const { userId } = await auth();
  const { pathname } = req.nextUrl;

  if (!userId && !PUBLIC_RE.test(pathname)) {
    const signIn = new URL("/sign-in", req.url);
    signIn.searchParams.set("redirect_url", pathname);
    return NextResponse.redirect(signIn);
  }
  return NextResponse.next();
});

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (request.nextUrl.pathname.startsWith("/api/resume/files/") && request.headers.has("Authorization")) return NextResponse.next();
  // The versioned script API authenticates its own bearer key and must never
  // redirect scripts to Clerk or require Clerk to be configured.
  if (request.nextUrl.pathname === "/api/v1" || request.nextUrl.pathname.startsWith("/api/v1/")) return NextResponse.next();
  return browserMiddleware(request, event);
}

export const config = {
  // Match all app routes except Next internals and files with a dot in the
  // path (static assets), so sign-in/sign-up are still caught and whitelisted
  // inside the handler.
  matcher: ["/((?!_next|.*\\..*).*)"],
};
