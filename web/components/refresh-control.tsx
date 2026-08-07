"use client";

import { useState, useSyncExternalStore, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSyncRefresh } from "@/lib/sync-pulse";

/**
 * "as of 10:39 AM ⟳ refresh" - the freshness readout and manual reload,
 * carried over from the Python webui (src/webui/static/index.html).
 *
 * The page is a server component that reads Convex at request time, so a
 * refresh is `router.refresh()` inside a transition: the icon spins and the
 * button is disabled until the server component has re-rendered. It goes
 * through `useSyncRefresh`, which also pulses the header's sync sweep.
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

export function RefreshControl({ className }: { className?: string }) {
  const syncRefresh = useSyncRefresh();
  const [pending, startTransition] = useTransition();
  // When this page's data was last loaded on the client: mount, then every
  // refresh. Stamped as the refresh starts rather than as it lands - the
  // router gives no completion callback, and the gap is a few hundred ms.
  const [loadedAt, setLoadedAt] = useState(() => Date.now());
  const minute = useMinute();
  const mounted = minute !== null;
  // Staleness is measured off the minute clock rather than a fresh Date.now(),
  // so the render stays pure and re-evaluates when the clock ticks.
  const stale = mounted && minute * TICK_MS - loadedAt > STALE_MS;

  function refresh() {
    setLoadedAt(Date.now());
    startTransition(() => syncRefresh());
  }

  return (
    <div className={cn("flex items-center gap-2 text-[12.5px]", className)}>
      <span
        // Rendered empty until mount so SSR and hydration agree on the text.
        title={stale ? "data is older than one cron cycle - hit refresh" : undefined}
        className={cn(
          "tabular-nums",
          stale ? "font-medium text-amber" : "text-ink-2"
        )}
      >
        {mounted ? `as of ${formatTime(loadedAt)}` : ""}
      </span>
      <button
        type="button"
        onClick={refresh}
        disabled={pending}
        aria-label="Refresh data"
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line-2 bg-surface px-2.5 py-1 text-ink-2 transition-colors hover:border-ink-2 hover:text-ink disabled:cursor-default disabled:opacity-70"
      >
        <RefreshCw className={cn("size-3.5", pending && "animate-spin")} />
        refresh
      </button>
    </div>
  );
}
