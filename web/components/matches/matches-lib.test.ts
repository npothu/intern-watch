import { describe, expect, test } from "vitest";
import type { TriageRow } from "@/app/(app)/page";
import type { ResumeReport } from "@/lib/convex";
import { day } from "@/lib/terms";
import {
  ALL_TERMS,
  UNKNOWN_TERM,
  absoluteDate,
  ariaSortFor,
  composeFilters,
  cycleSort,
  defaultCompare,
  foundAge,
  formatUrlState,
  isPrimaryTerm,
  orderTerms,
  parseUrlState,
  reportSummary,
  resolveOpen,
  rowStatus,
  sortLabel,
  sortRows,
  splitUnwatched,
  tagIsInformative,
  tagLabel,
  tagText,
  termFromSlug,
  termShort,
  termSlug,
  worthKnowing,
  type MatchesUrlState,
} from "./matches-lib";

const row = (short: string, extra: Partial<TriageRow> = {}): TriageRow => ({
  key: `k:${short}`,
  short,
  company: short,
  title: "Software Engineer Intern",
  location: "Remote",
  term: "Summer 2027",
  added: "2026-11-01",
  tag: "",
  salary: "",
  url: "https://example.invalid/",
  resumeUrl: null,
  applied: false,
  saved: false,
  dismissed: false,
  hasJobDescription: true,
  ...extra,
});

const shorts = (rows: TriageRow[]) => rows.map((r) => r.short);

describe("termShort", () => {
  test("season initials and a two-digit year", () => {
    expect(termShort("Summer 2027")).toBe("SU27");
    expect(termShort("Fall 2027")).toBe("FA27");
    expect(termShort("Spring 2030")).toBe("SP30");
    expect(termShort("winter 2026")).toBe("WI26");
  });
  test("unknown or unparseable terms read as a dash", () => {
    expect(termShort("")).toBe("—");
    expect(termShort(UNKNOWN_TERM)).toBe("—");
    expect(termShort("Summer/Fall 2027")).toBe("—");
  });
  test("primary term is wantedTerms[0] only", () => {
    expect(isPrimaryTerm("Summer 2027", ["Summer 2027", "Fall 2027"])).toBe(true);
    expect(isPrimaryTerm("Fall 2027", ["Summer 2027", "Fall 2027"])).toBe(false);
    expect(isPrimaryTerm("Summer 2027", null)).toBe(false);
    expect(isPrimaryTerm("", [""])).toBe(false);
  });
});

describe("term slugs", () => {
  const terms = ["Summer 2027", "Fall 2027", "Summer/Fall 2027", UNKNOWN_TERM];
  test("round-trip through the URL spelling", () => {
    for (const t of terms) expect(termFromSlug(termSlug(t), terms)).toBe(t);
    expect(termSlug("Summer 2027")).toBe("su27");
    expect(termSlug(UNKNOWN_TERM)).toBe("unknown");
  });
  test("a slug for a term not on offer falls back to all", () => {
    expect(termFromSlug("sp31", terms)).toBe(ALL_TERMS);
    expect(termFromSlug(null, terms)).toBe(ALL_TERMS);
  });
  test("an unparseable term sorts after real terms and before Unknown", () => {
    expect(orderTerms([UNKNOWN_TERM, "Summer/Fall 2027", "Fall 2027"])).toEqual([
      "Fall 2027",
      "Summer/Fall 2027",
      UNKNOWN_TERM,
    ]);
  });
  test("pill order is chronological with Unknown last", () => {
    expect(orderTerms([UNKNOWN_TERM, "Fall 2027", "Spring 2027", "Fall 2027"])).toEqual([
      "Spring 2027",
      "Fall 2027",
      UNKNOWN_TERM,
    ]);
  });
});

