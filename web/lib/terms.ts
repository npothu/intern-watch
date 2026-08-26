// Rolling internship terms, mirrored from src/terms.py so the Settings >
// Watch page can preview a lead-time or horizon change before the watcher
// runs. Same season start dates, same window arithmetic, same statuses;
// keep the two in step (tests on both sides pin the same dates).

export const SEASONS = ["Spring", "Summer", "Fall"] as const;
export type Season = (typeof SEASONS)[number];

const SEASON_START: Record<string, [number, number]> = {
  Spring: [1, 10],
  Summer: [5, 20],
  Fall: [8, 20],
  Winter: [12, 1],
};

export const DEFAULT_LEAD_WEEKS = 3;
export const DEFAULT_HORIZON_MONTHS = 14;

const TERM_RE = /^\s*(Spring|Summer|Fall|Winter)\s+(20\d\d)\s*$/i;

/** Calendar date without a time zone: "YYYY-MM-DD" in, plain arithmetic out. */
export type Day = { y: number; m: number; d: number };

export function day(y: number, m: number, d: number): Day {
  return { y, m, d };
}

export function dayFromIso(iso: string): Day {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
}

export function isoOf(a: Day): string {
  return `${a.y}-${String(a.m).padStart(2, "0")}-${String(a.d).padStart(2, "0")}`;
}

/** Today in the browser's local calendar. */
export function todayLocal(now: Date = new Date()): Day {
  return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
}

function toUtc(a: Day): number {
  return Date.UTC(a.y, a.m - 1, a.d);
}

function fromUtc(ms: number): Day {
  const t = new Date(ms);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function compare(a: Day, b: Day): number {
  return toUtc(a) - toUtc(b);
}

export function addDays(a: Day, n: number): Day {
  return fromUtc(toUtc(a) + n * 86_400_000);
}

/** Calendar-month arithmetic, clamping the day (Jan 31 + 1 -> Feb 28). */
export function addMonths(a: Day, months: number): Day {
  const month0 = a.m - 1 + months;
  const y = a.y + Math.floor(month0 / 12);
  const m = ((month0 % 12) + 12) % 12 + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { y, m, d: Math.min(a.d, last) };
}

export function parseTerm(term: string): { season: string; year: number } | null {
  const m = TERM_RE.exec(term ?? "");
  if (!m) return null;
  const season = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return { season, year: Number(m[2]) };
}

export function termStart(term: string): Day | null {
  const p = parseTerm(term);
  if (!p) return null;
  const [m, d] = SEASON_START[p.season];
  return { y: p.year, m, d };
}

export function termSeason(term: string): Season | null {
  const p = parseTerm(term);
  return p && (SEASONS as readonly string[]).includes(p.season) ? (p.season as Season) : null;
}

export function window(today: Day, leadWeeks: number, horizonMonths: number): [Day, Day] {
  return [addDays(today, leadWeeks * 7), addMonths(today, horizonMonths)];
}

export function rollingTerms(
  today: Day,
  leadWeeks = DEFAULT_LEAD_WEEKS,
  horizonMonths = DEFAULT_HORIZON_MONTHS,
): string[] {
  const [lo, hi] = window(today, leadWeeks, horizonMonths);
  const out: string[] = [];
  for (let y = lo.y; y <= hi.y; y++) {
    for (const season of SEASONS) {
      const [m, d] = SEASON_START[season];
      const start = { y, m, d };
      if (compare(lo, start) <= 0 && compare(start, hi) <= 0) out.push(`${season} ${y}`);
    }
  }
  return out;
}

export function sortTerms(terms: string[]): string[] {
  const known = terms.filter((t) => termStart(t));
  const unknown = terms.filter((t) => !termStart(t));
  known.sort((a, b) => compare(termStart(a)!, termStart(b)!));
  return [...known, ...unknown];
}

export type TermStatus = "auto" | "included" | "excluded" | "past" | "beyond";

export type TermRow = {
  term: string;
  start: string;
  wanted: boolean;
  status: TermStatus;
  addedOn: string;
  dropsOn: string;
};

export type TermsConfig = {
  leadWeeks: number;
  horizonMonths: number;
  include: string[];
  exclude: string[];
};

/**
 * Every term worth showing: the window's terms, the pinned ones, and the
 * term that most recently dropped out (so "Fall 2026 · dropped Aug 3"
 * explains its absence). Chronological. Mirrors src/terms.py term_rows.
 */
export function termRows(cfg: TermsConfig, today: Day): TermRow[] {
  const include = cfg.include.filter(parseTerm);
  const exclude = cfg.exclude.filter(parseTerm);
  const [lo] = window(today, cfg.leadWeeks, cfg.horizonMonths);
  const auto = rollingTerms(today, cfg.leadWeeks, cfg.horizonMonths);

  let previous: string | null = null;
  for (let y = lo.y - 1; y <= lo.y; y++) {
    for (const season of SEASONS) {
      const [m, d] = SEASON_START[season];
      if (compare({ y, m, d }, lo) < 0) previous = `${season} ${y}`;
    }
  }

  const names = sortTerms([...new Set([...auto, ...include, ...exclude, ...(previous ? [previous] : [])])]);
  return names.map((term) => {
    const start = termStart(term)!;
    let status: TermStatus;
    let wanted: boolean;
    if (exclude.includes(term)) [status, wanted] = ["excluded", false];
    else if (include.includes(term)) [status, wanted] = ["included", true];
    else if (auto.includes(term)) [status, wanted] = ["auto", true];
    else if (compare(start, lo) < 0) [status, wanted] = ["past", false];
    else [status, wanted] = ["beyond", false];
    return {
      term,
      start: isoOf(start),
      wanted,
      status,
      addedOn: isoOf(addMonths(start, -cfg.horizonMonths)),
      dropsOn: isoOf(addDays(start, -cfg.leadWeeks * 7)),
    };
  });
}

/** "Aug 3" / "Aug 3, 2027" - short date for the term rows. */
export function shortDate(iso: string, today: Day): string {
  const d = dayFromIso(iso);
  const month = new Date(Date.UTC(d.y, d.m - 1, d.d)).toLocaleString("en-US", {
    month: "short",
    timeZone: "UTC",
  });
  return d.y === today.y ? `${month} ${d.d}` : `${month} ${d.d}, ${d.y}`;
}
