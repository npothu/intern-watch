import "server-only";
import { cache } from "react";
import {
  getLedger,
  getMatches,
  getTicks,
  getWatchSettings,
  type MatchItem,
  type ResumeUrls,
} from "@/lib/convex";
import { shortKey } from "@/lib/shortkey";
import { normCompany } from "@/lib/company";
import { resolvePreferences } from "@/lib/preferences";
import { dayFromIso } from "@/lib/terms";
import { utcDayIso } from "@/lib/headline";
import { buildTrackerRows } from "@/components/tracker/build-rows";
import { liveMatchCount } from "@/components/matches/matches-lib";
import type { TriageRow } from "@/app/(app)/page";

/**
 * The server-side reads the `/` page and the app layout share.
 *
 * The layout needs the Matches and Tracker counts on every screen (the header
 * nav), and the page needs the rows themselves. Each read is wrapped in
 * React's per-request `cache`, so on `/` the layout's count pass and the
 * page's render issue one set of Convex queries between them, not two, and
 * Referrals reads its matches and ledger through `loadCore` for the same
 * reason. On the other screens the layout still pays for matches, ticks,
 * ledger and settings - there is no count-only query, and this PR does not add
 * one to convex/ - but it streams those counts instead of awaiting them, so
 * the screen never waits on them; resume URLs only the page reads.
 */

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Matches, ticks, ledger and preferences for one request, read once. */
export const loadCore = cache(async (user: string) => {
  const [matches, ticks, ledger, settings] = await Promise.all([
    getMatches(user),
    getTicks(user),
    getLedger(user),
    // A failed preferences read degrades to "no preferences known".
    getWatchSettings(user).catch(() => null),
  ]);
  // Request time, as the watcher stamps `added`: the UTC day.
  const todayIso = utcDayIso();
  const prefs = resolvePreferences(settings, dayFromIso(todayIso));
  return { matches, ticks, ledger, prefs, todayIso };
});

type Core = Awaited<ReturnType<typeof loadCore>>;

/** The match items as the surface's rows, with ticks and resume URLs folded in. */
export function toTriageRows(core: Core, resumes: ResumeUrls): TriageRow[] {
  const ticksByShort = new Map(core.ticks.map((t) => [t.short, t]));
  return core.matches.map((m: MatchItem) => {
    const short = typeof m.short === "string" && m.short ? m.short : shortKey(m.key);
    const tick = ticksByShort.get(short);
    const applied = tick?.applied ?? m.applied ?? false;
    return {
      key: str(m.key),
      short,
      company: str(m.company),
      title: str(m.title),
      location: str(m.location),
      term: str(m.term),
      added: str(m.added),
      tag: str(m.tag),
      // Stamped by the watcher at match time, or on the current list now.
      priority: m.priority === true || core.prefs.priorityNames.has(normCompany(str(m.company))),
      salary: str(m.salary),
      url: str(m.url),
      // Only an actually-resolved external URL counts as "built"; a
      // repo-relative path or storage id from the source item is not a
      // linkable resume and is deliberately dropped.
      resumeUrl: resumes[short]?.url ?? null,
      resumeMeta: resumes[short] ?? null,
      applied,
      saved: tick?.saved ?? m.saved ?? false,
      dismissed: tick?.dismissed ?? m.dismissed ?? false,
      hasJobDescription: m.hasJobDescription ?? false,
      // An applied row is the user's call, not a dead link to warn about.
      closed: m.closed === true && !applied,
      ...(m.facts && typeof m.facts === "object" ? { facts: m.facts } : {}),
    };
  });
}

/**
 * The header nav's Matches and Tracker counts, by the same definitions the
 * surfaces use (liveMatchCount, buildTrackerRows). Resume URLs change neither
 * count, so they are not fetched here.
 */
export async function loadViewCounts(user: string): Promise<{ matches: number; tracker: number }> {
  const core = await loadCore(user);
  return {
    // Unwatched terms hidden, as the list opens; a deep link that opens on an
    // unwatched row makes Triage publish the larger count on mount instead.
    matches: liveMatchCount(toTriageRows(core, {}), core.prefs.wantedTerms, false),
    tracker: buildTrackerRows(core.ledger, core.matches, {}).length,
  };
}
