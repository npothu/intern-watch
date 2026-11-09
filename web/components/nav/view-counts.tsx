"use client";

import {
  Suspense,
  createContext,
  use,
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
 * Inbox comes from the layout's getHealth call. Matches and Tracker are
 * seeded on the server for every screen (lib/app-data.ts loadViewCounts),
 * but the layout does not wait for them: it hands this provider the seed as
 * a promise, and `SeedResolver` reads it with `use()` inside its own Suspense
 * boundary, so the header and the page render at once and the two counts
 * stream in when the read lands. A slow or failed read leaves the pills
 * without a count; it never delays or breaks the screen.
 *
 * The `/` surfaces override with live numbers through `usePublishViewCount`
 * (Triage for Matches, AppViews for Tracker), and an override outlives the
 * surface, so the nav keeps the newest number while you move to Inbox.
 *
 * Every server render of the layout (a hard load, a refresh) sends a new
 * seed promise, and its arrival starts a new seed `version`: all overrides
 * are dropped, whatever the numbers, and the surfaces still mounted
 * republish because their publish effect depends on the version. So after a
 * refresh on Inbox the pill is the server's count again, while on `/` the
 * mounted Triage puts its own live count straight back.
 */

type CountKey = "matches" | "tracker";
type Seed = Partial<Record<CountKey, number>>;
export type SeedPromise = Promise<Seed | null>;

type State = {
  /** The promise the current seed came from; identity marks a server render. */
  source: SeedPromise | null;
  seed: Seed;
  published: Seed;
  version: number;
};

const CountsContext = createContext<{
  counts: NavCounts;
  version: number;
  publish: (key: CountKey, n: number) => void;
}>({ counts: { inbox: 0 }, version: 0, publish: () => {} });

/** Resolves the streamed seed and hands it to the provider; renders nothing. */
function SeedResolver({
  promise,
  onSeed,
}: {
  promise: SeedPromise;
  onSeed: (source: SeedPromise, seed: Seed | null) => void;
}) {
  const seed = use(promise);
  useEffect(() => onSeed(promise, seed), [promise, seed, onSeed]);
  return null;
}

export function ViewCountsProvider({
  inboxPending,
  seed,
  children,
}: {
  inboxPending: number;
  /** The server's Matches/Tracker counts, streamed; null when the read failed. */
  seed: SeedPromise;
  children: ReactNode;
}) {
  const [state, setState] = useState<State>({ source: null, seed: {}, published: {}, version: 0 });

  const onSeed = useCallback((source: SeedPromise, value: Seed | null) => {
    setState((prev) =>
      prev.source === source
        ? prev
        : { source, seed: value ?? {}, published: {}, version: prev.version + 1 }
    );
  }, []);

  const publish = useCallback((key: CountKey, n: number) => {
    setState((prev) =>
      prev.published[key] === n ? prev : { ...prev, published: { ...prev.published, [key]: n } }
    );
  }, []);

  const ctx = useMemo(
    () => ({
      counts: { ...state.seed, ...state.published, inbox: inboxPending },
      version: state.version,
      publish,
    }),
    [state, inboxPending, publish]
  );

  return (
    <CountsContext.Provider value={ctx}>
      <Suspense fallback={null}>
        <SeedResolver promise={seed} onSeed={onSeed} />
      </Suspense>
      {children}
    </CountsContext.Provider>
  );
}

/** Matches/Tracker (undefined while unknown) and the inbox's pending count. */
export function useViewCounts(): NavCounts {
  return useContext(CountsContext).counts;
}

/**
 * Publish a surface's live count to the header nav whenever it changes, and
 * again whenever a new server seed has replaced the overrides.
 */
export function usePublishViewCount(key: CountKey, n: number | undefined) {
  const { publish, version } = useContext(CountsContext);
  useEffect(() => {
    if (typeof n === "number") publish(key, n);
  }, [key, n, publish, version]);
}
