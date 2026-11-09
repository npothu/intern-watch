// Pure logic behind the header's watcher sparkline (components/watcher-pulse.tsx):
// runs to polyline points, and the compact "since" label. No React, no DOM.

/** One watcher run (see lib/convex.ts WatcherRun; repeated so this stays client-safe). */
export type PulseRun = { at: number; newMatches: number };

export const PULSE_W = 100;
export const PULSE_H = 20;
const WINDOW_MS = 24 * 3600e3;
/** The accent tail covers the last quarter of the window (6h). */
const TAIL_MS = WINDOW_MS / 4;
/** The end dot (r 2.5) has to fit inside the box. */
const X_MAX = PULSE_W - 2.5;
const Y_TOP = 4;
const Y_BOTTOM = 16;

export type PulseGeometry = {
  /** The whole day, muted. */
  all: string;
  /** The last quarter, accent; always at least the final segment. */
  tail: string;
  end: { x: number; y: number };
};

const round = (n: number) => Math.round(n * 10) / 10;

/** The runs inside the 24h ending at `now`, ascending, future `at` clamped to `now`. */
function windowRuns(runs: readonly PulseRun[], now: number): PulseRun[] {
  const start = now - WINDOW_MS;
  return runs
    .map((r) => ({ at: Math.min(r.at, now), newMatches: r.newMatches }))
    .filter((r) => Number.isFinite(r.at) && r.at >= start)
    .sort((a, b) => a.at - b.at);
}

/**
 * Maps runs onto the 100x20 box. The window is the 24h ending at `now` (the
 * server's render time, passed in so server and client draw the same line),
 * and the dot sits at the last run's x, so a watcher that has gone quiet
 * shows as empty space on the right. A future `at` (clock skew) is clamped
 * to `now`; input order does not matter. Height is new matches per run
 * against the window's peak: a run with nothing new sits on the baseline.
 * Null with fewer than two runs in the window - a single point is not a line.
 */
export function pulseGeometry(runs: readonly PulseRun[], now: number): PulseGeometry | null {
  const inWindow = windowRuns(runs, now);
  if (inWindow.length < 2) return null;
  const start = now - WINDOW_MS;
  const peak = Math.max(1, ...inWindow.map((r) => Math.max(0, r.newMatches)));
  const pts = inWindow.map((r) => ({
    at: r.at,
    x: round(((r.at - start) / WINDOW_MS) * X_MAX),
    y: round(Y_BOTTOM - (Math.max(0, r.newMatches) / peak) * (Y_BOTTOM - Y_TOP)),
  }));
  const fmt = (ps: typeof pts) => ps.map((p) => `${p.x},${p.y}`).join(" ");
  // The tail is the window's last 6h, from the last point before the cutoff
  // so it joins the line; at least the final segment.
  const firstInTail = pts.findIndex((p) => p.at >= now - TAIL_MS);
  const tailFrom =
    firstInTail === -1 ? pts.length - 2 : Math.min(Math.max(0, firstInTail - 1), pts.length - 2);
  const end = pts[pts.length - 1];
  return { all: fmt(pts), tail: fmt(pts.slice(tailFrom)), end: { x: end.x, y: end.y } };
}

/** The newest run's `at` (clamped to `now`), or null without runs. */
export function lastRunAt(runs: readonly PulseRun[], now: number): number | null {
  let last: number | null = null;
  for (const r of runs) if (Number.isFinite(r.at) && (last === null || r.at > last)) last = r.at;
  return last === null ? null : Math.min(last, now);
}

/** "0m" / "47m" / "3h" / "2d" since `at`; a future `at` (clock skew) reads "0m". */
export function sinceLabel(at: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - at) / 60e3));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The sparkline's accessible name, in words: the runs and new matches in
 * the drawn window (the 24h ending at `now`; negative counts read as 0) and
 * how long before `clock` (default `now`; the client's minute tick) the last
 * run was.
 */
export function pulseLabel(runs: readonly PulseRun[], now: number, clock: number = now): string {
  const day = windowRuns(runs, now);
  const found = day.reduce((n, r) => n + Math.max(0, r.newMatches), 0);
  const last = lastRunAt(runs, now);
  const ago = last === null ? "" : `, last run ${sinceLabel(last, clock)} ago`;
  return `Watcher runs, last 24 hours: ${day.length} run${day.length === 1 ? "" : "s"}, ${found} new match${found === 1 ? "" : "es"}${ago}`;
}
