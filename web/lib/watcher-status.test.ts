import { describe, expect, test } from "vitest";
import { stalledNotice, watcherStatus, type StatusHealth } from "./watcher-status";

const M = 60e3;
const H = 60 * M;
const NOW = Date.UTC(2026, 10, 10, 12);

const health = (extra: Partial<StatusHealth> = {}): StatusHealth => ({
  watcherPushedAt: NOW - 38 * M,
  mail: null,
  stuckBuilds: 0,
  ...extra,
});

describe("watcherStatus", () => {
  test("a recent run is healthy and says when", () => {
    expect(watcherStatus(health(), NOW)).toEqual({
      level: "ok",
      label: "Checked 38m ago",
      short: "38m ago",
      word: "Healthy",
    });
  });

  test("no payload is unknown, not healthy", () => {
    expect(watcherStatus(null, NOW)).toMatchObject({ level: "warn", label: "No watcher data" });
  });

  test("a watcher that never pushed needs attention", () => {
    expect(watcherStatus(health({ watcherPushedAt: null }), NOW)).toMatchObject({
      level: "bad",
      label: "Watcher has not run",
    });
  });

  test("six hours is the line between fine and late", () => {
    expect(watcherStatus(health({ watcherPushedAt: NOW - 6 * H }), NOW).level).toBe("ok");
    expect(watcherStatus(health({ watcherPushedAt: NOW - 7 * H }), NOW)).toMatchObject({
      level: "warn",
      label: "Last check 7h ago",
      short: "7h ago",
      word: "Running late",
    });
  });

  test("two days is the line between late and stalled", () => {
    expect(watcherStatus(health({ watcherPushedAt: NOW - 48 * H }), NOW).level).toBe("warn");
    expect(watcherStatus(health({ watcherPushedAt: NOW - 49 * H }), NOW)).toMatchObject({
      level: "bad",
      label: "Watcher stalled, 2d",
      short: "Stalled",
    });
  });

  test("mail and build problems outrank a late watcher but not a stalled one", () => {
    const mail = { lastError: "token expired", watchExpiration: null };
    expect(watcherStatus(health({ mail, watcherPushedAt: NOW - 7 * H }), NOW).label).toBe(
      "Mail sync failing"
    );
    expect(watcherStatus(health({ mail, watcherPushedAt: NOW - 72 * H }), NOW).label).toBe(
      "Watcher stalled, 3d"
    );
    expect(
      watcherStatus(health({ mail: { lastError: null, watchExpiration: NOW - M } }), NOW).label
    ).toBe("Mail watch expired");
    expect(
      watcherStatus(health({ mail: { lastError: null, watchExpiration: NOW + M } }), NOW).level
    ).toBe("ok");
    expect(watcherStatus(health({ stuckBuilds: 1 }), NOW).label).toBe("Resume build stuck");
  });

  test("stale page data only speaks when nothing upstream is wrong", () => {
    expect(watcherStatus(health(), NOW, true)).toMatchObject({
      level: "warn",
      label: "Refresh for new data",
    });
    expect(watcherStatus(health({ stuckBuilds: 2 }), NOW, true).label).toBe("Resume build stuck");
    expect(watcherStatus(health({ watcherPushedAt: NOW - 7 * H }), NOW, true).label).toBe(
      "Last check 7h ago"
    );
  });

  test("a push stamped in the future reads as just now", () => {
    expect(watcherStatus(health({ watcherPushedAt: NOW + 5 * M }), NOW).label).toBe("Checked 0m ago");
  });
});

describe("stalledNotice", () => {
  test("nothing to say while the watcher runs, however late", () => {
    expect(stalledNotice(health(), NOW)).toBeNull();
    expect(stalledNotice(health({ watcherPushedAt: NOW - 48 * H }), NOW)).toBeNull();
    expect(stalledNotice(null, NOW)).toBeNull();
  });

  test("a stall says how long", () => {
    expect(stalledNotice(health({ watcherPushedAt: NOW - 50 * H }), NOW)).toBe(
      "The watcher last ran 2d ago. New jobs are not being found."
    );
  });

  test("a watcher that never ran says so", () => {
    expect(stalledNotice(health({ watcherPushedAt: null }), NOW)).toBe(
      "The watcher has not run yet, so no jobs have been found."
    );
  });

  test("the notice and the chip agree on what a stall is", () => {
    for (const hours of [47, 48, 49, 200]) {
      const h = health({ watcherPushedAt: NOW - hours * H });
      expect(stalledNotice(h, NOW) !== null).toBe(watcherStatus(h, NOW).level === "bad");
    }
  });
});
