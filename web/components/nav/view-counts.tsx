"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { NavCounts } from "@/lib/view";

/**
 * Counts the header's pill nav shows next to Matches, Tracker and Inbox.
 *
 * The app layout computes all three on the server for every screen (Inbox
 * from getHealth, Matches and Tracker via lib/app-data.ts) and seeds this
 * provider with them, so a cold load of Settings still shows them. The `/`
 * surfaces then override with live numbers through `usePublishViewCount` -
 * Triage republishes as rows are hidden, AppViews publishes Tracker - and an
 * override outlives the surface, so the nav keeps the newest number while you
 * move to Inbox. A fresh seed (a refresh re-renders the layout) drops the
 * overrides: it is newer than anything published before it.
 */

type CountKey = "matches" | "tracker";
type Seed = Partial<Record<CountKey, number>>;

const CountsContext = createContext<{
  counts: NavCounts;
  publish: (key: CountKey, n: number) => void;
}>({ counts: { inbox: 0 }, publish: () => {} });

export function ViewCountsProvider({
  inboxPending,
  seed,
  children,
}: {
  inboxPending: number;
  /** Server-computed Matches/Tracker counts; absent when the read failed. */
  seed: Seed;
  children: ReactNode;
}) {
  const [state, setState] = useState<{ seed: Seed; published: Seed }>({ seed, published: {} });
  if (state.seed.matches !== seed.matches || state.seed.tracker !== seed.tracker) {
    // Adjusting state during render: a new seed supersedes older overrides.
    setState({ seed, published: {} });
  }
  const publish = useCallback((key: CountKey, n: number) => {
    setState((prev) =>
      prev.published[key] === n ? prev : { ...prev, published: { ...prev.published, [key]: n } }
    );
  }, []);
  const ctx = useMemo(
    () => ({
      counts: { ...state.seed, ...state.published, inbox: inboxPending },
      publish,
    }),
    [state, inboxPending, publish]
  );
  return <CountsContext.Provider value={ctx}>{children}</CountsContext.Provider>;
}

/** Matches/Tracker (undefined while unknown) and the inbox's pending count. */
export function useViewCounts(): NavCounts {
  return useContext(CountsContext).counts;
}

/** Publish a surface's live count to the header nav whenever it changes. */
export function usePublishViewCount(key: CountKey, n: number | undefined) {
  const { publish } = useContext(CountsContext);
  useEffect(() => {
    if (typeof n === "number") publish(key, n);
  }, [key, n, publish]);
}
