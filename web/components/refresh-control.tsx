"use client";

import { useEffect, useSyncExternalStore, useTransition } from "react";
import { useSyncRefresh } from "@/lib/sync-pulse";
import { MINUTE_MS, useMinute } from "@/lib/use-minute";

/**
 * "as of 10:39 AM" - when the page's data was read, and the manual reload,
 * carried over from the Python webui (src/webui/static/index.html). The
 * header reads it once with `useFreshness` and shows it in the status chip's
 * popover (components/watcher-status.tsx), next to Refresh.
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
 * genuinely stale - past that `stale` is set and the status chip asks for a
 * refresh, as the webui's `checkStale` did.
 */

const STALE_MS = 2 * 3600e3; // one watcher cron cycle

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
  const stale = at !== null && minute !== null && minute * MINUTE_MS - at > STALE_MS;

  return {
    label: at !== null && minute !== null ? `as of ${formatTime(at)}` : "",
    stale,
    pending,
    refresh: () => startTransition(() => syncRefresh()),
  };
}
