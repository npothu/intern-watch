"use client";

import { Triage } from "@/components/matches/triage";
import { Tracker } from "@/components/tracker/tracker";
import { useSearchParams } from "next/navigation";
import { useAppView } from "@/lib/view";
import { PAGE } from "@/lib/layout";
import { usePublishViewCount } from "@/components/nav/view-counts";
import { parseUrlState } from "@/components/matches/matches-lib";
import type { TriageRow } from "@/app/(app)/page";
import type { TrackerRow } from "@/components/tracker/tracker-lib";

/**
 * Picks the surface the URL asks for. Both datasets arrive already loaded from
 * the one server render, so switching is a re-render of this component and
 * nothing more - no round trip, no refetch, no shell repaint.
 *
 * Only the active view is mounted. Each surface owns window-level keyboard
 * handling and its own command palette, and two of those alive at once would
 * fight (one Cmd+K opening two palettes, triage's j/k firing under the
 * tracker). Mounting one at a time also means each view arrives with its
 * entrance motion, which is what a tab change should look like; the cost is
 * that per-view filter and cursor state does not survive a switch, exactly as
 * it did not when these were separate routes.
 */
export function AppViews({
  matches,
  applications,
  wantedTerms,
  todayIso,
}: {
  matches: TriageRow[];
  applications: TrackerRow[];
  /** Terms the preferences want today; null when unknown (nothing hidden). */
  wantedTerms: string[] | null;
  /** The UTC day the server read this at, for "new today" (lib/headline.ts). */
  todayIso: string;
}) {
  const { view, job } = useAppView();
  const params = useSearchParams();
  // The header nav's Tracker count. Matches has a single publisher, Triage,
  // which knows whether unwatched terms are being shown; the layout seeds
  // both on the server for every screen.
  usePublishViewCount("tracker", applications.length);

  if (view === "tracker") {
    return (
      <div className={PAGE}>
        <Tracker key={job ?? "tracker"} rows={applications} initialSelected={job} />
      </div>
    );
  }

  // The matches view (?filter= ?term= ?sort= ?open=) is read once, at mount;
  // Triage keeps the URL in step with it from then on.
  return (
    <Triage
      key={job ?? "matches"}
      rows={matches}
      initialSelected={job}
      initialView={parseUrlState(params)}
      wantedTerms={wantedTerms}
      todayIso={todayIso}
    />
  );
}
