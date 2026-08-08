"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { LayoutList, ListChecks, Mail, type LucideIcon } from "lucide-react";

/**
 * Which of the app's top-level surfaces is on screen.
 *
 * Matches and Tracker used to be two dynamic server routes, so switching
 * between them re-ran a server render, refetched Convex and repainted the whole
 * shell - a visible refresh for what is really a tab change. They now share one
 * route (`/`), which loads both datasets in a single pass, and the view is
 * carried in a search param:
 *
 *     /                 matches
 *     /?filter=hidden   matches, opened on the hidden list
 *     /?view=tracker    tracker
 *
 * The switch itself goes through the native History API. Next keeps
 * `useSearchParams()` in sync with `history.pushState` without re-running the
 * server render, so a view change costs no round trip and no refetch, while the
 * URL still names the view and stays directly linkable. `/tracker` is kept
 * alive as an entry point by a redirect in next.config.ts.
 *
 * Inbox is a genuine third surface, but a real route rather than a search
 * param - its own page does real data fetching next.config.ts doesn't need to
 * fake. `ViewId` is the union of everything that earns a cell in the view
 * switch (components/nav/view-switch.tsx); `AppView` stays the narrower
 * matches/tracker pair that `/` itself switches between.
 */

export type AppView = "matches" | "tracker";
export type ViewId = AppView | "inbox";

const VIEW_PARAM = "view";
const FILTER_PARAM = "filter";

/** The route that owns both views. Everything else is a real navigation. */
const APP_PATH = "/";

/** The canonical, directly-linkable URL for a view. */
export function viewHref(view: ViewId, filter?: string): string {
  if (view === "inbox") return "/inbox";
  const params = new URLSearchParams();
  if (view === "tracker") params.set(VIEW_PARAM, "tracker");
  if (filter) params.set(FILTER_PARAM, filter);
  const query = params.toString();
  return query ? `${APP_PATH}?${query}` : APP_PATH;
}

/** One row of the view registry - enough to render a switch cell or a dock
 *  entry without either hardcoding the view list, so a fourth view is a
 *  one-line addition here. */
export type ViewEntry = {
  id: ViewId;
  label: string;
  icon: LucideIcon;
  href: string;
};

// Matches -> LayoutList and Tracker -> ListChecks already name these two
// surfaces in the command palette ("Go to Matches" / "Go to Tracker"); reusing
// them here keeps one icon vocabulary instead of inventing a second.
export const VIEWS: ViewEntry[] = [
  { id: "matches", label: "Matches", icon: LayoutList, href: viewHref("matches") },
  { id: "tracker", label: "Tracker", icon: ListChecks, href: viewHref("tracker") },
  { id: "inbox", label: "Inbox", icon: Mail, href: viewHref("inbox") },
];

/** Cycle order for the `t` shortcut (components/nav/view-cycle.tsx). */
export const VIEW_ORDER: ViewId[] = VIEWS.map((v) => v.id);

/** The view after `current` in cycle order; wraps, and treats "no current
 *  view" (e.g. on Resume, which has no cell) as if it were one step before
 *  Matches, so cycling from there lands on Matches first. */
export function nextViewId(current: ViewId | null): ViewId {
  const idx = current ? VIEW_ORDER.indexOf(current) : -1;
  return VIEW_ORDER[(idx + 1 + VIEW_ORDER.length) % VIEW_ORDER.length];
}

export type AppViewState = {
  view: AppView;
  /** The matches filter a deep link asked for (`?filter=hidden`), if any. */
  filter: string | undefined;
  /** Show a view, optionally opening matches on a filter. */
  show: (view: AppView, filter?: string) => void;
};

export function useAppView(): AppViewState {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const view: AppView = params.get(VIEW_PARAM) === "tracker" ? "tracker" : "matches";
  const filter = params.get(FILTER_PARAM) ?? undefined;

  const show = useCallback(
    (next: AppView, nextFilter?: string) => {
      const href = viewHref(next, nextFilter);
      // Only the app route holds both views; from anywhere else (the dev-only
      // motion lab) getting there is a genuine navigation.
      if (pathname !== APP_PATH) {
        router.push(href);
        return;
      }
      if (`${window.location.pathname}${window.location.search}` === href) return;
      window.history.pushState(null, "", href);
    },
    [pathname, router]
  );

  return { view, filter, show };
}
