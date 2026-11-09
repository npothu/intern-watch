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

/**
 * Counts the header's pill nav shows next to Matches, Tracker and Inbox.
 *
 * Inbox's pending count comes from the layout's one getHealth call, so it is
 * known on every page. Matches and Tracker counts live in the `/` page's data,
 * which the layout never sees: the surfaces publish them upward through
 * `usePublishViewCount`, and the provider keeps the last value, so after one
 * visit to `/` the counts stay on the nav while you are on Inbox or Settings.
 * A page loaded cold away from `/` shows no Matches/Tracker count until then
 * (the pill renders without one rather than a wrong zero).
 */

type CountKey = "matches" | "tracker";
type Counts = Partial<Record<CountKey, number>>;

const InboxPendingContext = createContext(0);
const CountsContext = createContext<{
  counts: Counts;
  publish: (key: CountKey, n: number) => void;
}>({ counts: {}, publish: () => {} });

export function InboxPendingProvider({
  value,
  children,
}: {
  value: number;
  children: ReactNode;
}) {
  const [counts, setCounts] = useState<Counts>({});
  const publish = useCallback((key: CountKey, n: number) => {
    setCounts((prev) => (prev[key] === n ? prev : { ...prev, [key]: n }));
  }, []);
  const ctx = useMemo(() => ({ counts, publish }), [counts, publish]);
  return (
    <InboxPendingContext.Provider value={value}>
      <CountsContext.Provider value={ctx}>{children}</CountsContext.Provider>
    </InboxPendingContext.Provider>
  );
}

export function useInboxPending(): number {
  return useContext(InboxPendingContext);
}

/** The last published Matches/Tracker counts (undefined until published). */
export function useViewCounts(): Counts {
  return useContext(CountsContext).counts;
}

/** Publish a surface's count to the header nav whenever it changes. */
export function usePublishViewCount(key: CountKey, n: number | undefined) {
  const { publish } = useContext(CountsContext);
  useEffect(() => {
    if (typeof n === "number") publish(key, n);
  }, [key, n, publish]);
}
