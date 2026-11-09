"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import { usePathname } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSyncRefresh } from "@/lib/sync-pulse";

/**
 * "AS OF 10:39 AM ⟳" - the freshness readout and manual reload, carried over
 * from the Python webui (src/webui/static/index.html). It lives in the app
 * header now; `useFreshness` holds the state once so the desktop readout and
 * the phone's user-chip menu show the same time and share one refresh.
 *
 * Pages are server components that read Convex at request time, so a refresh
 * is `router.refresh()` inside a transition: the icon spins and the button is
 * disabled until the server component has re-rendered. It goes through
 * `useSyncRefresh`, which also pulses the header's sync sweep.
 *
 * The header outlives navigation, so the stamp also moves when the pathname
 * changes - a route change is a fresh server read. Matches <-> Tracker share
 * one route and fetch nothing, so switching between them keeps the stamp.
 *
 * The watcher cron runs every two hours, so data that outlives one cycle is
 * genuinely stale - past that the timestamp goes amber and carries a tooltip,
 * exactly as the webui's `checkStale` did.
 */

const STALE_MS = 2 * 3600e3; // one watcher cron cycle
const TICK_MS = 60e3;

/**
 * Minute-resolution clock. `null` on the server, which is also how this
 * component knows not to render a time during SSR: the server's clock and the
 * visitor's are different values for the same text node, and React reports
 * that as a hydration mismatch.
 */
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

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export type Freshness = {
  /** "as of 10:39 AM"; empty until mounted so SSR and hydration agree. */
  label: string;
  stale: boolean;
  pending: boolean;
  refresh: () => void;
};

export function useFreshness(): Freshness {
  const syncRefresh = useSyncRefresh();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();
  // When this page's data was last loaded on the client: mount, every route
  // change, every refresh. Stamped as the refresh starts rather than as it
  // lands - the router gives no completion callback, and the gap is small.
  const [stamp, setStamp] = useState(() => ({ path: pathname, at: Date.now() }));
  const minute = useMinute();
  if (stamp.path !== pathname && minute !== null) {
    // Adjusting state during render on a route change; the minute clock keeps
    // the render pure, and the readout only shows minutes anyway.
    setStamp({ path: pathname, at: minute * TICK_MS });
  }
  const mounted = minute !== null;
  // Staleness is measured off the minute clock rather than a fresh Date.now(),
  // so the render stays pure and re-evaluates when the clock ticks.
  const stale = mounted && minute * TICK_MS - stamp.at > STALE_MS;

  function refresh() {
    setStamp({ path: pathname, at: Date.now() });
    startTransition(() => syncRefresh());
  }

  return {
    label: mounted ? `as of ${formatTime(stamp.at)}` : "",
    stale,
    pending,
    refresh,
  };
}

/** The header's mono readout plus its refresh icon button. */
export function FreshnessReadout({
  freshness,
  className,
}: {
  freshness: Freshness;
  className?: string;
}) {
  const { label, stale, pending, refresh } = freshness;
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span
        title={stale ? "data is older than one cron cycle - hit refresh" : undefined}
        className={cn(
          "font-mono text-[11px] tracking-[0.06em] whitespace-nowrap uppercase tabular-nums",
          stale ? "font-medium text-amber" : "text-ink-2"
        )}
      >
        {label}
      </span>
      <button
        type="button"
        onClick={refresh}
        disabled={pending}
        aria-label="Refresh data"
        title="Refresh data"
        className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-chip hover:text-ink disabled:cursor-default disabled:opacity-70"
      >
        <RefreshCw className={cn("size-3.5", pending && "animate-spin")} />
      </button>
    </span>
  );
}
