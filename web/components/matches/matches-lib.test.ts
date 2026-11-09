import { describe, expect, test } from "vitest";
import type { TriageRow } from "@/app/(app)/page";
import type { ResumeReport } from "@/lib/convex";
import { day, dayFromIso } from "@/lib/terms";
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
  isClosed,
  isPrimaryTerm,
  liveMatchCount,
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
  clockTime,
  dateTime,
  isoDate,
  panelFacts,
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
const titles = (notes: { title: string }[]) => notes.map((n) => n.title);

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
  test("status: delivery facts say how an unmarked row was sent", () => {
    const immediate = { source: "s", delivery: { mode: "immediate" as const, at: "2026-11-08T06:14:00Z" } };
    const digest = { source: "s", delivery: { mode: "digest" as const, at: "2026-11-08T20:00:00Z" } };
    expect(rowStatus({ applied: false, saved: false, facts: immediate })).toBe("emailed");
    expect(rowStatus({ applied: false, saved: false, facts: digest })).toBe("digest");
    // The user's marks win over delivery.
    expect(rowStatus({ applied: true, saved: false, facts: immediate })).toBe("applied");
    expect(rowStatus({ applied: false, saved: true, facts: digest })).toBe("saved");
    // Facts without a delivery (or no facts at all) read "new".
    expect(rowStatus({ applied: false, saved: false, facts: { source: "s" } })).toBe("new");
    expect(rowStatus({ applied: false, saved: false, facts: undefined })).toBe("new");
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
  test("worth knowing without facts states plain facts only", () => {
    expect(worthKnowing(row("a"))).toEqual([]);
    expect(
      titles(worthKnowing(row("b", { priority: true, tag: "[TOP*]", term: "", hasJobDescription: false })))
    ).toEqual(["Priority employer", "No term stated", "Tagged as a top company", "No job description found"]);
    // Without the fact, nothing claims why a no-term row was shown.
    expect(worthKnowing(row("b2", { term: "" }))).toEqual([{ tag: "Term", title: "No term stated" }]);
    expect(worthKnowing(row("b3", { priority: true }))[0].sub).toBe("On your priority list.");
    expect(worthKnowing(row("c", { tag: "[atl]" }))).toEqual([]);
  });
  test("worth knowing: a stub-built resume is a separate fact", () => {
    expect(titles(worthKnowing(row("d", { hasJobDescription: false }), { jdSource: "stub" }))).toEqual([
      "No job description found",
      "Resume built without a job description",
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

describe("liveMatchCount", () => {
  const rows = [
    row("want", { term: "Summer 2027" }),
    row("want-hidden", { term: "Summer 2027", dismissed: true }),
    row("past", { term: "Fall 2026" }),
    row("past-hidden", { term: "Fall 2026", dismissed: true }),
    row("none", { term: "" }),
  ];
  test("counts live rows in watched terms only", () => {
    expect(liveMatchCount(rows, ["Summer 2027"], false)).toBe(2);
  });
  test("counts unwatched live rows too while they are shown", () => {
    expect(liveMatchCount(rows, ["Summer 2027"], true)).toBe(3);
  });
  test("no preferences known means every term is watched", () => {
    expect(liveMatchCount(rows, null, false)).toBe(3);
  });
});

describe("closed postings", () => {
  test("a closed row sorts after live priority and live plain rows", () => {
    const rows = [
      row("closed", { company: "Aaa", added: "2026-11-08", priority: true, closed: true }),
      row("live", { company: "Zzz", added: "2026-10-01" }),
      row("prio", { company: "Mmm", added: "2026-10-01", priority: true }),
    ];
    expect(shorts(sortRows(rows, null))).toEqual(["prio", "live", "closed"]);
  });
  test("explicit sorts keep their key and tie-break through closed-last", () => {
    const rows = [
      row("closed", { company: "Acme", closed: true }),
      row("live", { company: "Acme" }),
      row("b", { company: "Beta" }),
    ];
    expect(shorts(sortRows(rows, { key: "company", dir: "asc" }))).toEqual(["live", "closed", "b"]);
  });
  test("an applied row is never closed", () => {
    expect(isClosed({ closed: true, applied: false })).toBe(true);
    expect(isClosed({ closed: true, applied: true })).toBe(false);
    expect(isClosed({ closed: undefined, applied: false })).toBe(false);
    const applied = row("a", { closed: true, applied: true });
    expect(worthKnowing(applied)).toEqual([]);
    expect(shorts(sortRows([applied, row("b", { company: "b" })], null))).toEqual(["a", "b"]);
  });
  test("worth knowing states the closed fact", () => {
    expect(worthKnowing(row("c", { closed: true }))).toEqual([
      { tag: "Note", title: "Posting no longer listed", sub: "The job board no longer lists this posting." },
    ]);
  });
});

describe("match facts", () => {
  const today = dayFromIso("2026-11-08");
  const tz = "UTC";
  const labels = (r: TriageRow) => panelFacts(r, today, tz).map((f) => f.label);
  const value = (r: TriageRow, label: string) => panelFacts(r, today, tz).find((f) => f.label === label)?.value;
  const full: TriageRow["facts"] = {
    source: "jobright-data",
    sources: ["jobright-data", "simplify"],
    postedAt: "2026-11-08T04:30:00Z",
    delivery: { mode: "immediate", at: "2026-11-08T06:14:00Z" },
    termSource: "llm",
    metro: { name: "SF Bay Area", verdict: true, source: "llm" },
    topCompany: { verdict: true, judgedAt: "2026-09-21", source: "llm" },
    clearanceObtainable: true,
    acceptedBy: "priority",
  };

  test("formatters", () => {
    expect(clockTime("2026-11-08T06:14:00Z", tz)).toBe("06:14");
    expect(dateTime("2026-11-08T06:14:00Z", tz)).toBe("Nov 8, 06:14");
    expect(isoDate("2026-09-21")).toBe("Sep 21, 2026");
    expect(isoDate("2026-09-21T23:00:00Z")).toBe("Sep 21, 2026");
    for (const bad of [undefined, "", "nope"]) {
      expect(clockTime(bad, tz)).toBe("");
      expect(dateTime(bad, tz)).toBe("");
      expect(isoDate(bad)).toBe("");
    }
  });

  test("panel facts without facts: today's list", () => {
    expect(labels(row("a"))).toEqual(["Added", "Term", "Key"]);
    expect(labels(row("b", { salary: "$50/hr", tag: "[ATL]" }))).toEqual(["Added", "Term", "Salary", "Tag", "Key"]);
    expect(value(row("c", { term: "" }), "Term")).toBe("Unknown");
    expect(panelFacts(row("d"), today, tz).find((f) => f.label === "Key")).toEqual({ label: "Key", value: "d", mono: true });
  });

  test("panel facts with full facts", () => {
    const r = row("a", { added: "2026-11-05", facts: full });
    expect(labels(r)).toEqual(["Source", "Posted", "Metro", "Sent", "Added", "Term", "Key"]);
    expect(value(r, "Source")).toBe("jobright-data (also simplify) · found 3d ago");
    expect(value(r, "Posted")).toBe("Nov 8, 04:30");
    expect(value(r, "Metro")).toBe("SF Bay Area · in metro · by LLM");
    expect(value(r, "Sent")).toBe("Emailed 06:14, on the run that found it");
    expect(panelFacts(r, today, tz).filter((f) => f.local).map((f) => f.label)).toEqual(["Posted", "Sent"]);
  });

  test("panel facts with partial facts", () => {
    const only = row("b", { added: "2026-11-08", facts: { source: "simplify" } });
    expect(labels(only)).toEqual(["Source", "Added", "Term", "Key"]);
    expect(value(only, "Source")).toBe("simplify · found today");
    // An unparseable added date drops the age, not the source.
    expect(value(row("b2", { added: "", facts: { source: "simplify" } }), "Source")).toBe("simplify");
    const digest = row("c", {
      facts: {
        source: "s",
        sources: ["s"],
        metro: { name: "Atlanta", verdict: false, source: "rules" },
        delivery: { mode: "digest", at: "2026-11-07T20:05:00Z" },
        postedAt: "garbage",
      },
    });
    expect(labels(digest)).toEqual(["Source", "Metro", "Sent", "Added", "Term", "Key"]);
    expect(value(digest, "Source")).toBe("s · found 7d ago");
    expect(value(digest, "Metro")).toBe("Atlanta · outside metro");
    expect(value(digest, "Sent")).toBe("Digest, Nov 7, 20:05");
    // A bad delivery time keeps the mode.
    const badAt = (mode: "immediate" | "digest") =>
      value(row("d", { facts: { source: "s", delivery: { mode, at: "x" } } }), "Sent");
    expect(badAt("immediate")).toBe("Emailed on the run that found it");
    expect(badAt("digest")).toBe("Digest");
    // A metro with no name is not shown.
    expect(labels(row("e", { facts: { source: "s", metro: { name: "", verdict: true, source: "llm" } } }))).not.toContain("Metro");
  });

  test("worth knowing with full facts, in order", () => {
    expect(worthKnowing(row("a", { priority: true, tag: "[TOP*]", facts: full }))).toEqual([
      { tag: "Note", title: "Priority employer", sub: "Accepted for any wanted term before the rules ran." },
      { tag: "LLM", title: "Term inferred from the description", sub: "No term in the title." },
      {
        tag: "LLM",
        title: "Counted as a top company by verdict",
        sub: "Judged Sep 21, 2026; verdicts stick for about 120 days.",
      },
      { tag: "LLM", title: "Metro judged by the LLM", sub: "SF Bay Area: in." },
      {
        tag: "Note",
        title: "Needs a clearance you can obtain",
        sub: "Kept because the posting says it is obtainable, not required.",
      },
    ]);
  });

  test("worth knowing: each fact branch on its own", () => {
    const f = (facts: NonNullable<TriageRow["facts"]>, extra: Partial<TriageRow> = {}) =>
      worthKnowing(row("x", { ...extra, facts }));
    expect(f({ source: "s" })).toEqual([]);
    expect(f({ source: "s", termSource: "title" })).toEqual([]);
    expect(f({ source: "s", termSource: "unresolved" }, { term: "" })).toEqual([
      { tag: "Term", title: "No term stated", sub: "Shown because it passes under every wanted term." },
    ]);
    // A list-sourced or negative verdict is not news, and it replaces the tag fallback.
    expect(f({ source: "s", topCompany: { verdict: true, judgedAt: "2026-09-21", source: "list" } }, { tag: "[TOP]" })).toEqual([]);
    expect(f({ source: "s", topCompany: { verdict: false, judgedAt: "2026-09-21", source: "llm" } })).toEqual([]);
    expect(f({ source: "s", topCompany: { verdict: true, judgedAt: "bad", source: "llm" } })[0].sub).toBe(
      "Verdicts stick for about 120 days."
    );
    expect(f({ source: "s", metro: { name: "Austin", verdict: false, source: "llm" } })).toEqual([
      { tag: "LLM", title: "Metro judged by the LLM", sub: "Austin: outside." },
    ]);
    expect(f({ source: "s", metro: { name: "Austin", verdict: true, source: "rules" } })).toEqual([]);
    expect(f({ source: "s", clearanceObtainable: false })).toEqual([]);
    expect(titles(f({ source: "s", clearanceObtainable: true }))).toEqual(["Needs a clearance you can obtain"]);
    // Accepted by a rule but on the priority list now: the plain line, no claim about the rules.
    expect(titles(f({ source: "s", acceptedBy: "rule", acceptedRule: "metro" }, { priority: true }))).toEqual([
      "Priority employer",
    ]);
    expect(f({ source: "s", acceptedBy: "rule" })).toEqual([]);
    expect(f({ source: "s", acceptedBy: "priority" })[0].sub).toBe("Accepted for any wanted term before the rules ran.");
    // The closed and no-JD facts stay alongside the new ones.
    expect(titles(f({ source: "s", termSource: "llm" }, { closed: true, hasJobDescription: false }))).toEqual([
      "Posting no longer listed",
      "Term inferred from the description",
      "No job description found",
    ]);
  });
});
