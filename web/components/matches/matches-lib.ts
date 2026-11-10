// Pure logic behind the Matches table: filter composition with per-axis
// counts, sort comparators, the term short code, the "found" age, the
// report summary line and the URL view state. No React and no DOM here, so
// all of it is unit tested directly (matches-lib.test.ts).

import type { TriageRow } from "@/app/(app)/page";
import type { MatchFacts, ResumeReport } from "@/lib/convex";
import { compare, dayFromIso, parseTerm, sortTerms, termStart, type Day } from "@/lib/terms";
import { isKnownTerm } from "@/lib/preferences";
import { isAddedOn, type NewTodayCounts } from "@/lib/headline";

/**
 * The stage tabs: which pile is on screen. Exactly one is always on. "To
 * apply" is the working queue (live, not yet ticked) and the default; "All"
 * is to apply plus applied; "Hidden" is the dismissed list, which is not part
 * of All.
 */
export type Stage = "todo" | "applied" | "all" | "hidden";

export const STAGES: readonly { key: Stage; label: string }[] = [
  { key: "todo", label: "To apply" },
  { key: "applied", label: "Applied" },
  { key: "all", label: "All" },
  { key: "hidden", label: "Hidden" },
];

export const DEFAULT_STAGE: Stage = "todo";

export function isStage(v: string | null | undefined): v is Stage {
  return STAGES.some((s) => s.key === v);
}

/**
 * The narrowing chips. Unlike the stage they are checkboxes: any number can
 * be on, and a row has to pass all of them. "Has resume" is a built resume;
 * "New today" is a row the watcher added on the server's UTC day.
 */
export type Flag = "new" | "priority" | "saved" | "resumes";

export const FLAGS: readonly { key: Flag; label: string }[] = [
  { key: "new", label: "New today" },
  { key: "priority", label: "Priority" },
  { key: "saved", label: "Saved" },
  { key: "resumes", label: "Has resume" },
];

export function isFlag(v: string | null | undefined): v is Flag {
  return FLAGS.some((f) => f.key === v);
}

/** `flags` deduplicated and in chip order, so two spellings compare equal. */
export function normalizeFlags(flags: Iterable<string>): Flag[] {
  const set = new Set(flags);
  return FLAGS.filter((f) => set.has(f.key)).map((f) => f.key);
}

/** The term bucket for a row with no term at all. Never a real term. */
export const UNKNOWN_TERM = "Unknown term";

/** The term-menu value meaning "no term filter". */
export const ALL_TERMS = "__all__";

/* ------------------------------------------------------------------ terms */

/** The bucket a row's term falls in: its own string, or UNKNOWN_TERM. */
export const termOf = (row: Pick<TriageRow, "term">): string => row.term || UNKNOWN_TERM;

/** Display label for a term ("Unknown term" reads better as "Unknown"). */
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

export function passesStage(row: Pick<TriageRow, "dismissed" | "applied">, stage: Stage): boolean {
  if (stage === "hidden") return row.dismissed;
  if (row.dismissed) return false;
  if (stage === "todo") return !row.applied;
  if (stage === "applied") return row.applied;
  return true;
}

