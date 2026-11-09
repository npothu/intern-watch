/**
 * The Matches page's mono label and headline, composed only from counts the
 * page already holds - no invented facts (no "since 06:00", no delivery
 * claims). Pure so it is unit-tested (headline.test.ts).
 *
 *   label     "Matches · 4 new today"  /  "Matches · 9 shown"
 *   headline  "Four new matches, two from priority companies."
 *             "Nine matches, three from priority companies."
 *             "No matches for these filters."
 */

const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
] as const;

/** Spelled out up to twelve, digits above (and for anything not a count). */
export function numberWord(n: number): string {
  return Number.isInteger(n) && n >= 0 && n < WORDS.length ? WORDS[n] : String(n);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

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

export type HeadingCounts = {
  /** Rows the table is showing right now. */
  shown: number;
  /** Of those, rows from a priority employer. */
  priority: number;
  /** Of those, rows whose `added` day is today. */
  newToday: number;
  /** Of the new-today rows, the priority ones. */
  newTodayPriority: number;
  /** The table is showing the hidden list, so "new" would mislead. */
  hidden?: boolean;
};

export function composeMatchesHeading(c: HeadingCounts): {
  label: string;
  headline: string;
} {
  // The hidden list first: with nothing hidden it is still the hidden list,
  // not "0 shown" of the main one.
  if (c.hidden) {
    if (c.shown === 0) return { label: "Matches · 0 hidden", headline: "No hidden matches." };
    const noun = c.shown === 1 ? "hidden match" : "hidden matches";
    return {
      label: `Matches · ${c.shown} hidden`,
      headline: `${capitalize(numberWord(c.shown))} ${noun}.`,
    };
  }
  if (c.shown === 0) {
    return { label: "Matches · 0 shown", headline: "No matches for these filters." };
  }
  const fresh = c.newToday > 0;
  const count = fresh ? c.newToday : c.shown;
  const pri = fresh ? c.newTodayPriority : c.priority;
  const noun = `${fresh ? "new " : ""}${count === 1 ? "match" : "matches"}`;
  let headline = `${capitalize(numberWord(count))} ${noun}`;
  if (pri > 0) {
    // "One match, from a priority company." reads wrong; when every row is
    // priority say so plainly instead of repeating the number.
    if (pri === count) {
      headline += count === 1 ? ", from a priority company" : ", all from priority companies";
    } else {
      headline += `, ${numberWord(pri)} from ${pri === 1 ? "a priority company" : "priority companies"}`;
    }
  }
  return {
    label: fresh ? `Matches · ${c.newToday} new today` : `Matches · ${c.shown} shown`,
    headline: `${headline}.`,
  };
}
