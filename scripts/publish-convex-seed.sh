#!/usr/bin/env bash
# Publish a Convex snapshot as the seed for per-PR preview deployments.
#
#   scripts/publish-convex-seed.sh <owner/data-repo> [snapshot.zip]
#
# Uploads the zip as `convex-seed.zip` on the `convex-seed` release of the
# (private) data repo; scripts/vercel-build.sh downloads it when it builds a
# preview. Without a zip argument, exports the production deployment first
# (needs `npx convex login` and a linked project: `npx convex dev --once`).
# Re-run whenever previews should start from fresher data.
set -euo pipefail

repo=${1:?usage: publish-convex-seed.sh <owner/data-repo> [snapshot.zip]}
zip=${2:-}
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if [ -z "$zip" ]; then
  zip=$(mktemp -u "${TMPDIR:-/tmp}/convex-seed.XXXXXX.zip")
  (cd "$REPO" && npx convex export --prod --include-file-storage --path "$zip")
fi
[ -s "$zip" ] || { echo "no snapshot at $zip" >&2; exit 1; }

gh release view convex-seed --repo "$repo" >/dev/null 2>&1 \
  || gh release create convex-seed --repo "$repo" --latest=false \
       --title "Convex preview seed" \
       --notes "Snapshot used to seed per-PR Convex preview deployments (intern-watch scripts/publish-convex-seed.sh)."
tmp=$(mktemp -d); cp "$zip" "$tmp/convex-seed.zip"
gh release upload convex-seed "$tmp/convex-seed.zip" --repo "$repo" --clobber
rm -rf "$tmp"
echo "published $(wc -c < "$zip") bytes as convex-seed.zip on $repo"
