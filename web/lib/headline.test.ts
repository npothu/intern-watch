import { describe, expect, it } from "vitest";
import { composeMatchesHeading, isAddedOn, numberWord } from "./headline";

describe("numberWord", () => {
  it("spells out zero through twelve", () => {
    expect(numberWord(0)).toBe("zero");
    expect(numberWord(1)).toBe("one");
    expect(numberWord(9)).toBe("nine");
    expect(numberWord(12)).toBe("twelve");
  });
  it("uses digits above twelve and for non-counts", () => {
    expect(numberWord(13)).toBe("13");
    expect(numberWord(140)).toBe("140");
    expect(numberWord(-1)).toBe("-1");
    expect(numberWord(2.5)).toBe("2.5");
  });
});

describe("isAddedOn", () => {
  it("matches the date part only", () => {
    expect(isAddedOn("2026-11-09", "2026-11-09")).toBe(true);
    expect(isAddedOn("2026-11-09T08:00:00Z", "2026-11-09")).toBe(true);
    expect(isAddedOn("2026-11-08", "2026-11-09")).toBe(false);
  });
  it("rejects unparseable values", () => {
    expect(isAddedOn("", "2026-11-09")).toBe(false);
    expect(isAddedOn("yesterday", "2026-11-09")).toBe(false);
  });
});

const base = { shown: 0, priority: 0, newToday: 0, newTodayPriority: 0 };

describe("composeMatchesHeading", () => {
  it("handles an empty table", () => {
    expect(composeMatchesHeading(base)).toEqual({
      label: "Matches · 0 shown",
      headline: "No matches for these filters.",
    });
  });

  it("leads with new-today rows and their priority share", () => {
    expect(
      composeMatchesHeading({ shown: 20, priority: 5, newToday: 9, newTodayPriority: 3 })
    ).toEqual({
      label: "Matches · 9 new today",
      headline: "Nine new matches, three from priority companies.",
    });
  });

  it("falls back to shown rows when nothing is new today", () => {
    expect(composeMatchesHeading({ ...base, shown: 9, priority: 3 })).toEqual({
      label: "Matches · 9 shown",
      headline: "Nine matches, three from priority companies.",
    });
  });

  it("drops the priority clause when there are none", () => {
    expect(composeMatchesHeading({ ...base, shown: 4, newToday: 2 }).headline).toBe(
      "Two new matches."
    );
    expect(composeMatchesHeading({ ...base, shown: 1 }).headline).toBe("One match.");
  });

  it("singular priority and all-priority phrasing", () => {
    expect(composeMatchesHeading({ ...base, shown: 5, priority: 1 }).headline).toBe(
      "Five matches, one from a priority company."
    );
    expect(composeMatchesHeading({ ...base, shown: 3, priority: 3 }).headline).toBe(
      "Three matches, all from priority companies."
    );
    expect(composeMatchesHeading({ ...base, shown: 1, priority: 1 }).headline).toBe(
      "One match, from a priority company."
    );
  });

  it("uses digits above twelve", () => {
    expect(composeMatchesHeading({ ...base, shown: 48, priority: 13 }).headline).toBe(
      "48 matches, 13 from priority companies."
    );
  });

  it("does not call hidden rows new", () => {
    expect(
      composeMatchesHeading({ shown: 2, priority: 1, newToday: 2, newTodayPriority: 1, hidden: true })
    ).toEqual({ label: "Matches · 2 hidden", headline: "Two hidden matches." });
  });
});
