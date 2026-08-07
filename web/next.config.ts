import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