export function passesFlag(row: TriageRow, flag: Flag, todayIso: string): boolean {
  switch (flag) {
    case "new":
      return isAddedOn(row.added, todayIso);
    case "priority":
      return Boolean(row.priority);
    case "saved":
      return row.saved;
    case "resumes":
      return Boolean(row.resumeUrl);
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

/** A row that is new today and still waiting on you: live, not applied. */
export function isNewToday(row: TriageRow, todayIso: string): boolean {
  return !row.dismissed && !row.applied && isAddedOn(row.added, todayIso);
}

/**
 * The numbers behind the header nav's Matches badge and the page's "N new
 * today" line: rows added today that are still to apply, and how many of
 * them are from priority employers, in watched terms unless the unwatched
 * ones are being shown too. One definition for the server seed
 * (lib/app-data.ts) and the surface's live republish (triage.tsx).
 */
export function newTodayCounts(
  rows: readonly TriageRow[],
  wantedTerms: readonly string[] | null,
  showUnwatched: boolean,
  todayIso: string
): NewTodayCounts {
  const scoped = showUnwatched ? rows : splitUnwatched(rows, wantedTerms).watched;
  const counts = { newToday: 0, priority: 0 };
  for (const r of scoped) {
    if (!isNewToday(r, todayIso)) continue;
    counts.newToday++;
    if (r.priority) counts.priority++;
  }
  return counts;
}

/** The open row, if it is still on screen; otherwise nothing is open. */
export function resolveOpen(open: string | null, visible: readonly Pick<TriageRow, "short">[]): string | null {
  return open !== null && visible.some((r) => r.short === open) ? open : null;
}

export type FilterState = {
  stage: Stage;
  flags: readonly Flag[];
  term: string;
  query: string;
  /** The server's UTC day; what "New today" compares `added` against. */
  todayIso: string;
  /**
   * Rows that stay in the list although a tick just moved them out of the
   * stage (an applied tick in To apply, an undone one in Applied), so a
   * misclick can be undone in place. They are listed and nothing more: every
   * count (stage, chip, term) treats them as being in their real stage.
   * Never keeps a row in or out of Hidden.
   */
  keep?: ReadonlySet<string>;
};

export type FilterResult = {
  /** Rows passing every axis, in input order. */
  rows: TriageRow[];
  /** Per stage tab: rows in that stage passing the flags, term and query. */
  stageCounts: Record<Stage, number>;
  /** Per chip: rows the list would show with that chip on and everything
   *  else unchanged. For a chip that is on, that is the list as it stands. */
  flagCounts: Record<Flag, number>;
  /** Term options (ALL_TERMS first). Counted against the stage, the flags
   *  and the query. Offered for every term with a live (not hidden) row - or
   *  any row while viewing hidden - so the menu keeps its shape as the stage
   *  changes and a zero count reads as "none here", while a term whose only
   *  rows are hidden does not linger as a dead option. */
  termCounts: { key: string; count: number }[];
  /** The term actually applied: a stored pick no longer on offer falls back
   *  to ALL_TERMS instead of filtering everything away. */
  term: string;
};

/**
 * Stage x chips x term x search. Every count is what the list would show if
 * that control were picked with the other axes unchanged.
 */
export function composeFilters(rows: readonly TriageRow[], state: FilterState): FilterResult {
  const { stage, todayIso, keep } = state;
  const flags = normalizeFlags(state.flags);
  const offered = stage === "hidden" ? rows : rows.filter((r) => !r.dismissed);
  const terms = orderTerms(offered.map(termOf));
  const term = state.term === ALL_TERMS || terms.includes(state.term) ? state.term : ALL_TERMS;

  const stageCounts = Object.fromEntries(STAGES.map((s) => [s.key, 0])) as Record<Stage, number>;
  const flagCounts = Object.fromEntries(FLAGS.map((f) => [f.key, 0])) as Record<Flag, number>;
  const termTally = new Map<string, number>();
  let allTerms = 0;
  const out: TriageRow[] = [];

  for (const r of rows) {
    if (!passesQuery(r, state.query)) continue;
    const inTerm = passesTerm(r, term);
    // Which chips the row fails. A chip's own count ignores that chip, so a
    // row counts toward it when it fails nothing else.
    const failed = flags.filter((f) => !passesFlag(r, f, todayIso));
    const inFlags = failed.length === 0;
    if (inTerm && inFlags) {
      for (const s of STAGES) if (passesStage(r, s.key)) stageCounts[s.key]++;
    }
    if (passesStage(r, stage)) {
      if (inFlags) {
        allTerms++;
        termTally.set(termOf(r), (termTally.get(termOf(r)) ?? 0) + 1);
      }
      if (inTerm) {
        for (const f of FLAGS) {
          const others = failed.length === 0 || (failed.length === 1 && failed[0] === f.key);
          if (others && passesFlag(r, f.key, todayIso)) flagCounts[f.key]++;
        }
      }
    } else if (stage === "hidden" || r.dismissed || !keep?.has(r.short)) {
      continue;
    }
    if (inTerm && inFlags) out.push(r);
  }

  return {
    rows: out,
    stageCounts,
    flagCounts,
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

/**
 * The Status column. Applied and saved are the user's own marks and win;
 * otherwise a row the watcher has delivered says how ("emailed" on the run
 * that found it, or "digest"), and a row without delivery facts reads "new".
 */
export type RowStatus = "applied" | "saved" | "emailed" | "digest" | "new";

export function rowStatus(row: Pick<TriageRow, "applied" | "saved" | "facts">): RowStatus {
  if (row.applied) return "applied";
  if (row.saved) return "saved";
  const mode = row.facts?.delivery?.mode;
  if (mode === "immediate") return "emailed";
  if (mode === "digest") return "digest";
  return "new";
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

/* ------------------------------------------------------- date formatting */

const parseIso = (iso: string | undefined): Date | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** "06:14" in the viewer's zone (or `timeZone`); "" when it does not parse. */
export function clockTime(iso: string | undefined, timeZone?: string): string {
  const d = parseIso(iso);
  if (!d) return "";
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone });
}

/** "Nov 8" in the viewer's zone (or `timeZone`); "" when it does not parse. */
export function dayPart(iso: string | undefined, timeZone?: string): string {
  const d = parseIso(iso);
  if (!d) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone });
}

/** "Nov 8, 06:12" in the viewer's zone (or `timeZone`); "" when it does not parse. */
export function dateTime(iso: string | undefined, timeZone?: string): string {
  const d = parseIso(iso);
  if (!d) return "";
  return `${dayPart(iso, timeZone)}, ${clockTime(iso, timeZone)}`;
}

/** "Sep 21, 2026" for an ISO date or timestamp, read as UTC; "" when it does not parse. */
export function isoDate(iso: string | undefined): string {
  const d = parseIso(iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso);
  if (!d) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/* ---------------------------------------------------------- facts shape */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): v is T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v);

