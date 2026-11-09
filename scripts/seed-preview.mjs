// Fill a freshly created preview Convex backend with synthetic data.
//
// Called by scripts/vercel-build.sh (phase 3) after `convex deploy` has pushed
// the functions to the preview backend and its TRACKER_SECRET is set. It only
// ever runs for Vercel preview builds and only against the preview backend the
// build just created; it
// writes through the normal public mutations, so it exercises the same code
// paths the watcher and the web app use.
//
// Env: CONVEX_URL (the preview backend), CONVEX_SECRET, PREVIEW_SEED_USER
// (default "nathan", which must match the Preview TRACKER_USER_MAP value).
import { createHash } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

import { buildPreviewSeed } from "./preview-seed-data.mjs";

const { VERCEL_ENV, IW_PREVIEW_PHASE, CONVEX_URL, CONVEX_SECRET } = process.env;
const user = process.env.PREVIEW_SEED_USER || "nathan";

if (VERCEL_ENV !== "preview" || IW_PREVIEW_PHASE !== "seed") {
  console.error("seed-preview: refusing to run outside a Vercel preview build");
  process.exit(2);
}
if (!CONVEX_URL || !CONVEX_SECRET) {
  console.error("seed-preview: CONVEX_URL and CONVEX_SECRET are required");
  process.exit(2);
}

const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const { items, applications, ticks, watchReport } = buildPreviewSeed(sha1, {
  today: new Date().toISOString().slice(0, 10),
});
const client = new ConvexHttpClient(CONVEX_URL);
const secret = CONVEX_SECRET;

await client.mutation(anyApi.tracker.pushMatches, { user, items, secret });
for (const a of applications) {
  await client.mutation(anyApi.tracker.recordStatus, { user, short: a.short, status: a.status, note: a.note, snapshot: a.snapshot, secret });
}
await client.mutation(anyApi.tracker.setTicks, { user, writes: ticks, secret });
await client.mutation(anyApi.settings.putWatchReport, { user, report: watchReport, secret });
console.log(`seed-preview: ${items.length} matches, ${applications.length} applications, ${ticks.length} ticks for '${user}'`);
