"use client";

import { Triage } from "@/components/matches/triage";
import { Tracker } from "@/components/tracker/tracker";
import { useAppView } from "@/lib/view";
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
}: {
  matches: TriageRow[];
  applications: TrackerRow[];
}) {
  const { view, filter } = useAppView();

  if (view === "tracker") {
    // No heading here - Tracker's own first row now opens with the view
    // switch, which makes a standalone "Tracker" label redundant with the
    // active cell it sits beside.
    return (
      <div className="mx-auto w-full max-w-[1060px] px-5 py-5">
        <Tracker rows={applications} />
      </div>
    );
  }

  return <Triage rows={matches} initialFilter={filter} />;
}
