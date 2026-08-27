import { resolveTrackerUser } from "@/lib/user";
import {
  getTrackerUserData,
  getWatchSettings,
  type MatchItem,
  type ResumeMeta,
} from "@/lib/convex";
import { shortKey } from "@/lib/shortkey";
import { normCompany } from "@/lib/company";
import { resolvePreferences } from "@/lib/preferences";
import { dayFromIso } from "@/lib/terms";
import { buildTrackerRows } from "@/components/tracker/build-rows";
import { AppViews } from "@/components/app-views";
import type { TrackerRow } from "@/components/tracker/tracker-lib";

/**
 * The app route - it serves both surfaces, matches and tracker, and the URL
 * says which one is showing (see lib/view.ts). One server render loads
 * everything both need, so switching views is client-side and instant.
 *
 * The two datasets cost nothing extra to load together: `getTrackerUserData`
 * already fetches matches, ticks, ledger and resume URLs in one parallel batch,
 * and that is a superset of what each surface used to fetch on its own.
 *
 * The app layout already renders the "not provisioned" screen when
 * resolveTrackerUser() is null, so a null here shouldn't happen - guard anyway
 * so this component never renders a broken page on its own.
 */

export const dynamic = "force-dynamic";

export type TriageRow = {
  key: string;
  short: string;
  company: string;
  title: string;
  location: string;
  term: string;
  added: string;
  tag: string;
  /** Priority employer at match time: pinned to the top of its term group. */
  priority?: boolean;
  salary: string;
  url: string;
  resumeUrl: string | null;
  /** Full build metadata (report, previous version) for the report dialog. */
  resumeMeta?: ResumeMeta | null;
  applied: boolean;
  saved: boolean;
  dismissed: boolean;
  hasJobDescription: boolean;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export default async function AppPage() {
  const user = await resolveTrackerUser();
  if (!user) return null;

  // Preferences ride along so the surface reflects them on this render:
  // priority employers pin their rows now, and terms switched off stay out
  // of the way. A failed read degrades to "no preferences known".
  const [data, settings] = await Promise.all([
    getTrackerUserData(user),
    getWatchSettings(user).catch(() => null),
  ]);
  const todayIso = new Date().toISOString().slice(0, 10); // request time; force-dynamic
  const prefs = resolvePreferences(settings, dayFromIso(todayIso));

  const ticksByShort = new Map(data.ticks.map((t) => [t.short, t]));

  const matches: TriageRow[] = data.matches.map((m: MatchItem) => {
    const short =
      typeof m.short === "string" && m.short ? m.short : shortKey(m.key);
    const tick = ticksByShort.get(short);
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
      priority: m.priority === true || prefs.priorityNames.has(normCompany(str(m.company))),
      salary: str(m.salary),
      url: str(m.url),
      // Only an actually-resolved external URL counts as "built"; a
      // repo-relative path or storage id from the source item is not a
      // linkable resume and is deliberately dropped.
      resumeUrl: data.resumes[short]?.url ?? null,
      resumeMeta: data.resumes[short] ?? null,
      applied: tick?.applied ?? m.applied ?? false,
      saved: tick?.saved ?? m.saved ?? false,
      dismissed: tick?.dismissed ?? m.dismissed ?? false,
      hasJobDescription: m.hasJobDescription ?? false,
    };
  });

  const applications: TrackerRow[] = buildTrackerRows(
    data.ledger,
    data.matches,
    data.resumes
  );

  return (
    <AppViews
      matches={matches}
      applications={applications}
      wantedTerms={prefs.wantedTerms}
    />
  );
}
