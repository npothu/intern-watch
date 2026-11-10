import { describe, expect, test } from "vitest";
import { lastRunAt, pulseGeometry, pulseLabel, sinceLabel } from "./watcher-pulse";

const H = 3600e3;
/** The server render time: the window is the 24h ending here. */
const NOW = Date.UTC(2026, 10, 8, 12);

describe("pulseGeometry", () => {
  test("fewer than two runs in the window draw nothing", () => {
    expect(pulseGeometry([], NOW)).toBeNull();
    expect(pulseGeometry([{ at: NOW, newMatches: 3 }], NOW)).toBeNull();
    // Two runs, but only one inside the 24h ending at now.
    expect(pulseGeometry([{ at: NOW - 30 * H, newMatches: 1 }, { at: NOW - H, newMatches: 3 }], NOW)).toBeNull();
    // A 33h-old run is outside the window even when it is the newest but one.
    expect(pulseGeometry([{ at: NOW - 33 * H, newMatches: 1 }, { at: NOW - 9 * H, newMatches: 1 }], NOW)).toBeNull();
  });

  test("x spans the 24h ending at now; y scales to the peak", () => {
    const g = pulseGeometry(
      [
        { at: NOW - 24 * H, newMatches: 0 },
        { at: NOW - 12 * H, newMatches: 4 },
        { at: NOW - 2 * H, newMatches: 2 },
        { at: NOW, newMatches: 1 },
      ],
      NOW
    )!;
    expect(g.all).toBe("0,16 48.8,4 89.4,10 97.5,13");
    // Last quarter = last 6h: starts at the point before the cutoff so it joins.
    expect(g.tail).toBe("48.8,4 89.4,10 97.5,13");
    expect(g.end).toEqual({ x: 97.5, y: 13 });
  });

  test("a quiet watcher leaves idle space on the right", () => {
    const g = pulseGeometry(
      [
        { at: NOW - 20 * H, newMatches: 1 },
        { at: NOW - 15 * H, newMatches: 2 },
        { at: NOW - 9 * H, newMatches: 1 },
      ],
      NOW
    )!;
    // The last run 9h ago sits at 15/24 of the width, not at the right edge.
    expect(g.end).toEqual({ x: 60.9, y: 10 });
    expect(g.all).toBe("16.3,10 36.6,4 60.9,10");
    // Nothing in the last 6h: the tail is still the final segment.
    expect(g.tail).toBe("36.6,4 60.9,10");
  });

  test("all points inside the tail window: the tail is the whole line", () => {
    const g = pulseGeometry(
      [
        { at: NOW - 5 * H, newMatches: 1 },
        { at: NOW - 3 * H, newMatches: 2 },
        { at: NOW - H, newMatches: 0 },
      ],
      NOW
    )!;
    expect(g.tail).toBe(g.all);
  });

  test("the tail is at least the final segment", () => {
    const g = pulseGeometry(
      [
        { at: NOW - 20 * H, newMatches: 1 },
        { at: NOW - 10 * H, newMatches: 1 },
        { at: NOW, newMatches: 1 },
      ],
      NOW
    )!;
    expect(g.tail).toBe("56.9,4 97.5,4");
  });

  test("unsorted input draws the same line as sorted", () => {
    const sorted = [
      { at: NOW - 12 * H, newMatches: 4 },
      { at: NOW - 2 * H, newMatches: 2 },
      { at: NOW - H, newMatches: 1 },
    ];
    const shuffled = [sorted[2], sorted[0], sorted[1]];
    expect(pulseGeometry(shuffled, NOW)).toEqual(pulseGeometry(sorted, NOW));
  });

  test("duplicate timestamps are both drawn, in a vertical step", () => {
    const g = pulseGeometry(
      [
        { at: NOW - 2 * H, newMatches: 0 },
        { at: NOW - 2 * H, newMatches: 2 },
      ],
      NOW
    )!;
    expect(g.all).toBe("89.4,16 89.4,4");
    expect(g.end).toEqual({ x: 89.4, y: 4 });
  });

  test("a future run is clamped to the window's end", () => {
    const g = pulseGeometry(
      [
        { at: NOW - 2 * H, newMatches: 1 },
        { at: NOW + 5 * H, newMatches: 1 },
      ],
      NOW
    )!;
    expect(g.end.x).toBe(97.5);
    expect(g.all).toBe("89.4,4 97.5,4");
  });

  test("all-zero days sit on the baseline; negatives clamp; older runs are dropped", () => {
    const g = pulseGeometry(
      [
        { at: NOW - 48 * H, newMatches: 9 },
        { at: NOW - 2 * H, newMatches: 0 },
        { at: NOW - H, newMatches: -3 },
        { at: NOW, newMatches: 0 },
      ],
      NOW
    )!;
    expect(g.all).toBe("89.4,16 93.4,16 97.5,16");
    expect(g.tail).toBe(g.all);
  });
});

