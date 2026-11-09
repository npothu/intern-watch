import { describe, expect, test } from "vitest";
import { pulseGeometry, pulseLabel, sinceLabel } from "./watcher-pulse";

const H = 3600e3;
const T = Date.UTC(2026, 10, 8, 12);

describe("pulseGeometry", () => {
  test("fewer than two runs draw nothing", () => {
    expect(pulseGeometry([])).toBeNull();
    expect(pulseGeometry([{ at: T, newMatches: 3 }])).toBeNull();
    // Two runs, but only one inside the 24h ending at the newest.
    expect(pulseGeometry([{ at: T - 30 * H, newMatches: 1 }, { at: T, newMatches: 3 }])).toBeNull();
  });

  test("x spans the day ending at the newest run; y scales to the peak", () => {
    const g = pulseGeometry([
      { at: T - 24 * H, newMatches: 0 },
      { at: T - 12 * H, newMatches: 4 },
      { at: T - 2 * H, newMatches: 2 },
      { at: T, newMatches: 1 },
    ])!;
    expect(g.all).toBe("0,16 48.8,4 89.4,10 97.5,13");
    // Last quarter = last 6h: starts at the point before the cutoff so it joins.
    expect(g.tail).toBe("48.8,4 89.4,10 97.5,13");
    expect(g.end).toEqual({ x: 97.5, y: 13 });
  });

  test("the tail is at least the final segment", () => {
    const g = pulseGeometry([
      { at: T - 20 * H, newMatches: 1 },
      { at: T - 10 * H, newMatches: 1 },
      { at: T, newMatches: 1 },
    ])!;
    expect(g.tail).toBe("56.9,4 97.5,4");
  });

  test("all-zero days sit on the baseline; negatives clamp; older runs are dropped", () => {
    const g = pulseGeometry([
      { at: T - 48 * H, newMatches: 9 },
      { at: T - 2 * H, newMatches: 0 },
      { at: T - H, newMatches: -3 },
      { at: T, newMatches: 0 },
    ])!;
    expect(g.all).toBe("89.4,16 93.4,16 97.5,16");
    expect(g.tail).toBe(g.all);
  });
});

describe("sinceLabel", () => {
  test("minutes, hours, days", () => {
    expect(sinceLabel(T, T)).toBe("0m");
    expect(sinceLabel(T, T + 47 * 60e3)).toBe("47m");
    expect(sinceLabel(T, T + 59 * 60e3 + 59e3)).toBe("59m");
    expect(sinceLabel(T, T + 60 * 60e3)).toBe("1h");
    expect(sinceLabel(T, T + 47 * H + 59 * 60e3)).toBe("47h");
    expect(sinceLabel(T, T + 48 * H)).toBe("2d");
    expect(sinceLabel(T, T - 5 * 60e3)).toBe("0m");
  });
});

describe("pulseLabel", () => {
  test("counts the day's runs and matches", () => {
    expect(
      pulseLabel([
        { at: T - 30 * H, newMatches: 5 },
        { at: T - H, newMatches: 2 },
        { at: T, newMatches: 1 },
      ])
    ).toBe("Watcher runs, last 24 hours: 2 runs, 3 new matches");
    expect(pulseLabel([{ at: T, newMatches: 1 }])).toBe("Watcher runs, last 24 hours: 1 run, 1 new match");
  });
});