describe("foundAge / absoluteDate", () => {
  const today = day(2026, 11, 8);
  test("relative days from a date-only stamp", () => {
    expect(foundAge("2026-11-08", today)).toBe("today");
    expect(foundAge("2026-11-07", today)).toBe("1d");
    expect(foundAge("2026-11-05", today)).toBe("3d");
    expect(foundAge("2026-10-08", today)).toBe("31d");
  });
  test("future dates read today, junk reads a dash", () => {
    expect(foundAge("2026-11-09", today)).toBe("today");
    expect(foundAge("", today)).toBe("—");
    expect(foundAge("yesterday", today)).toBe("—");
  });
  test("counts calendar days across month and year boundaries", () => {
    expect(foundAge("2026-10-31", day(2026, 11, 1))).toBe("1d");
    expect(foundAge("2026-02-28", day(2026, 3, 1))).toBe("1d");
    expect(foundAge("2028-02-28", day(2028, 3, 1))).toBe("2d"); // leap year
    expect(foundAge("2026-12-31", day(2027, 1, 1))).toBe("1d");
    expect(foundAge("2026-12-25", day(2027, 1, 3))).toBe("9d");
  });
  test("a timestamp after the date is ignored, only the day counts", () => {
    expect(foundAge("2026-11-07T23:59:00Z", day(2026, 11, 8))).toBe("1d");
  });
  test("absolute date", () => {
    expect(absoluteDate("2026-11-08")).toBe("Nov 8, 2026");
    expect(absoluteDate("")).toBe("");
    expect(absoluteDate("soon")).toBe("soon");
  });
});

describe("sorting", () => {
  const rows = [
    row("b", { company: "Beta", added: "2026-11-05", term: "Fall 2027" }),
    row("a", { company: "alpha", added: "2026-11-01", term: "Summer 2027" }),
    row("p", { company: "Zeta", added: "2026-10-01", term: "Spring 2027", priority: true }),
    row("u", { company: "Uno", added: "2026-11-05", term: "" }),
    row("n", { company: "Nodate", added: "", term: "Summer 2027" }),
  ];

  test("default: priority first, then newest, then company", () => {
    expect(shorts(sortRows(rows, null))).toEqual(["p", "b", "u", "a", "n"]);
  });
  test("company is case-insensitive and reverses", () => {
    expect(shorts(sortRows(rows, { key: "company", dir: "asc" }))).toEqual(["a", "b", "n", "u", "p"]);
    expect(shorts(sortRows(rows, { key: "company", dir: "desc" }))).toEqual(["p", "u", "n", "b", "a"]);
  });
  test("term is chronological; unknown terms stay last both ways; ties use default", () => {
    // a and n share Summer 2027: default order puts a (has a date) first.
    expect(shorts(sortRows(rows, { key: "term", dir: "asc" }))).toEqual(["p", "a", "n", "b", "u"]);
    expect(shorts(sortRows(rows, { key: "term", dir: "desc" }))).toEqual(["b", "a", "n", "p", "u"]);
  });
  test("found ascending is newest first; undated rows stay last; ties use default", () => {
    // b and u share a date: default order breaks the tie by company.
    expect(shorts(sortRows(rows, { key: "found", dir: "asc" }))).toEqual(["b", "u", "a", "p", "n"]);
    expect(shorts(sortRows(rows, { key: "found", dir: "desc" }))).toEqual(["p", "a", "b", "u", "n"]);
  });
  test("identical rows fall back to the short key so the order is stable", () => {
    expect(defaultCompare(row("x"), row("y"))).toBeLessThan(0);
  });
  test("header cycle: asc -> desc -> default, new key starts asc", () => {
    expect(cycleSort(null, "term")).toEqual({ key: "term", dir: "asc" });
    expect(cycleSort({ key: "term", dir: "asc" }, "term")).toEqual({ key: "term", dir: "desc" });
    expect(cycleSort({ key: "term", dir: "desc" }, "term")).toBeNull();
    expect(cycleSort({ key: "term", dir: "desc" }, "found")).toEqual({ key: "found", dir: "asc" });
  });
  test("aria-sort and the footer label", () => {
    expect(ariaSortFor({ key: "term", dir: "asc" }, "term")).toBe("ascending");
    expect(ariaSortFor({ key: "term", dir: "asc" }, "company")).toBe("none");
    expect(sortLabel(null)).toBe("priority first, then newest");
    expect(sortLabel({ key: "found", dir: "desc" })).toBe("sorted by found descending");
  });
});

