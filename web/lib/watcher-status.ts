// Pure logic behind the header's status chip (components/watcher-status.tsx):
// the health payload folded to one level and one labelled sentence. No React,
// no DOM, so it is unit tested (watcher-status.test.ts).

import { sinceLabel } from "@/lib/watcher-pulse";

/** The parts of `tracker:getHealth` the chip reads (lib/convex.ts TrackerHealth). */
export type StatusHealth = {
  watcherPushedAt: number | null;
  mail: { lastError: string | null; watchExpiration: number | null } | null;
  stuckBuilds: number;
};

export type StatusLevel = "ok" | "warn" | "bad";

export type WatcherStatus = {
  level: StatusLevel;
  /** The chip's text where there is room: "Checked 38m ago". */
  label: string;
  /** The chip's text where there is not: "38m ago". */
  short: string;
  /** One word for the popover's heading. */
  word: string;
};

const HOUR = 3600e3;
/** The watcher runs every two hours; three missed runs is worth a colour. */
const QUIET_MS = 6 * HOUR;
/** Two days without a run is a stall: new jobs are not being found. */
export const STALLED_MS = 48 * HOUR;

/**
 * One status for the whole pipeline, worst problem first. `pageStale` is the
 * page's own data being older than one watcher cycle (refresh-control.tsx):
 * it only speaks when everything upstream is fine, because a refresh is then
 * the one thing left to do.
 */
export function watcherStatus(
  h: StatusHealth | null,
  now: number,
  pageStale = false
): WatcherStatus {
  if (!h) return { level: "warn", label: "No watcher data", short: "No data", word: "Unknown" };
  if (h.watcherPushedAt === null) {
    return { level: "bad", label: "Watcher has not run", short: "No runs", word: "Needs attention" };
  }
  const age = now - h.watcherPushedAt;
  const ago = sinceLabel(h.watcherPushedAt, now);
  if (age > STALLED_MS) {
    return { level: "bad", label: `Watcher stalled, ${ago}`, short: "Stalled", word: "Needs attention" };
  }
  if (h.mail?.lastError) {
    return { level: "warn", label: "Mail sync failing", short: "Mail failing", word: "Needs attention" };
  }
  if (h.mail?.watchExpiration && h.mail.watchExpiration < now) {
    return { level: "warn", label: "Mail watch expired", short: "Mail expired", word: "Needs attention" };
  }
  if (h.stuckBuilds > 0) {
    return { level: "warn", label: "Resume build stuck", short: "Build stuck", word: "Needs attention" };
  }
  if (age > QUIET_MS) {
    return { level: "warn", label: `Last check ${ago} ago`, short: `${ago} ago`, word: "Running late" };
  }
  if (pageStale) {
    return { level: "warn", label: "Refresh for new data", short: "Refresh", word: "Page is stale" };
  }
  return { level: "ok", label: `Checked ${ago} ago`, short: `${ago} ago`, word: "Healthy" };
}

/**
 * The banner under the header while the watcher is stalled, or null. Only a
 * stall earns it: it is the one state where the lists look normal and are
 * wrong, on every screen.
 */
export function stalledNotice(h: StatusHealth | null, now: number): string | null {
  if (!h) return null;
  if (h.watcherPushedAt === null) return "The watcher has not run yet, so no jobs have been found.";
  if (now - h.watcherPushedAt <= STALLED_MS) return null;
  return `The watcher last ran ${sinceLabel(h.watcherPushedAt, now)} ago. New jobs are not being found.`;
}
