"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  FileText,
  LayoutList,
  ListChecks,
  Mail,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";

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
 * Matches carries more of its view the same way, so a link reproduces it:
 * `?filter=applied` (the stage tab), `?show=priority,saved` (the chips),
 * `?term=su27`, `?sort=found.desc` (company|term|found, asc|desc) and
 * `?open=<short>` (the row whose details are open).
 * Parsing and formatting live in components/matches/matches-lib.ts; the
 * matches surface replaces (never pushes) the entry as they change.
 *
 * The switch itself goes through the native History API. Next keeps
 * `useSearchParams()` in sync with `history.pushState` without re-running the
 * server render, so a view change costs no round trip and no refetch, while the
 * URL still names the view and stays directly linkable. `/tracker` is kept
 * alive as an entry point by a redirect in next.config.ts.
 *
 * Inbox and Referrals use separate routes and fetch their own data.
 * `ViewId` is the union of the views the `t` shortcut cycles through
 * (components/nav/view-cycle.tsx); `DestId` adds Profile and Settings, the
 * rest of the registry (`VIEWS`). `AppView` stays the narrower
 * matches/tracker pair that `/` itself switches between.
 */

export type AppView = "matches" | "tracker";
export type ViewId = AppView | "inbox" | "referrals";
/** Every destination in the registry: the cycled views plus Profile and
 *  Settings, which you visit on purpose rather than cycle through. */
export type DestId = ViewId | "profile" | "settings";

const VIEW_PARAM = "view";
const FILTER_PARAM = "filter";

/** The route that owns both views. Everything else is a real navigation. */
const APP_PATH = "/";

/** The canonical, directly-linkable URL for a destination. */
export function viewHref(view: DestId, filter?: string): string {
  if (view === "inbox") return "/inbox";
  if (view === "referrals") return "/referrals";
  if (view === "profile") return "/profile";
  if (view === "settings") return "/settings";
  const params = new URLSearchParams();
  if (view === "tracker") params.set(VIEW_PARAM, "tracker");
  if (filter) params.set(FILTER_PARAM, filter);
  const query = params.toString();
  return query ? `${APP_PATH}?${query}` : APP_PATH;
}

/**
 * The numbers the header nav can show (components/nav/view-counts.tsx). A nav
 * badge means "something here needs you", never a total: matches found today
 * that are still to apply, and inbox items waiting for review.
 */
export type NavCounts = { newMatches?: number; inbox: number };

/** One row in the shared navigation registry. */
export type ViewEntry = {
  id: DestId;
  label: string;
  icon: LucideIcon;
  href: string;
  /** Gets a pill in the header nav. */
  nav: boolean;
  /** Part of the `t` cycle (components/nav/view-cycle.tsx). */
  cycle: boolean;
  /** The command palette's wording for going there. */
  paletteLabel: string;
  /** The pill's badge, if it has one right now. */
  count?: (c: NavCounts) => number | undefined;
  /** What the badge counts, for its tooltip and accessible name. */
  countLabel?: (n: number) => string;
  /** The badge's colour: accent for news, amber for work waiting. */
  countTone?: "accent" | "amber";
};

const entry = (
  id: DestId,
  label: string,
  icon: LucideIcon,
  rest: Partial<Omit<ViewEntry, "id" | "label" | "icon" | "href">> = {}
): ViewEntry => ({
  id,
  label,
  icon,
  href: viewHref(id),
  nav: true,
  cycle: true,
  paletteLabel: `Go to ${label}`,
  ...rest,
});

/**
 * The one navigation registry: the header's pill nav, the shell's fallback
 * palette, the referrals palette and the `t` cycle all derive from it.
 * Matches -> LayoutList and Tracker -> ListChecks match the icons the
 * surfaces' own palettes use for the same moves.
 */
export const VIEWS: ViewEntry[] = [
  entry("matches", "Matches", LayoutList, {
    count: (c) => (c.newMatches ? c.newMatches : undefined),
    countLabel: (n) => `${n} new today`,
    countTone: "accent",
  }),
  entry("tracker", "Tracker", ListChecks),
  entry("inbox", "Inbox", Mail, {
    count: (c) => (c.inbox > 0 ? c.inbox : undefined),
    countLabel: (n) => `${n} to review`,
    countTone: "amber",
  }),
  entry("profile", "Profile", FileText, { cycle: false }),
  entry("referrals", "Referrals", Users),
  entry("settings", "Settings", Settings, {
    nav: false,
    cycle: false,
    paletteLabel: "Open Settings",
  }),
];

/** Cycle order for the `t` shortcut (components/nav/view-cycle.tsx). */
export const VIEW_ORDER: ViewId[] = VIEWS.filter((v) => v.cycle).map((v) => v.id as ViewId);

/** The view after `current` in cycle order; wraps, and treats "no current
 *  view" (e.g. on Resume, which has no cell) as if it were one step before
 *  Matches, so cycling from there lands on Matches first. */
export function nextViewId(current: ViewId | null): ViewId {
  const idx = current ? VIEW_ORDER.indexOf(current) : -1;
  return VIEW_ORDER[(idx + 1 + VIEW_ORDER.length) % VIEW_ORDER.length];
}

export type AppViewState = {
  view: AppView;
  job: string | undefined;
  /** Show a view, optionally opening matches on a filter. */
  show: (view: AppView, filter?: string) => void;
};

export function useAppView(): AppViewState {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const view: AppView = params.get(VIEW_PARAM) === "tracker" ? "tracker" : "matches";

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

  return { view, show, job: params.get("job") ?? undefined };
}