describe("composeFilters", () => {
  const rows = [
    row("s1", { term: "Summer 2027", priority: true }),
    row("s2", { term: "Summer 2027", applied: true }),
    row("s3", { term: "Summer 2027", saved: true, resumeUrl: "https://r.invalid" }),
    row("f1", { term: "Fall 2027", company: "Figma" }),
    row("f2", { term: "Fall 2027", dismissed: true }),
    row("u1", { term: "" }),
  ];

  test("no filters: everything but the hidden row", () => {
    const r = composeFilters(rows, { filter: "all", term: ALL_TERMS, query: "" });
    expect(shorts(r.rows)).toEqual(["s1", "s2", "s3", "f1", "u1"]);
    expect(r.statusCounts).toEqual({
      all: 5,
      priority: 1,
      todo: 4,
      applied: 1,
      saved: 1,
      resumes: 1,
      hidden: 1,
    });
    expect(r.termCounts).toEqual([
      { key: ALL_TERMS, count: 5 },
      { key: "Summer 2027", count: 3 },
      { key: "Fall 2027", count: 1 },
      { key: UNKNOWN_TERM, count: 1 },
    ]);
  });

  test("status counts follow the term; term counts follow the status", () => {
    const r = composeFilters(rows, { filter: "hidden", term: "Fall 2027", query: "" });
    expect(shorts(r.rows)).toEqual(["f2"]);
    // status pills are counted inside Fall 2027
    expect(r.statusCounts.all).toBe(1);
    expect(r.statusCounts.hidden).toBe(1);
    expect(r.statusCounts.priority).toBe(0);
    // term pills are counted inside "hidden"; terms with none still appear
    expect(r.termCounts).toEqual([
      { key: ALL_TERMS, count: 1 },
      { key: "Summer 2027", count: 0 },
      { key: "Fall 2027", count: 1 },
      { key: UNKNOWN_TERM, count: 0 },
    ]);
  });

  test("the query narrows both axes", () => {
    const r = composeFilters(rows, { filter: "all", term: ALL_TERMS, query: "  figma " });
    expect(shorts(r.rows)).toEqual(["f1"]);
    expect(r.statusCounts.all).toBe(1);
    expect(r.termCounts.find((t) => t.key === "Summer 2027")?.count).toBe(0);
  });

  test("a term not on offer falls back to all terms", () => {
    const r = composeFilters(rows, { filter: "all", term: "Spring 2031", query: "" });
    expect(r.term).toBe(ALL_TERMS);
    expect(r.rows).toHaveLength(5);
  });

  test("unknown-term bucket filters rows with no term", () => {
    const r = composeFilters(rows, { filter: "all", term: UNKNOWN_TERM, query: "" });
    expect(shorts(r.rows)).toEqual(["u1"]);
  });
});

