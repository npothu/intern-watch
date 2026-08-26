import { describe, expect, it } from "vitest";
import {
  addMonths,
  day,
  parseTerm,
  rollingTerms,
  sortTerms,
  termRows,
  termStart,
  isoOf,
} from "./terms";

// The dates here are the same ones tests/test_terms.py pins on the Python
// side; the two implementations must agree on every row.

const AUG_26 = day(2026, 8, 26);

describe("terms: parsing", () => {
  it("parses season + year, case-insensitively", () => {
    expect(parseTerm("Fall 2026")).toEqual({ season: "Fall", year: 2026 });
    expect(parseTerm(" summer 2027 ")).toEqual({ season: "Summer", year: 2027 });
    expect(parseTerm("Fall")).toBeNull();
    expect(parseTerm("2027")).toBeNull();
    expect(isoOf(termStart("Spring 2027")!)).toBe("2027-01-10");
  });
});

describe("terms: arithmetic", () => {
  it("clamps the day when adding months", () => {
    expect(isoOf(addMonths(day(2026, 1, 31), 1))).toBe("2026-02-28");
    expect(isoOf(addMonths(day(2026, 8, 26), 14))).toBe("2027-10-26");
    expect(isoOf(addMonths(day(2026, 3, 15), -14))).toBe("2025-01-15");
  });
});

describe("terms: rolling window", () => {
  it("late August: Fall 2026 is gone, Fall 2027 is in, Summer 2028 is out", () => {
    expect(rollingTerms(AUG_26, 3, 14)).toEqual(["Spring 2027", "Summer 2027", "Fall 2027"]);
  });
  it("early June reproduces the old static list", () => {
    expect(rollingTerms(day(2026, 6, 11), 3, 14)).toEqual(["Fall 2026", "Spring 2027", "Summer 2027"]);
  });
  it("lead time drops a term before it starts", () => {
    expect(rollingTerms(day(2026, 12, 19), 3, 14)).toContain("Spring 2027");
    expect(rollingTerms(day(2026, 12, 21), 3, 14)).not.toContain("Spring 2027");
  });
  it("sorts chronologically", () => {
    expect(sortTerms(["Summer 2027", "Fall 2026", "Spring 2027"])).toEqual([
      "Fall 2026",
      "Spring 2027",
      "Summer 2027",
    ]);
  });
});

describe("terms: rows", () => {
  it("explains each term the way the Python side does", () => {
    const rows = Object.fromEntries(
      termRows(
        { leadWeeks: 3, horizonMonths: 14, include: ["Summer 2028"], exclude: ["Summer 2027"] },
        AUG_26,
      ).map((r) => [r.term, r]),
    );
    expect(Object.keys(rows)).toEqual(["Fall 2026", "Spring 2027", "Summer 2027", "Fall 2027", "Summer 2028"]);
    expect(rows["Fall 2026"]).toMatchObject({ status: "past", wanted: false, dropsOn: "2026-07-30" });
    expect(rows["Spring 2027"]).toMatchObject({ status: "auto", wanted: true, dropsOn: "2026-12-20" });
    expect(rows["Summer 2027"]).toMatchObject({ status: "excluded", wanted: false });
    expect(rows["Fall 2027"]).toMatchObject({ status: "auto", addedOn: "2026-06-20" });
    expect(rows["Summer 2028"]).toMatchObject({ status: "included", wanted: true });
  });
});
