"use client";

import { Suspense, use, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import { PULSE_H, PULSE_W, pulseGeometry, pulseLabel, sinceLabel, type PulseRun } from "@/lib/watcher-pulse";

/**
 * The header's watcher sparkline: new matches per run over the last day,
 * the last quarter in accent with a dot at the newest run, then the mono
 * time since that run. The runs arrive as a promise the layout started
 * (lib/convex.ts getWatcherRuns, which never rejects), read inside its own
 * Suspense boundary so the header never waits on it. Fewer than two runs -
 * including the query not being deployed yet - draws nothing. Hidden below
 * 1200px, like the freshness text beside it.
 */
export function WatcherPulse({ runs, className }: { runs: Promise<PulseRun[]>; className?: string }) {
  return (
    <Suspense fallback={null}>
      <Pulse runs={runs} className={className} />
    </Suspense>
  );
}

const TICK_MS = 60e3;

/** Minute clock; null on the server so the "since" text never mismatches. */
function useMinute(): number | null {
  return useSyncExternalStore(
    (onChange) => {
      const id = setInterval(onChange, TICK_MS);
      return () => clearInterval(id);
    },
    () => Math.floor(Date.now() / TICK_MS),
    () => null
  );
}

function Pulse({ runs: promise, className }: { runs: Promise<PulseRun[]>; className?: string }) {
  const runs = use(promise);
  const minute = useMinute();
  const geo = pulseGeometry(runs);
  if (!geo) return null;
  const lastAt = runs[runs.length - 1].at;
  const since = minute !== null ? sinceLabel(lastAt, minute * TICK_MS) : null;
  const absolute =
    minute !== null
      ? new Date(lastAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : undefined;
  return (
    <span
      className={cn(
        "hidden items-center gap-2 font-mono text-[11px] tracking-[0.06em] whitespace-nowrap text-ink-2 uppercase tabular-nums min-[1200px]:inline-flex",
        className
      )}
    >
      <svg
        role="img"
        aria-label={since ? `${pulseLabel(runs)}; last run ${since} ago` : pulseLabel(runs)}
        viewBox={`0 0 ${PULSE_W} ${PULSE_H}`}
        width={PULSE_W}
        height={PULSE_H}
        className="flex-none"
      >
        <polyline fill="none" stroke="var(--color-line-2)" strokeWidth={1} points={geo.all} />
        <polyline
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          points={geo.tail}
        />
        <circle cx={geo.end.x} cy={geo.end.y} r={2.5} fill="var(--color-accent)" />
      </svg>
      {since && <span title={absolute ? `Last watcher run ${absolute}` : undefined}>{since}</span>}
    </span>
  );
}
