import { resolveTrackerUser } from "@/lib/user";
import { getLedger, getMatches, getResumeUrls } from "@/lib/convex";
import { buildTrackerRows } from "@/components/tracker/build-rows";
import { Tracker } from "@/components/tracker/tracker";

export const dynamic = "force-dynamic";

/**
 * Tracker page: the applications ledger. Server component - resolves the
 * signed-in user, fetches the ledger + match snapshot + resume URLs from
 * Convex, joins them into typed rows, and hands them to the client Tracker
 * component for rendering and optimistic status updates.
 */
export default async function TrackerPage() {
  const user = await resolveTrackerUser();
  if (!user) {
    // The (app) layout already renders the "not provisioned" screen in this
    // case, so this is just a safety net for an unconfigured build.
    return null;
  }

  const [ledger, matches, resumeUrls] = await Promise.all([
    getLedger(user),
    getMatches(user),
    getResumeUrls(user),
  ]);

  const rows = buildTrackerRows(ledger, matches, resumeUrls);

  return (
    <div className="mx-auto w-full max-w-[1060px] px-5 py-6">
      <h1 className="text-xs font-semibold uppercase tracking-[0.09em] text-ink-2">
        Tracker
      </h1>
      <Tracker rows={rows} />
    </div>
  );
}
