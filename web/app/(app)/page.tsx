import { resolveTrackerUser } from "@/lib/user";
import { getTrackerUserData, type MatchItem } from "@/lib/convex";
import { shortKey } from "@/lib/shortkey";
import { Triage } from "@/components/matches/triage";

/**
 * The matches triage page (the app's default route). Resolves the signed-in
 * user to their tracker user, folds the store's ticks into the match rows by
 * short key, attaches each built resume URL, and hands a clean, fully typed
 * array to the client component. The app layout already renders the
 * "not provisioned" screen when resolveTrackerUser() is null, so a null here
 * shouldn't happen - guard anyway so this component never renders a broken
 * page on its own.
 */

export type TriageRow = {
  key: string;
  short: string;
  company: string;
  title: string;
  location: string;
  term: string;
  added: string;
  tag: string;
  salary: string;
  url: string;
  resumeUrl: string | null;
  applied: boolean;
  saved: boolean;
  dismissed: boolean;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export default async function MatchesPage() {
  const user = await resolveTrackerUser();
  if (!user) return null;

  const data = await getTrackerUserData(user);

  const ticksByShort = new Map(data.ticks.map((t) => [t.short, t]));

  const rows: TriageRow[] = data.matches.map((m: MatchItem) => {
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
      salary: str(m.salary),
      url: str(m.url),
      // Only an actually-resolved external URL counts as "built" in v1; a
      // repo-relative path or storage id from the source item is not a
      // linkable resume and is deliberately dropped.
      resumeUrl: data.resumes[short] ?? null,
      applied: tick?.applied ?? m.applied ?? false,
      saved: tick?.saved ?? m.saved ?? false,
      dismissed: tick?.dismissed ?? m.dismissed ?? false,
    };
  });

  return <Triage rows={rows} />;
}
