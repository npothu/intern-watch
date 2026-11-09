// Pure logic behind the Matches table: filter composition with per-axis
// counts, sort comparators, the term short code, the "found" age, the
// report summary line and the URL view state. No React and no DOM here, so
// all of it is unit tested directly (matches-lib.test.ts).

import type { TriageRow } from "@/app/(app)/page";
import type { ResumeReport } from "@/lib/convex";
import { compare, dayFromIso, parseTerm, sortTerms, termStart, type Day } from "@/lib/terms";
import { isKnownTerm } from "@/lib/preferences";

/**
 * The status pills. "Has resume" filters on a built resume; "to apply" is
 * the working queue (still open, not yet ticked). The Python web UI's
 * "Agent touched" and "Likely closed" have no data in the hosted app.
 */
export type StatusFilter =
  | "all"
  | "priority"
  | "todo"
  | "applied"
  | "saved"
  | "resumes"
  | "hidden";

/** The term bucket for a row with no term at all. Never a real term. */
export const UNKNOWN_TERM = "Unknown term";

/** The term-pill value meaning "no term filter". */
export const ALL_TERMS = "__all__";

export const STATUS_FILTERS: readonly { key: StatusFilter; label: string }[] = [
  { key: "all", label: "all" },
  { key: "priority", label: "priority" },
  { key: "todo", label: "to apply" },
  { key: "applied", label: "applied" },
  { key: "saved", label: "saved" },
  { key: "resumes", label: "resumes" },
  { key: "hidden", label: "hidden" },
];

export function isStatusFilter(v: string | null | undefined): v is StatusFilter {
  return STATUS_FILTERS.some((f) => f.key === v);
}

/* ------------------------------------------------------------------ terms */

/** The bucket a row's term falls in: its own string, or UNKNOWN_TERM. */
export const termOf = (row: Pick<TriageRow, "term">): string => row.term || UNKNOWN_TERM;

/** Display label for a term pill ("Unknown term" reads better as "Unknown"). */
export const termLabel = (term: string): string => (term === UNKNOWN_TERM ? "Unknown" : term);

const SEASON_CODE: Record<string, string> = {
  Spring: "SP",
  Summer: "SU",
  Fall: "FA",
  Winter: "WI",
};

/** "Summer 2027" -> "SU27". Anything that does not parse reads "—". */
export function termShort(term: string): string {
  const p = parseTerm(term);
  if (!p) return "—";
  return `${SEASON_CODE[p.season]}${String(p.year % 100).padStart(2, "0")}`;
}

/** The term is the one the preferences put first (the current target). */
export function isPrimaryTerm(term: string, wantedTerms: readonly string[] | null): boolean {
  return Boolean(term) && wantedTerms !== null && wantedTerms.length > 0 && wantedTerms[0] === term;
}

/**
 * The URL spelling of a term bucket: the lowercase short code for a real
 * term ("su27"), "unknown" for the no-term bucket, and the lowercased raw
 * string for anything else a source wrote ("summer/fall 2027").
 */
export function termSlug(term: string): string {
  if (term === UNKNOWN_TERM) return "unknown";
  return parseTerm(term) ? termShort(term).toLowerCase() : term.toLowerCase();
}

/** Resolves a URL term slug against the terms on offer; ALL_TERMS if none. */
export function termFromSlug(slug: string | null | undefined, terms: readonly string[]): string {
  if (!slug) return ALL_TERMS;
  const s = slug.toLowerCase();
  return terms.find((t) => termSlug(t) === s) ?? ALL_TERMS;
}

/** Terms in pill order: chronological, unparseable after, Unknown last. */
export function orderTerms(terms: Iterable<string>): string[] {
  const set = new Set(terms);
  const hasUnknown = set.delete(UNKNOWN_TERM);
  return [...sortTerms([...set]), ...(hasUnknown ? [UNKNOWN_TERM] : [])];
}

/* ---------------------------------------------------------------- filters */

export function passesStatus(row: TriageRow, filter: StatusFilter): boolean {
  if (filter === "hidden") return row.dismissed;
  if (row.dismissed) return false;
  switch (filter) {
    case "priority":
      return Boolean(row.priority);
    case "todo": // the working queue: still open, not yet ticked
      return !row.applied;
    case "applied":
      return row.applied;
    case "saved":
      return row.saved;
    case "resumes":
      return Boolean(row.resumeUrl);
    default:
      return true;
  }
}

