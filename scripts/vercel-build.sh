#!/usr/bin/env bash
# Vercel build command (set on the project as `bash ../scripts/vercel-build.sh`;
# Vercel's cwd is web/ because the project's Root Directory is `web`).
#
# Production: plain `next build` against the Production env (Convex prod is
# deployed separately by .github/workflows/deploy-convex.yml).
#
# Preview: every branch gets its own Convex backend with the branch's schema
# and functions, seeded from a snapshot, so a PR can be tested end to end
# without touching production data. Needs, in Vercel's Preview environment:
#   CONVEX_DEPLOY_KEY        a *preview* deploy key (Convex dashboard ->
#                            project settings -> Deploy keys)
#   CONVEX_SECRET            becomes TRACKER_SECRET on the preview deployment
#   PREVIEW_CREDENTIALS_KEY  becomes CREDENTIALS_KEY there (32 random bytes,
#                            base64; never the production key)
#   CONVEX_SEED_REPO         owner/repo whose `convex-seed` release holds
#                            convex-seed.zip (scripts/publish-convex-seed.sh)
#   CONVEX_SEED_TOKEN        token with Contents: read on that repo
# Without CONVEX_SEED_REPO the preview starts empty (logged, not silent).
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

  if [ -n "${CONVEX_SEED_REPO:-}" ]; then
    : "${CONVEX_SEED_TOKEN:?CONVEX_SEED_REPO is set but CONVEX_SEED_TOKEN is not}"
    api="https://api.github.com/repos/$CONVEX_SEED_REPO/releases/tags/convex-seed"
    asset=$(curl -fsS -H "Authorization: Bearer $CONVEX_SEED_TOKEN" \
                 -H "Accept: application/vnd.github+json" "$api" \
            | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
                const a=JSON.parse(s).assets.find(a=>a.name==="convex-seed.zip");
                if(!a){console.error("no convex-seed.zip asset on the convex-seed release");process.exit(1)}
                console.log(a.url)})')
    curl -fsSL -H "Authorization: Bearer $CONVEX_SEED_TOKEN" \
         -H "Accept: application/octet-stream" -o "$CONVEX_SCRATCH/seed.zip" "$asset"
    echo "seeding $name from $CONVEX_SEED_REPO convex-seed.zip ($(wc -c < "$CONVEX_SCRATCH/seed.zip") bytes)"
    (cd "$CONVEX_SCRATCH" && "$CONVEX" import --deployment "$name" --replace-all --yes seed.zip)
  else
    echo "CONVEX_SEED_REPO not set: preview backend $name starts EMPTY"
  fi

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
cp -r "$REPO/convex" "$REPO/package.json" "$REPO/package-lock.json" "$CONVEX_SCRATCH/"
rm -rf "$CONVEX_SCRATCH/convex/_generated"
(cd "$CONVEX_SCRATCH" && npm ci --include=dev --ignore-scripts --no-audit --no-fund --silent)

# One preview deployment per branch; a new push replaces it (and re-seeds).
preview=$(printf '%s' "${VERCEL_GIT_COMMIT_REF:-local}" | tr -c 'A-Za-z0-9-' '-' | cut -c1-60)
cd "$CONVEX_SCRATCH"
exec node_modules/.bin/convex deploy --yes \
  --preview-name "$preview" \
  --cmd "IW_PREVIEW_PHASE=build bash '$REPO/scripts/vercel-build.sh'" \
  --cmd-url-env-var-name CONVEX_URL
