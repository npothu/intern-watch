"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Which of the app's two surfaces is on screen.
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
 */

export type AppView = "matches" | "tracker";

const VIEW_PARAM = "view";
const FILTER_PARAM = "filter";

/** The route that owns both views. Everything else is a real navigation. */
const APP_PATH = "/";

/** The canonical, directly-linkable URL for a view. */
export function viewHref(view: AppView, filter?: string): string {
  const params = new URLSearchParams();
  if (view === "tracker") params.set(VIEW_PARAM, "tracker");
  if (filter) params.set(FILTER_PARAM, filter);
  const query = params.toString();
  return query ? `${APP_PATH}?${query}` : APP_PATH;
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
