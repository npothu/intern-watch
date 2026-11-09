import { resolveTrackerUser } from "@/lib/user";
import { getResumeUrls, type MatchFacts, type ResumeMeta } from "@/lib/convex";
import { loadCore, toTriageRows } from "@/lib/app-data";
import { buildTrackerRows } from "@/components/tracker/build-rows";
import { AppViews } from "@/components/app-views";
import { LoadedAt } from "@/components/loaded-at";
import type { TrackerRow } from "@/components/tracker/tracker-lib";

/**
 * The app route - it serves both surfaces, matches and tracker, and the URL
 * says which one is showing (see lib/view.ts). One server render loads
 * everything both need, so switching views is client-side and instant.
 *
 * The two datasets cost nothing extra to load together: matches, ticks,
 * ledger and resume URLs come in one parallel batch, a superset of what each
 * surface used to fetch on its own. The first four go through lib/app-data's
 * per-request cache, which the layout's header counts read too, so `/` still
 * queries each of them once.
 *
 * The app layout already renders the "not provisioned" screen when
 * resolveTrackerUser() is null, so a null here shouldn't happen - guard anyway
 * so this component never renders a broken page on its own.
 */

export const dynamic = "force-dynamic";

export type TriageRow = {
  key: string;
  short: string;
  company: string;
  title: string;
  location: string;
  term: string;
  added: string;
  tag: string;
  /** Priority employer at match time: pinned to the top of its term group. */
  priority?: boolean;
  salary: string;
  url: string;
  resumeUrl: string | null;
  /** Full build metadata (report, previous version) for the report dialog. */
  resumeMeta?: ResumeMeta | null;
  applied: boolean;
  saved: boolean;
  dismissed: boolean;
  hasJobDescription: boolean;
  /** The liveness probe marked the posting closed (convex/liveness_probe.ts);
   *  always false on applied rows. */
  closed?: boolean;
  /** How the watcher decided and delivered the match; absent on older rows. */
  facts?: MatchFacts;
};

export default async function AppPage() {
  const user = await resolveTrackerUser();
  if (!user) return null;

  // Preferences ride along so the surface reflects them on this render:
  // priority employers pin their rows now, and terms switched off stay out
  // of the way. A failed preferences read degrades to "no preferences known".
  const [core, resumes] = await Promise.all([loadCore(user), getResumeUrls(user)]);

  const matches: TriageRow[] = toTriageRows(core, resumes);
  const applications: TrackerRow[] = buildTrackerRows(core.ledger, core.matches, resumes);

  return (
    <>
      <LoadedAt />
      <AppViews
        matches={matches}
        applications={applications}
        wantedTerms={core.prefs.wantedTerms}
        todayIso={core.todayIso}
      />
    </>
  );
}
