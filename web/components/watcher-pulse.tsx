"use client";

import { Suspense, use } from "react";
import {
  PULSE_H,
  PULSE_W,
  pulseGeometry,
  pulseLabel,
  pulseTotals,
  type PulseRun,
} from "@/lib/watcher-pulse";

/** The chart is the 100x20 geometry drawn at this scale. */
const SCALE = 2.5;

/**
 * The watcher sparkline in the status popover: new matches per run over the
 * 24h ending at `now` (the layout's server render time), the last 6h in
 * accent with a dot at the newest run - so a quiet watcher leaves empty
 * space on the right - and a caption saying what the line is and how many
 * matches it adds up to. The runs arrive as a promise the layout started
 * (lib/convex.ts getWatcherRuns, which never rejects), read inside its own
 * Suspense boundary so the popover never waits on it. Fewer than two runs in
 * the window - including the query not being deployed yet - draws nothing.
 */
export function WatcherPulse({
  runs,
  now,
  clock,
}: {
  runs: Promise<PulseRun[]>;
  now: number;
  /** The visitor's minute clock, for the accessible name's "last run" age. */
  clock: number;
}) {
  return (
    <Suspense fallback={null}>
      <Pulse runs={runs} now={now} clock={clock} />
    </Suspense>
  );
}

function Pulse({ runs: promise, now, clock }: { runs: Promise<PulseRun[]>; now: number; clock: number }) {
  const runs = use(promise);
  const geo = pulseGeometry(runs, now);
  if (!geo) return null;
  const { found } = pulseTotals(runs, now);
  return (
    <div className="mb-2.5">
      <svg
        role="img"
        aria-label={pulseLabel(runs, now, clock)}
        viewBox={`0 0 ${PULSE_W} ${PULSE_H}`}
        width={PULSE_W * SCALE}
        height={PULSE_H * SCALE}
        className="block max-w-full"
      >
        <polyline
          fill="none"
          stroke="var(--color-line-2)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          points={geo.all}
        />
        <polyline
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          points={geo.tail}
        />
        <circle cx={geo.end.x} cy={geo.end.y} r={1.4} fill="var(--color-accent)" />
      </svg>
      <div className="mt-1.5 flex justify-between gap-3 font-mono text-[10.5px] tracking-[0.04em] text-ink-2 uppercase tabular-nums">
        <span>New matches per run, last 24h</span>
        <span className="shrink-0">{found} found</span>
      </div>
    </div>
  );
}
