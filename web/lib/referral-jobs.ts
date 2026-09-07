import type { LedgerRecord, MatchItem } from "./convex";
import { buildTrackerRows } from "@/components/tracker/build-rows";
import { shortKey } from "./shortkey";
import type { ReferralJob } from "../../convex/referral_types";

/** Includes saved ledger snapshots after a job leaves Matches. */
export function buildReferralJobs(
  matches: MatchItem[],
  ledger: Record<string, LedgerRecord>,
): ReferralJob[] {
  const jobs = new Map<string, ReferralJob>();
  for (const match of matches) {
    const short = match.short || shortKey(match.key);
    jobs.set(short, {
      short,
      company: match.company,
      title: match.title,
      url: match.url,
      term: match.term,
      applicationStatus: match.applied ? "applied" : "",
      inMatches: true,
    });
  }
  for (const row of buildTrackerRows(ledger, matches, {})) {
    const match = jobs.get(row.short);
    jobs.set(row.short, {
      short: row.short,
      company: row.company,
      title: row.title,
      url: row.url,
      term: match?.term ?? "",
      inMatches: !!match,
      applicationStatus: row.status,
    });
  }
  return [...jobs.values()].sort(
    (a, b) =>
      a.company.localeCompare(b.company) || a.title.localeCompare(b.title),
  );
}
