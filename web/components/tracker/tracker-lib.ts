/**
 * Tracker domain: statuses, normalization helpers, and the waiting chip
 * rules. The statuses are an authoritative TS mirror of src/ledger.py
 * STATUSES - keep them in lockstep. "Ghosted" is deliberately absent: it is
 * auto-detected from inactivity, never stored.
 *
 * This module is pure (no node imports) so it can be imported by both the
 * server page/actions and the client tracker component.
 */

export const STATUS_ORDER = [
  "applied",
  "oa",
  "phone_screen",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
] as const;

export type TrackerStatus = (typeof STATUS_ORDER)[number];

/** Human labels, matched to the Python webui's STATUSES map. */
export const STATUS_LABELS: Record<TrackerStatus, string> = {
  applied: "Applied",
  oa: "OA",
  phone_screen: "Phone screen",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

export function isTrackerStatus(value: string): value is TrackerStatus {
  return (STATUS_ORDER as readonly string[]).includes(value);
}

/** Statuses that mean "still in the running" - a live application can go
 * quiet, which is what the waiting chip flags. (Offer/rejected/withdrawn are
 * terminal.) Mirrors the webui ACTIVE_ST. */
export const LIVE_STATUSES = new Set<TrackerStatus>([
  "applied",
  "oa",
  "phone_screen",
  "interview",
]);

/** A single ledger history entry. The file ledger (src/ledger.py) stores
 * `on` (yyyy-mm-dd); the Convex ledger stores `at` (ISO datetime). Both are
 * accepted. */
export type HistoryEntry = {
  on?: string;
  at?: string;
  status: string;
  note?: string;
};

/** A tracker row after the server has joined the ledger record with its
 * display snapshot (or the match row fallback). */
export type TrackerRow = {
  short: string;
  status: string;
  appliedDate: string;
  lastActivity: string;
  lastNote: string;
  history: HistoryEntry[];
  company: string;
  title: string;
  url: string;
  resumeUrl?: string;
};

/** Days thresholds, mirroring the Python webui. */
export const WAIT_DAYS = 10; // >= this many quiet days on a live status -> "waiting Nd"
export const GHOST_DAYS = 21; // >= this many quiet days on a live status -> "no response Nd"

/** `on` (file ledger) or `at` (Convex) - whichever the entry carries. */
export function entryDate(e: HistoryEntry): string {
  return e.on || e.at || "";
}

/** The most recent note across history (the webui shows the last note). */
export function lastNoteOf(history: HistoryEntry[]): string {
  let note = "";
  for (const e of history) if (e.note) note = e.note;
  return note;
}

/** Whole days between an activity date (yyyy-mm-dd, or ISO datetime) and
 * now. Non-date input yields 0. */
export function daysSince(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  if (!m) return 0;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (Number.isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 864e5);
}

/** "Aug 5" style date for a yyyy-mm-dd (or ISO datetime) value. */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  if (!m) return "";
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return dt.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Quiet-day count for the waiting chip. Only live statuses accumulate: a
 * terminal status (offer/rejected/withdrawn) is never "waiting".
 */
export function waitingDays(row: Pick<TrackerRow, "status" | "lastActivity">): number {
  if (!LIVE_STATUSES.has(row.status as TrackerStatus)) return 0;
  return daysSince(row.lastActivity);
}
