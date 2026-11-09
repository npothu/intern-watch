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
  if (c.shown === 0) {
    return { label: "Matches · 0 shown", headline: "No matches for these filters." };
  }
  if (c.hidden) {
    const noun = c.shown === 1 ? "hidden match" : "hidden matches";
    return {
      label: `Matches · ${c.shown} hidden`,
      headline: `${capitalize(numberWord(c.shown))} ${noun}.`,
    };
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