/**
 * The watcher's facts as the web can trust them: only well-typed members
 * survive (strings, string arrays, enum members, booleans; metro needs a
 * name and a boolean verdict, topCompany a verdict, judgedAt and source,
 * delivery a known mode), everything else is dropped. Undefined when
 * nothing survives, so a malformed object reads as an older row.
 */
export function sanitizeFacts(raw: unknown): MatchFacts | undefined {
  if (!isObj(raw)) return undefined;
  const out: MatchFacts = {};
  if (isStr(raw.source) && raw.source) out.source = raw.source;
  if (Array.isArray(raw.sources)) {
    const sources = raw.sources.filter((s): s is string => isStr(s) && s !== "");
    if (sources.length) out.sources = sources;
  }
  if (isStr(raw.postedAt) && raw.postedAt) out.postedAt = raw.postedAt;
  const del = raw.delivery;
  if (isObj(del) && oneOf(del.mode, ["immediate", "digest"] as const)) {
    out.delivery = isStr(del.at) && del.at ? { mode: del.mode, at: del.at } : { mode: del.mode };
  }
  if (oneOf(raw.termSource, ["title", "llm", "unresolved"] as const)) out.termSource = raw.termSource;
  const metro = raw.metro;
  if (isObj(metro) && isStr(metro.name) && metro.name && typeof metro.verdict === "boolean") {
    out.metro = oneOf(metro.source, ["rules", "llm"] as const)
      ? { name: metro.name, verdict: metro.verdict, source: metro.source }
      : { name: metro.name, verdict: metro.verdict };
  }
  const top = raw.topCompany;
  if (
    isObj(top) &&
    typeof top.verdict === "boolean" &&
    isStr(top.judgedAt) &&
    oneOf(top.source, ["list", "llm"] as const)
  ) {
    out.topCompany = { verdict: top.verdict, judgedAt: top.judgedAt, source: top.source };
  }
  if (typeof raw.clearanceObtainable === "boolean") out.clearanceObtainable = raw.clearanceObtainable;
  if (oneOf(raw.acceptedBy, ["priority", "rule", "unresolved-all-terms"] as const)) out.acceptedBy = raw.acceptedBy;
  if (isStr(raw.acceptedRule) && raw.acceptedRule) out.acceptedRule = raw.acceptedRule;
  return Object.keys(out).length ? out : undefined;
}

/* ------------------------------------------------------------ panel facts */

