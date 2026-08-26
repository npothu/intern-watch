import type { NextConfig } from "next";

// Preview builds (scripts/vercel-build.sh) give each branch its own Convex
// deployment. The server code reads process.env.CONVEX_URL at runtime, but
// the runtime env on Vercel is the shared Preview environment, so the build
// script sets CONVEX_INLINE_URL and the preview's URLs are baked into the
// bundles here. Production keeps reading the runtime env (no inlining).
const inlinedConvex = process.env.CONVEX_INLINE_URL
  ? {
      CONVEX_URL: process.env.CONVEX_URL ?? "",
      CONVEX_SITE_URL: process.env.CONVEX_SITE_URL ?? "",
    }
  : {};

const nextConfig: NextConfig = {
  env: inlinedConvex,
  async redirects() {
    return [
      {
        // Matches and Tracker are two views of `/` now (see lib/view.ts), but
        // `/tracker` was a real route for long enough to be bookmarked and to
        // sit in Clerk `redirect_url`s, so it stays alive as an entry point
        // that lands on the tracker view. Temporary rather than permanent: a
        // 308 is cached by the browser indefinitely, and the URL scheme here
        // is a UI decision, not a contract.
        source: "/tracker",
        destination: "/?view=tracker",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
