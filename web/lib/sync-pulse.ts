"use client";

import { useCallback, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";

/**
 * The "a sync just happened" signal the header's sweep animation rides on.
 *
 * The sweep used to key off `usePathname`, which meant it replayed on every
 * Matches <-> Tracker switch. Those are two views of one route now, so there is
 * no pathname to key off - and keying it off the view would be wrong anyway:
 * the sweep reads as "data synced", and swapping views syncs nothing. It keys
 * off actual syncs instead.
 *
 * A sync is a load of fresh server data: the first paint (covered by the CSS
 * animation running on mount, with the counter still at its initial value) and
 * every `router.refresh()` afterwards - the refresh control, and an Add URL
 * ingest landing. Those all go through `useSyncRefresh()`, so the pulse and the
 * refetch can't drift apart.
 */

let pulses = 0;
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** Refetch this route's server data, and tell the header a sync is underway. */
export function useSyncRefresh(): () => void {
  const router = useRouter();
  return useCallback(() => {
    pulses += 1;
    listeners.forEach((cb) => cb());
    router.refresh();
  }, [router]);
}

/** How many syncs have happened this session. Starts at 0 on the server. */
export function useSyncPulse(): number {
  return useSyncExternalStore(
    subscribe,
    () => pulses,
    () => 0
  );
}