describe("row facts", () => {
  test("status vocabulary", () => {
    expect(rowStatus({ applied: true, saved: true })).toBe("applied");
    expect(rowStatus({ applied: false, saved: true })).toBe("saved");
    expect(rowStatus({ applied: false, saved: false })).toBe("new");
  });
  test("tags", () => {
    expect(tagText("[TOP*]")).toBe("top");
    expect(tagText(" [PRIORITY] ")).toBe("priority");
    expect(tagText("[atl]")).toBe("atl");
    expect(tagText("")).toBe("");
    expect(tagLabel("[ATL]")).toBe("ATL");
    expect(tagLabel("[TOP*]")).toBe("TOP");
    expect(tagIsInformative("[PRIORITY]")).toBe(false);
    expect(tagIsInformative("")).toBe(false);
    expect(tagIsInformative("[TOP*]")).toBe(true);
  });
  test("worth knowing states plain facts only", () => {
    expect(worthKnowing(row("a"))).toEqual([]);
    expect(
      worthKnowing(row("b", { priority: true, tag: "[TOP*]", term: "", hasJobDescription: false }))
    ).toEqual([
      "Priority employer on your list.",
      "Term not stated in the posting.",
      "Tagged as a top company.",
      "No job description found.",
    ]);
    expect(worthKnowing(row("c", { tag: "[atl]" }))).toEqual([]);
  });
  test("worth knowing: a stub-built resume is a separate fact", () => {
    expect(worthKnowing(row("d", { hasJobDescription: false }), { jdSource: "stub" })).toEqual([
      "No job description found.",
      "This resume was built from the title, company and location only.",
    ]);
    expect(worthKnowing(row("e"), { jdSource: "fetched" })).toEqual([]);
    expect(worthKnowing(row("f"), null)).toEqual([]);
  });
  test("report summary", () => {
    const report = {
      jdSource: "fetched",
      notes: ["one"],
      projects: [
        { name: "a", before: [], after: [], llmRewritten: true, overridden: false },
        { name: "b", before: [], after: [], llmRewritten: false, overridden: false },
      ],
    } as unknown as ResumeReport;
    expect(reportSummary(report)).toBe("1 of 2 projects rewritten · 1 note · JD fetched");
  });
  test("report summary: zero projects and zero notes", () => {
    const report = { jdSource: "stub", notes: [], projects: [] } as unknown as ResumeReport;
    expect(reportSummary(report)).toBe("0 of 0 projects rewritten · 0 notes · no JD, title only");
  });
  test("report summary: a pasted JD", () => {
    const report = {
      jdSource: "manual",
      notes: ["a", "b"],
      projects: [
        { name: "a", before: [], after: [], llmRewritten: true, overridden: false },
        { name: "b", before: [], after: [], llmRewritten: true, overridden: false },
      ],
    } as unknown as ResumeReport;
    expect(reportSummary(report)).toBe("2 of 2 projects rewritten · 2 notes · JD pasted");
  });
  test("report summary: singulars and an unknown JD source pass through", () => {
    const report = {
      jdSource: "scraped",
      notes: ["only"],
      projects: [{ name: "a", before: [], after: [], llmRewritten: false, overridden: true }],
    } as unknown as ResumeReport;
    expect(reportSummary(report)).toBe("1 of 1 project rewritten · 1 note · scraped");
  });
});

describe("URL state", () => {
  test("round-trips every field and keeps foreign params", () => {
    const state: MatchesUrlState = {
      filter: "priority",
      term: "su27",
      sort: { key: "found", dir: "desc" },
      open: "3f9a0b1c2d3e",
    };
    const qs = formatUrlState("view=matches&job=abc", state);
    const params = new URLSearchParams(qs);
    expect(params.get("job")).toBe("abc");
    expect(params.get("sort")).toBe("found.desc");
    expect(parseUrlState(params)).toEqual(state);
  });
  test("defaults are omitted", () => {
    expect(formatUrlState("filter=hidden&sort=term.asc", parseUrlState(new URLSearchParams("")))).toBe("");
  });
  test("invalid values fall back silently", () => {
    const parsed = parseUrlState(
      new URLSearchParams("filter=bogus&sort=title.up&open=<script>&term=%20%20")
    );
    expect(parsed).toEqual({ filter: "all", term: null, sort: null, open: null });
    expect(parseUrlState(new URLSearchParams("sort=company")).sort).toBeNull();
  });
  test("term slugs are lowercased", () => {
    expect(parseUrlState(new URLSearchParams("term=SU27")).term).toBe("su27");
  });
});