/** The token in a PanelFact value where its client-only time goes. */
export const TIME_SLOT = "{time}";

export type PanelFact = {
  label: string;
  /** The text; when `time` is set it holds TIME_SLOT where the time goes. */
  value: string;
  /** Mono, smaller: the short key. */
  mono?: boolean;
  /**
   * A time to render in the viewer's zone, on the client only (the server
   * has no idea of the viewer's zone). `iso` is normalized UTC, for the
   * title; `withDate` adds the day ("Nov 8, 06:14") rather than the clock
   * alone.
   */
  time?: { iso: string; withDate: boolean };
};

const timeOf = (iso: string | undefined, withDate: boolean): PanelFact["time"] => {
  const d = parseIso(iso);
  return d ? { iso: d.toISOString(), withDate } : undefined;
};

/**
 * The details panel's facts list, in display order, with only the rows that
 * have data: Source, Posted, Metro and Sent come from the watcher's facts
 * (absent on older rows), then Added, Term, Salary, Tag and Key as before.
 * `todayIso` is the server's UTC day, the same one "new today" is counted
 * against, so "found Nd ago" agrees with it.
 */
export function panelFacts(row: TriageRow, todayIso: string): PanelFact[] {
  const out: PanelFact[] = [];
  const f = row.facts;
  if (f?.source) {
    const others = (Array.isArray(f.sources) ? f.sources : []).filter((s) => isStr(s) && s && s !== f.source);
    const age = foundAge(row.added, dayFromIso(todayIso));
    const found = age === "—" ? "" : age === "today" ? " · found today" : ` · found ${age} ago`;
    const also = others.length ? ` (also ${others.join(", ")})` : "";
    out.push({ label: "Source", value: `${f.source}${also}${found}` });
  }
  const posted = timeOf(f?.postedAt, true);
  if (posted) out.push({ label: "Posted", value: TIME_SLOT, time: posted });
  if (f?.metro?.name) {
    const m = f.metro;
    const verdict = typeof m.verdict === "boolean" ? ` · ${m.verdict ? "in metro" : "outside metro"}` : "";
    out.push({ label: "Metro", value: `${m.name}${verdict}${m.source === "llm" ? " · by LLM" : ""}` });
  }
  const sent = f?.delivery;
  if (sent?.mode === "immediate") {
    const time = timeOf(sent.at, false);
    out.push(
      time
        ? { label: "Sent", value: `Emailed ${TIME_SLOT}, on the run that found it`, time }
        : { label: "Sent", value: "Emailed on the run that found it" }
    );
  } else if (sent?.mode === "digest") {
    const time = timeOf(sent.at, true);
    out.push(time ? { label: "Sent", value: `Digest, ${TIME_SLOT}`, time } : { label: "Sent", value: "Digest" });
  }
  out.push({ label: "Added", value: absoluteDate(row.added) || "—" });
  out.push({ label: "Term", value: row.term || termLabel(UNKNOWN_TERM) });
  if (row.salary) out.push({ label: "Salary", value: row.salary });
  if (tagIsInformative(row.tag)) out.push({ label: "Tag", value: tagLabel(row.tag) });
  out.push({ label: "Key", value: row.short, mono: true });
  return out;
}

/** One "Worth knowing" entry: a mono caps tag, a title and a muted sub-line. */
export type WorthNote = { tag: "LLM" | "Term" | "Note"; title: string; sub?: string };

/**
 * The "Worth knowing" entries: the non-obvious things about a row that its
 * cells do not already say. Only what the row (its watcher facts and, once
 * built, its resume report) states; nothing is inferred or predicted. Rows
 * from before the watcher recorded facts fall back to the plainer lines the
 * row alone supports.
 */