export function passesQuery(row: TriageRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${row.company} ${row.title} ${row.location}`.toLowerCase().includes(q);
}

export function passesTerm(row: TriageRow, term: string): boolean {
  return term === ALL_TERMS || termOf(row) === term;
}

/** A row in a real term the preferences no longer want (null = all wanted). */
export function isUnwatched(row: Pick<TriageRow, "term">, wantedTerms: readonly string[] | null): boolean {
  return wantedTerms !== null && Boolean(row.term) && isKnownTerm(row.term) && !wantedTerms.includes(row.term);
}

/** Splits rows into watched and unwatched (see isUnwatched), keeping order. */
export function splitUnwatched(
  rows: readonly TriageRow[],
  wantedTerms: readonly string[] | null
): { watched: TriageRow[]; unwatched: TriageRow[] } {
  const watched: TriageRow[] = [];
  const unwatched: TriageRow[] = [];
  for (const r of rows) (isUnwatched(r, wantedTerms) ? unwatched : watched).push(r);
  return { watched, unwatched };
}

/**
 * The Matches count the header nav shows: live (not hidden) rows, in watched
 * terms unless the unwatched ones are being shown too. One definition for the
 * server seed (lib/app-data.ts) and the surface's live republish (triage.tsx).
 */
export function liveMatchCount(
  rows: readonly TriageRow[],
  wantedTerms: readonly string[] | null,
  showUnwatched: boolean
): number {
  const scoped = showUnwatched ? rows : splitUnwatched(rows, wantedTerms).watched;
  return scoped.reduce((n, r) => (r.dismissed ? n : n + 1), 0);
}

/** The open row, if it is still on screen; otherwise nothing is open. */
export function resolveOpen(open: string | null, visible: readonly Pick<TriageRow, "short">[]): string | null {
  return open !== null && visible.some((r) => r.short === open) ? open : null;
}

export type FilterState = { filter: StatusFilter; term: string; query: string };

export type FilterResult = {
  /** Rows passing all three axes, in input order. */
  rows: TriageRow[];
  /** Per status pill: rows passing that status, the active term and query. */
  statusCounts: Record<StatusFilter, number>;
  /** Term pills (ALL_TERMS first). Counted against the active status and
   *  query. Offered for every term with a live (not hidden) row - or any row
   *  while viewing hidden - so the row keeps its shape as the status changes
   *  and a zero count reads as "none here", while a term whose only rows are
   *  hidden does not linger as a dead pill. */
  termCounts: { key: string; count: number }[];
  /** The term actually applied: a stored pick no longer on offer falls back
   *  to ALL_TERMS instead of filtering everything away. */
  term: string;
};

/**
 * Status pills x term pills x search. Each pill's count is what the list
 * would show if that pill were picked with the other two axes unchanged.
 */
export function composeFilters(rows: readonly TriageRow[], state: FilterState): FilterResult {
  const offered = state.filter === "hidden" ? rows : rows.filter((r) => !r.dismissed);
  const terms = orderTerms(offered.map(termOf));
  const term = state.term === ALL_TERMS || terms.includes(state.term) ? state.term : ALL_TERMS;

  const statusCounts = Object.fromEntries(STATUS_FILTERS.map((f) => [f.key, 0])) as Record<
    StatusFilter,
    number
  >;
  const termTally = new Map<string, number>();
  let allTerms = 0;
  const out: TriageRow[] = [];

  for (const r of rows) {
    if (!passesQuery(r, state.query)) continue;
    const inTerm = passesTerm(r, term);
    const inStatus = passesStatus(r, state.filter);
    if (inTerm) {
      for (const f of STATUS_FILTERS) if (passesStatus(r, f.key)) statusCounts[f.key]++;
    }
    if (inStatus) {
      allTerms++;
      termTally.set(termOf(r), (termTally.get(termOf(r)) ?? 0) + 1);
    }
    if (inTerm && inStatus) out.push(r);
  }

  return {
    rows: out,
    statusCounts,
    termCounts: [
      { key: ALL_TERMS, count: allTerms },
      ...terms.map((t) => ({ key: t, count: termTally.get(t) ?? 0 })),
    ],
    term,
  };
}

/* ---------------------------------------------------------------- sorting */

export type SortKey = "company" | "term" | "found";
export type SortDir = "asc" | "desc";
export type Sort = { key: SortKey; dir: SortDir } | null;

const companyOrder = (a: TriageRow, b: TriageRow) =>
  a.company.localeCompare(b.company, undefined, { sensitivity: "base" });

/** The posting reads as closed: the liveness probe saw it gone twice, and
 *  the row is not applied (an application outlives its posting). */
export function isClosed(row: Pick<TriageRow, "closed" | "applied">): boolean {
  return Boolean(row.closed) && !row.applied;
}

/** Closed rows sort after every live one. */
export function closedLast(a: TriageRow, b: TriageRow): number {
  return Number(isClosed(a)) - Number(isClosed(b));
}

/** Live before closed, then priority rows, newest `added`, company name, key. */
export function defaultCompare(a: TriageRow, b: TriageRow): number {
  return (
    closedLast(a, b) ||
    Number(Boolean(b.priority)) - Number(Boolean(a.priority)) ||
    (b.added || "").localeCompare(a.added || "") ||
    companyOrder(a, b) ||
    a.short.localeCompare(b.short)
  );
}

/** Rows missing the sort field go last in either direction; null = both present. */
function missingLast(a: unknown, b: unknown): number | null {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return null;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;
const addedDay = (added: string): string | null => (ISO_DAY.test(added) ? added.slice(0, 10) : null);

/**
 * The comparator for a sort. Company is alphabetical; term is chronological
 * by season start; found is by age, so ascending reads newest first, the way
 * the column's "today / 1d / 3d" values grow. Ties fall back to the default
 * order, and rows with no term or no date sit at the end either way.
 */
export function comparatorFor(sort: Sort): (a: TriageRow, b: TriageRow) => number {
  if (!sort) return defaultCompare;
  const sign = sort.dir === "asc" ? 1 : -1;
  if (sort.key === "company") {
    return (a, b) => sign * companyOrder(a, b) || defaultCompare(a, b);
  }
  if (sort.key === "term") {
    return (a, b) => {
      const ta = termStart(a.term);
      const tb = termStart(b.term);
      if (ta === null || tb === null) return missingLast(ta, tb) || defaultCompare(a, b);
      return sign * compare(ta, tb) || defaultCompare(a, b);
    };
  }
  return (a, b) => {
    const da = addedDay(a.added);
    const db = addedDay(b.added);
    if (da === null || db === null) return missingLast(da, db) || defaultCompare(a, b);
    // A newer date is a smaller age, so age-ascending is date-descending.
    return sign * db.localeCompare(da) || defaultCompare(a, b);
  };
}

export function sortRows(rows: readonly TriageRow[], sort: Sort): TriageRow[] {
  return [...rows].sort(comparatorFor(sort));
}

/** Header click: ascending -> descending -> default; a new key starts ascending. */
export function cycleSort(current: Sort, key: SortKey): Sort {
  if (!current || current.key !== key) return { key, dir: "asc" };
  return current.dir === "asc" ? { key, dir: "desc" } : null;
}

export function ariaSortFor(
  sort: { key: string; dir: SortDir } | null,
  key: string
): "ascending" | "descending" | "none" {
  if (!sort || sort.key !== key) return "none";
  return sort.dir === "asc" ? "ascending" : "descending";
}

export function sortLabel(sort: Sort): string {
  if (!sort) return "priority first, then newest";
  return `sorted by ${sort.key} ${sort.dir === "asc" ? "ascending" : "descending"}`;
}

/* ------------------------------------------------------------------ dates */

/**
 * Relative age of an `added` day ("YYYY-MM-DD", the watcher's date-only
 * stamp): "today", "1d", "12d". A future date (clock skew) reads "today";
 * anything unparseable reads "—".
 */
export function foundAge(added: string, today: Day): string {
  const iso = addedDay(added);
  if (!iso) return "—";
  const days = Math.round(compare(today, dayFromIso(iso)) / 86_400_000);
  if (Number.isNaN(days)) return "—";
  return days <= 0 ? "today" : `${days}d`;
}

/** "Nov 8, 2026" for an `added` day; the raw string when it does not parse. */
export function absoluteDate(added: string): string {
  const iso = addedDay(added);
  if (!iso) return added;
  const d = dayFromIso(iso);
  const date = new Date(Date.UTC(d.y, d.m - 1, d.d));
  if (Number.isNaN(date.getTime())) return added;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/* ------------------------------------------------------------- row facts */

export type RowStatus = "applied" | "saved" | "new";

export function rowStatus(row: Pick<TriageRow, "applied" | "saved">): RowStatus {
  return row.applied ? "applied" : row.saved ? "saved" : "new";
}

/** The tag without brackets or the LLM star, case kept for display: "[TOP*]" -> "TOP". */
export function tagLabel(tag: string): string {
  return tag.replace(/[[\]*]/g, "").trim();
}

/** tagLabel lowercased, for comparing: "[TOP*]" -> "top". */
export function tagText(tag: string): string {
  return tagLabel(tag).toLowerCase();
}

/** The tag is worth a line of its own: not empty and not just "priority". */
export function tagIsInformative(tag: string): boolean {
  const t = tagText(tag);
  return t !== "" && t !== "priority";
}

/**
 * The "Worth knowing" lines: plain facts the row carries that its cells do
 * not already say. Only what the row (and, once built, its resume report)
 * states; no reasons are inferred and nothing is predicted.
 */
export function worthKnowing(
  row: TriageRow,
  report?: Pick<ResumeReport, "jdSource"> | null
): string[] {
  const out: string[] = [];
  if (isClosed(row)) out.push("The job board no longer lists this posting.");
  if (row.priority) out.push("Priority employer on your list.");
  if (!row.term) out.push("Term not stated in the posting.");
  if (tagText(row.tag) === "top") out.push("Tagged as a top company.");
  if (!row.hasJobDescription) out.push("No job description found.");
  if (report?.jdSource === "stub") {
    out.push("This resume was built from the title, company and location only.");
  }
  return out;
}

const JD_SOURCE: Record<ResumeReport["jdSource"], string> = {
  manual: "JD pasted",
  fetched: "JD fetched",
  stub: "no JD, title only",
};

/** One line about a build: "2 of 3 projects rewritten · 1 note · JD fetched". */
export function reportSummary(report: ResumeReport): string {
  const changed = report.projects.filter((p) => p.llmRewritten || p.overridden).length;
  const total = report.projects.length;
  const notes = report.notes.length;
  return [
    `${changed} of ${total} project${total === 1 ? "" : "s"} rewritten`,
    `${notes} note${notes === 1 ? "" : "s"}`,
    JD_SOURCE[report.jdSource] ?? report.jdSource,
  ].join(" · ");
}

/* --------------------------------------------------------------- URL state */

export const URL_PARAMS = {
  filter: "filter",
  term: "term",
  sort: "sort",
  open: "open",
} as const;

export type MatchesUrlState = {
  filter: StatusFilter;
  /** A term slug (termSlug); resolved against the data by termFromSlug. */
  term: string | null;
  sort: Sort;
  /** The open row's short key. */
  open: string | null;
};

export const DEFAULT_URL_STATE: MatchesUrlState = {
  filter: "all",
  term: null,
  sort: null,
  open: null,
};

const SLUG_RE = /^[\p{L}\p{N}][\p{L}\p{N} /&+._-]{0,40}$/u;
const SHORT_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function parseSort(v: string | null | undefined): Sort {
  const m = /^(company|term|found)\.(asc|desc)$/.exec(v ?? "");
  return m ? { key: m[1] as SortKey, dir: m[2] as SortDir } : null;
}

export const formatSort = (sort: Sort): string | null => (sort ? `${sort.key}.${sort.dir}` : null);

/** Reads the matches view from search params; bad values fall back silently. */
export function parseUrlState(params: { get(name: string): string | null }): MatchesUrlState {
  const filter = params.get(URL_PARAMS.filter);
  const term = params.get(URL_PARAMS.term);
  const open = params.get(URL_PARAMS.open);
  return {
    filter: isStatusFilter(filter) ? filter : "all",
    term: term && SLUG_RE.test(term) ? term.toLowerCase() : null,
    sort: parseSort(params.get(URL_PARAMS.sort)),
    open: open && SHORT_RE.test(open) ? open : null,
  };
}

/**
 * Writes the matches view into `search` (other params, such as `view` or
 * `job`, are kept). Defaults are omitted so the plain view stays `/`.
 * Returns the query string without the leading "?".
 */
export function formatUrlState(search: string, state: MatchesUrlState): string {
  const params = new URLSearchParams(search);
  const set = (name: string, value: string | null) => {
    if (value) params.set(name, value);
    else params.delete(name);
  };
  set(URL_PARAMS.filter, state.filter === "all" ? null : state.filter);
  set(URL_PARAMS.term, state.term);
  set(URL_PARAMS.sort, formatSort(state.sort));
  set(URL_PARAMS.open, state.open);
  return params.toString();
}
