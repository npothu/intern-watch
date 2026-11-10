import { describe, expect, it } from "vitest";
import { composeNewToday, isAddedOn, utcDayIso } from "./headline";

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

describe("composeNewToday", () => {
  it("says so when nothing is new", () => {
    expect(composeNewToday({ newToday: 0, priority: 0 })).toBe("Nothing new today");
    // A priority count without new rows cannot happen; it must not print.
    expect(composeNewToday({ newToday: 0, priority: 3 })).toBe("Nothing new today");
  });

  it("gives the count and its priority share", () => {
    expect(composeNewToday({ newToday: 12, priority: 7 })).toBe(
      "12 new today, 7 from priority companies"
    );
    expect(composeNewToday({ newToday: 5, priority: 1 })).toBe(
      "5 new today, 1 from a priority company"
    );
  });

  it("drops the priority clause when there are none", () => {
    expect(composeNewToday({ newToday: 4, priority: 0 })).toBe("4 new today");
  });

  it("does not repeat the number when every new row is priority", () => {
    expect(composeNewToday({ newToday: 3, priority: 3 })).toBe(
      "3 new today, all from priority companies"
    );
    expect(composeNewToday({ newToday: 1, priority: 1 })).toBe(
      "1 new today, from a priority company"
    );
  });
});