export function worthKnowing(
  row: TriageRow,
  report?: Pick<ResumeReport, "jdSource"> | null
): WorthNote[] {
  const out: WorthNote[] = [];
  const f = row.facts;
  if (isClosed(row)) {
    out.push({ tag: "Note", title: "Posting no longer listed", sub: "The job board no longer lists this posting." });
  }
  if (f?.acceptedBy === "priority") {
    out.push({ tag: "Note", title: "Priority employer", sub: "Accepted for any wanted term before the rules ran." });
  } else if (row.priority) {
    out.push({ tag: "Note", title: "Priority employer", sub: "On your priority list." });
  }
  if (f?.acceptedBy === "rule" && f.acceptedRule) {
    out.push({ tag: "Note", title: "Accepted by rule", sub: f.acceptedRule });
  }
  if (f?.termSource === "llm") {
    out.push({ tag: "LLM", title: "Term inferred from the description", sub: "No term in the title." });
  } else if (f?.termSource === "unresolved" || f?.acceptedBy === "unresolved-all-terms") {
    out.push({
      tag: "Term",
      title: row.term ? "Term not resolved" : "No term stated",
      sub: "Shown because it passes under every wanted term.",
    });
  } else if (!row.term) {
    out.push({ tag: "Term", title: "No term stated" });
  }
  if (f?.topCompany) {
    if (f.topCompany.source === "llm" && f.topCompany.verdict) {
      const judged = isoDate(f.topCompany.judgedAt);
      out.push({
        tag: "LLM",
        title: "Counted as a top company by verdict",
        sub: judged
          ? `Judged ${judged}; verdicts stick for about 120 days.`
          : "Verdicts stick for about 120 days.",
      });
    }
  } else if (tagText(row.tag) === "top") {
    out.push({ tag: "Note", title: "Tagged as a top company" });
  }
  if (f?.metro?.name && f.metro.source === "llm" && typeof f.metro.verdict === "boolean") {
    out.push({
      tag: "LLM",
      title: "Metro judged by the LLM",
      sub: `${f.metro.name}: ${f.metro.verdict ? "in" : "outside"}.`,
    });
  }
  if (f?.clearanceObtainable) {
    out.push({
      tag: "Note",
      title: "Needs a clearance you can obtain",
      sub: "Kept because the posting says it is obtainable, not required.",
    });
  }
  if (!row.hasJobDescription) out.push({ tag: "Note", title: "No job description found" });
  if (report?.jdSource === "stub") {
    out.push({
      tag: "Note",
      title: "Resume built without a job description",
      sub: "It used the title, company and location only.",
    });
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
  /** The stage tab. The name predates the tabs; old links keep working. */
  filter: "filter",
  /** The chips that are on, comma separated. */
  show: "show",
  term: "term",
  sort: "sort",
  open: "open",
} as const;

export type MatchesUrlState = {
  stage: Stage;
  /** In chip order (normalizeFlags). */
  flags: Flag[];
  /** A term slug (termSlug); resolved against the data by termFromSlug. */
  term: string | null;
  sort: Sort;
  /** The open row's short key. */
  open: string | null;
};

export const DEFAULT_URL_STATE: MatchesUrlState = {
  stage: DEFAULT_STAGE,
  flags: [],
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

/** The old `?filter=` pills that became chips. */
const LEGACY_FILTER_FLAGS: readonly Flag[] = ["priority", "saved", "resumes"];

/**
 * Reads the matches view from search params; bad values fall back silently.
 * `?filter=` used to hold one of seven pills. Three of them are chips now, so
 * an old `?filter=priority` (or saved, resumes) reads as that chip on All,
 * which is the list the old link showed.
 */
export function parseUrlState(params: { get(name: string): string | null }): MatchesUrlState {
  const filter = params.get(URL_PARAMS.filter);
  const term = params.get(URL_PARAMS.term);
  const open = params.get(URL_PARAMS.open);
  const legacy = LEGACY_FILTER_FLAGS.find((f) => f === filter) ?? null;
  const shown = (params.get(URL_PARAMS.show) ?? "").split(",");
  return {
    stage: isStage(filter) ? filter : legacy ? "all" : DEFAULT_STAGE,
    flags: normalizeFlags(legacy ? [...shown, legacy] : shown),
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
  set(URL_PARAMS.filter, state.stage === DEFAULT_STAGE ? null : state.stage);
  set(URL_PARAMS.show, normalizeFlags(state.flags).join(",") || null);
  set(URL_PARAMS.term, state.term);
  set(URL_PARAMS.sort, formatSort(state.sort));
  set(URL_PARAMS.open, state.open);
  return params.toString();
}
