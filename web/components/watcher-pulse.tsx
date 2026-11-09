"use client";

import { Suspense, use, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";
import {
  PULSE_H,
  PULSE_W,
  lastRunAt,
  pulseGeometry,
  pulseLabel,
  sinceLabel,
  type PulseRun,
} from "@/lib/watcher-pulse";

/**
 * The header's watcher sparkline: new matches per run over the 24h ending
 * at `now` (the layout's server render time), the last 6h in accent with a
 * dot at the newest run - so a quiet watcher leaves empty space on the
 * right - then the mono time since that run. The runs arrive as a promise
 * the layout started (lib/convex.ts getWatcherRuns, which never rejects),
 * read inside its own Suspense boundary so the header never waits on it.
 * Fewer than two runs in the window - including the query not being
 * deployed yet - draws nothing. Hidden below 1200px, like the freshness text
 * beside it.
 */
export function WatcherPulse({
  runs,
  now,
  className,
}: {
  runs: Promise<PulseRun[]>;
  now: number;
  className?: string;
}) {
  return (
    <Suspense fallback={null}>
      <Pulse runs={runs} now={now} className={className} />
    </Suspense>
  );
}

const TICK_MS = 60e3;

/** Minute clock; null on the server and during hydration. */
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

function Pulse({ runs: promise, now, className }: { runs: Promise<PulseRun[]>; now: number; className?: string }) {
  const runs = use(promise);
  const minute = useMinute();
  const geo = pulseGeometry(runs, now);
  const lastAt = lastRunAt(runs, now);
  if (!geo || lastAt === null) return null;
  // First paint (server and hydration) measures from the server's render
  // time, so both agree; the minute tick takes over after that. Never
  // earlier than `now`, so a slow client clock cannot run the caption back.
  const clock = minute !== null ? Math.max(now, minute * TICK_MS) : now;
  const since = sinceLabel(lastAt, clock);
  const absolute =
    minute !== null
      ? new Date(lastAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
      : new Date(lastAt).toISOString();
  return (
    <span
      className={cn(
        "hidden items-center gap-2 font-mono text-[11px] tracking-[0.06em] whitespace-nowrap text-ink-2 uppercase tabular-nums min-[1200px]:inline-flex",
        className
      )}
    >
      <svg
        role="img"
        aria-label={pulseLabel(runs, now, clock)}
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
      {/* Three characters covers every label ("59m", "47h", "6d"). */}
      <span className="inline-block w-[3ch]" title={`Last watcher run ${absolute}`}>
        {since}
      </span>
    </span>
  );
}