describe("sort tie-breaks", () => {
  test("an active sort's tie is broken by priority first", () => {
    const rows = [
      row("plain", { company: "Acme", term: "Fall 2027", added: "2026-11-05" }),
      row("prio", { company: "Acme", term: "Fall 2027", added: "2026-11-05", priority: true }),
    ];
    for (const key of ["company", "term", "found"] as const) {
      for (const dir of ["asc", "desc"] as const) {
        expect(shorts(sortRows(rows, { key, dir }))).toEqual(["prio", "plain"]);
      }
    }
  });
  test("two rows with no term keep the default order between them", () => {
    const rows = [
      row("old", { term: "", added: "2026-10-01" }),
      row("new", { term: "", added: "2026-11-01" }),
      row("dated", { term: "Fall 2027" }),
    ];
    expect(shorts(sortRows(rows, { key: "term", dir: "asc" }))).toEqual(["dated", "new", "old"]);
    expect(shorts(sortRows(rows, { key: "term", dir: "desc" }))).toEqual(["dated", "new", "old"]);
  });
  test("two rows with no date keep the default order between them", () => {
    const rows = [
      row("zed", { company: "Zed", added: "" }),
      row("abe", { company: "Abe", added: "unknown" }),
      row("dated", { added: "2026-11-01" }),
    ];
    expect(shorts(sortRows(rows, { key: "found", dir: "asc" }))).toEqual(["dated", "abe", "zed"]);
    expect(shorts(sortRows(rows, { key: "found", dir: "desc" }))).toEqual(["dated", "abe", "zed"]);
  });
});

describe("pill counts, more cases", () => {
  test("a row both saved and applied counts in both pills", () => {
    const r = composeFilters([row("both", { saved: true, applied: true })], {
      filter: "all",
      term: ALL_TERMS,
      query: "",
    });
    expect(r.statusCounts.saved).toBe(1);
    expect(r.statusCounts.applied).toBe(1);
    expect(r.statusCounts.todo).toBe(0);
  });
  test("a term whose only rows are hidden is not offered, except while viewing hidden", () => {
    const rows = [
      row("live", { term: "Summer 2027" }),
      row("gone", { term: "Fall 2026", dismissed: true }),
    ];
    const live = composeFilters(rows, { filter: "all", term: ALL_TERMS, query: "" });
    expect(live.termCounts.map((t) => t.key)).toEqual([ALL_TERMS, "Summer 2027"]);
    const hidden = composeFilters(rows, { filter: "hidden", term: ALL_TERMS, query: "" });
    expect(hidden.termCounts.map((t) => t.key)).toEqual([ALL_TERMS, "Fall 2026", "Summer 2027"]);
    // ...and a pick of that term stops applying outside the hidden view.
    expect(composeFilters(rows, { filter: "all", term: "Fall 2026", query: "" }).term).toBe(ALL_TERMS);
  });
  test("a live term with nothing under the active status still shows a zero", () => {
    const rows = [row("a", { term: "Summer 2027" }), row("b", { term: "Fall 2027", saved: true })];
    const r = composeFilters(rows, { filter: "saved", term: ALL_TERMS, query: "" });
    expect(r.termCounts).toEqual([
      { key: ALL_TERMS, count: 1 },
      { key: "Summer 2027", count: 0 },
      { key: "Fall 2027", count: 1 },
    ]);
  });
});

describe("open row and unwatched terms", () => {
  test("the open row closes when it is filtered out", () => {
    const visible = [row("a"), row("b")];
    expect(resolveOpen("a", visible)).toBe("a");
    expect(resolveOpen("zzz", visible)).toBeNull();
    expect(resolveOpen(null, visible)).toBeNull();
    expect(resolveOpen("a", [])).toBeNull();
  });
  test("only real terms outside the wanted set are unwatched", () => {
    const rows = [
      row("want", { term: "Summer 2027" }),
      row("past", { term: "Fall 2026" }),
      row("none", { term: "" }),
      row("odd", { term: "Summer/Fall 2027" }),
    ];
    const split = splitUnwatched(rows, ["Summer 2027"]);
    expect(shorts(split.watched)).toEqual(["want", "none", "odd"]);
    expect(shorts(split.unwatched)).toEqual(["past"]);
    expect(splitUnwatched(rows, null).unwatched).toEqual([]);
  });
});
