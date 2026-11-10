"use client";

import { useEffect, useSyncExternalStore, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSyncRefresh } from "@/lib/sync-pulse";

/**
 * "AS OF 10:39 AM ⟳" - the freshness readout and manual reload, carried over
 * from the Python webui (src/webui/static/index.html). It lives in the app
 * header; `useFreshness` reads it once so the desktop readout and the phone's
 * user-chip menu agree.
 *
 * The time is the data's, not the clock's: each data page renders
 * <LoadedAt /> (components/loaded-at.tsx), a server-stamped `at` that
 * `DataStamp` hands to the store below. So the readout moves only when a
 * server payload lands - a fresh navigation, or a refresh once it resolves -
 * and Back/Forward, which Next serves from its router cache, bring that
 * page's original stamp back. A refresh that fails delivers no payload and
 * the previous stamp stays.
 *
 * Refresh is `router.refresh()` inside a transition (via `useSyncRefresh`,
 * which also pulses the header's sync sweep): the icon spins until the server
 * components have re-rendered.
 *
 * The watcher cron runs every two hours, so data that outlives one cycle is
 * genuinely stale - past that the timestamp goes amber and carries a tooltip,
 * exactly as the webui's `checkStale` did.
 */

const STALE_MS = 2 * 3600e3; // one watcher cron cycle
const TICK_MS = 60e3;

let stamp: number | null = null;
const stampListeners = new Set<() => void>();

function subscribeStamp(onChange: () => void): () => void {
  stampListeners.add(onChange);
  return () => {
    stampListeners.delete(onChange);
  };
}

function setStamp(next: number | null) {
  if (stamp === next) return;
  stamp = next;
  stampListeners.forEach((cb) => cb());
}

/**
 * Publishes the mounted page's server-read time to the header readout, and
 * withdraws it on unmount, so a page without a stamp shows no time rather than
 * the previous page's. (React runs the outgoing page's cleanup before the
 * incoming page's effect in the same commit, and the equality guard keeps a
 * late cleanup from erasing a newer stamp.)
 */
export function DataStamp({ at }: { at: number }) {
  useEffect(() => {
    setStamp(at);
    return () => {
      if (stamp === at) setStamp(null);
    };
  }, [at]);
  return null;
}

/** The current data stamp; null on the server and until a page publishes. */
function useDataStamp(): number | null {
  return useSyncExternalStore(
    subscribeStamp,
    () => stamp,
    () => null
  );
}

/**
 * Minute-resolution clock for the staleness check. `null` on the server, so
 * nothing time-dependent renders during SSR and hydration agrees.
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
  /** "as of 10:39 AM"; empty until a page has published its stamp. */
  label: string;
  stale: boolean;
  pending: boolean;
  refresh: () => void;
};

export function useFreshness(): Freshness {
  const syncRefresh = useSyncRefresh();
  const [pending, startTransition] = useTransition();
  const at = useDataStamp();
  const minute = useMinute();
  const stale = at !== null && minute !== null && minute * TICK_MS - at > STALE_MS;

  return {
    label: at !== null && minute !== null ? `as of ${formatTime(at)}` : "",
    stale,
    pending,
    refresh: () => startTransition(() => syncRefresh()),
  };
}

/**
 * The header's mono readout plus its refresh icon button. The text hides
 * below 1200px to keep the header on one row; the button's tooltip and name
 * still carry the time.
 */
export function FreshnessReadout({
  freshness,
  className,
}: {
  freshness: Freshness;
  className?: string;
}) {
  const { label, stale, pending, refresh } = freshness;
  const staleNote = stale ? " - older than one cron cycle" : "";
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <span
        title={stale ? "data is older than one cron cycle - hit refresh" : undefined}
        className={cn(
          "hidden font-mono text-[11px] tracking-[0.06em] whitespace-nowrap uppercase tabular-nums min-[1200px]:inline",
          stale ? "font-medium text-amber" : "text-ink-2"
        )}
      >
        {label}
      </span>
      <button
        type="button"
        onClick={refresh}
        disabled={pending}
        aria-label={label ? `Refresh data (${label}${staleNote})` : "Refresh data"}
        title={label ? `Refresh data (${label}${staleNote})` : "Refresh data"}
        className={cn(
          "inline-flex size-7 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-chip hover:text-ink disabled:cursor-default disabled:opacity-70",
          stale ? "text-amber" : "text-ink-2"
        )}
      >
        <RefreshCw className={cn("size-3.5", pending && "animate-spin")} />
      </button>
    </span>
  );
}
