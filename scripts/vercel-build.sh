#!/usr/bin/env bash
# Vercel build command (set on the project as `bash ../scripts/vercel-build.sh`;
# Vercel's cwd is web/ because the project's Root Directory is `web`).
#
# Production: plain `next build` against the Production env (Convex prod is
# deployed separately by .github/workflows/deploy-convex.yml).
#
# Preview: every branch gets its own Convex backend with the branch's schema
# and functions, with an empty database, so a PR can be tested end to end
# without touching production data. Needs, in Vercel's Preview environment:
#   CONVEX_DEPLOY_KEY        a *preview* deploy key (Convex dashboard ->
#                            project settings -> Deploy keys)
#   CONVEX_SECRET            becomes TRACKER_SECRET on the preview deployment
#   PREVIEW_CREDENTIALS_KEY  becomes CREDENTIALS_KEY there (32 random bytes,
#                            base64; never the production key)
#
# The Convex bundler needs the ROOT package.json deps (docx, pdfkit, ...), but
# the web build must keep resolving against web/package.json alone (see
# CLAUDE.md), so the deploy runs from a scratch copy of convex/ + the root
# manifests in $TMPDIR, never installing anything into the repo root.
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if [ "${IW_PREVIEW_PHASE:-}" = "build" ]; then
  # ---- phase 2: inside `convex deploy --cmd`, CONVEX_URL = the preview URL --
  name=${CONVEX_URL#https://}; name=${name%%.*}
  echo "preview backend: $name ($CONVEX_URL)"
  CONVEX="$CONVEX_SCRATCH/node_modules/.bin/convex"
  (cd "$CONVEX_SCRATCH" \
    && "$CONVEX" env set --deployment "$name" TRACKER_SECRET "$CONVEX_SECRET" \
    && "$CONVEX" env set --deployment "$name" CREDENTIALS_KEY "$PREVIEW_CREDENTIALS_KEY")

  echo "Preview backend $name starts empty. Production snapshots are never imported."

  # Inline the preview's URLs into the Next.js bundles (web/next.config.ts):
  # the server code reads process.env.CONVEX_URL at runtime, and the runtime
  # env is the shared Preview environment, not this deployment.
  export CONVEX_SITE_URL="${CONVEX_URL/.convex.cloud/.convex.site}"
  export CONVEX_INLINE_URL=1
  exec npm --prefix "$REPO/web" run build
fi

# ---- phase 1 ---------------------------------------------------------------
if [ "${VERCEL_ENV:-}" != "preview" ]; then
  exec npm --prefix "$REPO/web" run build
fi

: "${CONVEX_DEPLOY_KEY:?preview builds need a Convex preview deploy key in the Vercel Preview environment}"
: "${CONVEX_SECRET:?}"
: "${PREVIEW_CREDENTIALS_KEY:?}"

export CONVEX_SCRATCH
CONVEX_SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/convex-deploy.XXXXXX")
cp -r "$REPO/convex" "$REPO/shared" "$REPO/package.json" "$REPO/package-lock.json" "$CONVEX_SCRATCH/"
rm -rf "$CONVEX_SCRATCH/convex/_generated"
(cd "$CONVEX_SCRATCH" && npm ci --include=dev --ignore-scripts --no-audit --no-fund --silent)

# Recreate the branch backend on every push so old production seed data cannot survive.
preview=$(printf '%s' "${VERCEL_GIT_COMMIT_REF:-local}" | tr -c 'A-Za-z0-9-' '-' | cut -c1-60)
cd "$CONVEX_SCRATCH"
exec node_modules/.bin/convex deploy --yes \
  --preview-create "$preview" \
  --cmd "IW_PREVIEW_PHASE=build bash '$REPO/scripts/vercel-build.sh'" \
  --cmd-url-env-var-name CONVEX_URL