describe("lastRunAt", () => {
  test("newest run, clamped to now; null without runs", () => {
    expect(lastRunAt([], NOW)).toBeNull();
    expect(lastRunAt([{ at: NOW - H, newMatches: 0 }, { at: NOW - 3 * H, newMatches: 0 }], NOW)).toBe(NOW - H);
    expect(lastRunAt([{ at: NOW + H, newMatches: 0 }], NOW)).toBe(NOW);
  });
});

describe("sinceLabel", () => {
  test("minutes, hours, days", () => {
    expect(sinceLabel(NOW, NOW)).toBe("0m");
    expect(sinceLabel(NOW, NOW + 47 * 60e3)).toBe("47m");
    expect(sinceLabel(NOW, NOW + 59 * 60e3 + 59e3)).toBe("59m");
    expect(sinceLabel(NOW, NOW + 60 * 60e3)).toBe("1h");
    expect(sinceLabel(NOW, NOW + 47 * H + 59 * 60e3)).toBe("47h");
    expect(sinceLabel(NOW, NOW + 48 * H)).toBe("2d");
    expect(sinceLabel(NOW, NOW - 5 * 60e3)).toBe("0m");
  });
});

describe("pulseLabel", () => {
  test("counts the window's runs and matches and says when the last run was", () => {
    expect(
      pulseLabel(
        [
          { at: NOW - 30 * H, newMatches: 5 },
          { at: NOW - 9 * H, newMatches: 2 },
          { at: NOW - 9 * H + 30 * 60e3, newMatches: 1 },
        ],
        NOW
      )
    ).toBe("Watcher runs, last 24 hours: 2 runs, 3 new matches, last run 8h ago");
    expect(pulseLabel([{ at: NOW - 5 * 60e3, newMatches: 1 }], NOW)).toBe(
      "Watcher runs, last 24 hours: 1 run, 1 new match, last run 5m ago"
    );
  });

  test("the minute tick moves the 'ago', not the window", () => {
    const runs = [
      { at: NOW - 23 * H, newMatches: 1 },
      { at: NOW - H, newMatches: 1 },
    ];
    expect(pulseLabel(runs, NOW, NOW + 2 * H)).toBe("Watcher runs, last 24 hours: 2 runs, 2 new matches, last run 3h ago");
  });

  test("zero and negative counts read as no new matches", () => {
    expect(pulseLabel([{ at: NOW - H, newMatches: 0 }, { at: NOW, newMatches: 0 }], NOW)).toBe(
      "Watcher runs, last 24 hours: 2 runs, 0 new matches, last run 0m ago"
    );
    expect(pulseLabel([{ at: NOW - H, newMatches: -4 }, { at: NOW, newMatches: 1 }], NOW)).toBe(
      "Watcher runs, last 24 hours: 2 runs, 1 new match, last run 0m ago"
    );
    expect(pulseLabel([], NOW)).toBe("Watcher runs, last 24 hours: 0 runs, 0 new matches");
  });
});
