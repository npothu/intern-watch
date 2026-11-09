import { describe, expect, it } from "vitest";
import { composeMatchesHeadline, isAddedOn, numberWord, utcDayIso } from "./headline";

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
  it("compares against the UTC day, which a local date can disagree with", () => {
    // 02:00 UTC on Nov 9 is still Nov 8 on the US west coast. The watcher
    // stamped the row with the UTC day, so it is new today in UTC terms.
    const now = new Date("2026-11-09T02:00:00Z");
    const added = "2026-11-09";
    expect(utcDayIso(now)).toBe("2026-11-09");
    expect(isAddedOn(added, utcDayIso(now))).toBe(true);
    const pacificLocal = now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    expect(pacificLocal).toBe("2026-11-08");
    expect(isAddedOn(added, pacificLocal)).toBe(false);
  });
});

const base = { shown: 0, priority: 0, newToday: 0, newTodayPriority: 0 };

describe("composeMatchesHeadline", () => {
  it("handles an empty table", () => {
    expect(composeMatchesHeadline(base)).toBe("No matches for these filters.");
  });

  it("leads with new-today rows and their priority share", () => {
    expect(
      composeMatchesHeadline({ shown: 20, priority: 5, newToday: 9, newTodayPriority: 3 })
    ).toBe("Nine new matches, three from priority companies.");
  });

  it("falls back to shown rows when nothing is new today", () => {
    expect(composeMatchesHeadline({ ...base, shown: 9, priority: 3 })).toBe(
      "Nine matches, three from priority companies."
    );
  });

  it("drops the priority clause when there are none", () => {
    expect(composeMatchesHeadline({ ...base, shown: 4, newToday: 2 })).toBe("Two new matches.");
    expect(composeMatchesHeadline({ ...base, shown: 1 })).toBe("One match.");
  });

  it("singular priority and all-priority phrasing", () => {
    expect(composeMatchesHeadline({ ...base, shown: 5, priority: 1 })).toBe(
      "Five matches, one from a priority company."
    );
    expect(composeMatchesHeadline({ ...base, shown: 3, priority: 3 })).toBe(
      "Three matches, all from priority companies."
    );
    expect(composeMatchesHeadline({ ...base, shown: 1, priority: 1 })).toBe(
      "One match, from a priority company."
    );
  });

  it("uses digits above twelve", () => {
    expect(composeMatchesHeadline({ ...base, shown: 48, priority: 13 })).toBe(
      "48 matches, 13 from priority companies."
    );
  });

  it("does not call hidden rows new", () => {
    expect(
      composeMatchesHeadline({ shown: 2, priority: 1, newToday: 2, newTodayPriority: 1, hidden: true })
    ).toBe("Two hidden matches.");
  });

  it("an empty hidden list is still the hidden list", () => {
    expect(composeMatchesHeadline({ ...base, hidden: true })).toBe("No hidden matches.");
  });
});
