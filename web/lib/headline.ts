// The Matches page's "new today" line and the UTC-day helpers behind it.
// Pure, so it is unit-tested (headline.test.ts).

/**
 * Today as the watcher writes `added`: the UTC calendar day ("YYYY-MM-DD").
 * The watcher stamps `datetime.now(UTC).date()` and a manual add stamps
 * `toISOString().slice(0, 10)`, so "new today" must compare against the UTC
 * day too - not the server's or the visitor's local one. Computed once on the
 * server and passed down, so SSR and hydration render the same text.
 */
export function utcDayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** True when an `added` day ("YYYY-MM-DD", possibly with a time) is `todayIso`. */
export function isAddedOn(added: string, todayIso: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(added) && added.slice(0, 10) === todayIso;
}

export type NewTodayCounts = {
  /** Rows added today that are still to apply. */
  newToday: number;
  /** Of those, rows from a priority employer. */
  priority: number;
};

/**
 * The line beside the Matches title, composed only from counts the page
 * already holds - no invented facts (no "since 06:00", no delivery claims).
 *
 *   "12 new today, 7 from priority companies"
 *   "1 new today, from a priority company"
 *   "Nothing new today"
 */
export function composeNewToday(c: NewTodayCounts): string {
  if (c.newToday <= 0) return "Nothing new today";
  const head = `${c.newToday} new today`;
  if (c.priority <= 0) return head;
  // "1 new today, 1 from a priority company" repeats itself; when every new
  // row is priority say so plainly.
  if (c.priority >= c.newToday) {
    return `${head}, ${c.newToday === 1 ? "from a priority company" : "all from priority companies"}`;
  }
  return `${head}, ${c.priority} from ${c.priority === 1 ? "a priority company" : "priority companies"}`;
}
