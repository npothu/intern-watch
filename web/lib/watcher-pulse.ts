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

/**
 * Maps runs (ascending by `at`) onto the 100x20 box. The window is the 24h
 * ending at the newest run, so the line is a pure function of the data (no
 * clock, so server and client agree) and the dot always sits at the right
 * edge. Height is new matches per run against the day's peak: a run with
 * nothing new sits on the baseline. Null with fewer than two runs in the
 * window - a single point is not a line.
 */
export function pulseGeometry(runs: readonly PulseRun[]): PulseGeometry | null {
  if (runs.length < 2) return null;
  const last = runs[runs.length - 1].at;
  const start = last - WINDOW_MS;
  const inWindow = runs.filter((r) => r.at >= start && r.at <= last);
  if (inWindow.length < 2) return null;
  const peak = Math.max(1, ...inWindow.map((r) => Math.max(0, r.newMatches)));
  const pts = inWindow.map((r) => ({
    at: r.at,
    x: round(((r.at - start) / WINDOW_MS) * X_MAX),
    y: round(Y_BOTTOM - (Math.max(0, r.newMatches) / peak) * (Y_BOTTOM - Y_TOP)),
  }));
  const fmt = (ps: typeof pts) => ps.map((p) => `${p.x},${p.y}`).join(" ");
  // The tail starts at the last point before the cutoff, so it joins the line.
  const firstInTail = pts.findIndex((p) => p.at >= last - TAIL_MS);
  const tailFrom = Math.min(Math.max(0, firstInTail - 1), pts.length - 2);
  const end = pts[pts.length - 1];
  return { all: fmt(pts), tail: fmt(pts.slice(tailFrom)), end: { x: end.x, y: end.y } };
}

/** "0m" / "47m" / "3h" / "2d" since `at`; a future `at` (clock skew) reads "0m". */
export function sinceLabel(at: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - at) / 60e3));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** The sparkline's accessible name: what the line shows, in words. */
export function pulseLabel(runs: readonly PulseRun[]): string {
  const last = runs.length ? runs[runs.length - 1].at : 0;
  const day = runs.filter((r) => r.at >= last - WINDOW_MS);
  const found = day.reduce((n, r) => n + Math.max(0, r.newMatches), 0);
  return `Watcher runs, last 24 hours: ${day.length} run${day.length === 1 ? "" : "s"}, ${found} new match${found === 1 ? "" : "es"}`;
}
