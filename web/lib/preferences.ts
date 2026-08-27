// What the Matches surface needs from Settings > Preferences, resolved once
// per server render: which employers count as priority right now, and which
// terms are wanted right now. Both come from the same two sources the
// preferences page shows - what the user saved (`watch`, wins) and what the
// watcher last reported (`report`, the yaml and the watcher's own resolution,
// including alias groups and tracker employers only it can compute).
//
// This is what lets a company added on the preferences page pin its rows at
// the top immediately, rather than after the watcher's next run re-stamps
// them (which it also does, in src/main.py, so the digest and dashboard
// agree by the next tick).

import { normCompany } from "@/lib/company";
import { termRows, termStart, type Day, type TermsConfig } from "@/lib/terms";
import type { WatchSettings } from "@/lib/convex";

export type Preferences = {
  /** Normalized employer names that count as priority today. */
  priorityNames: Set<string>;
  /** Wanted terms today, or null when nothing is known (no hiding then). */
  wantedTerms: string[] | null;
};

export function resolvePreferences(settings: WatchSettings | null, today: Day): Preferences {
  const saved = settings?.watch ?? null;
  const report = settings?.report ?? null;

  const priorityNames = new Set<string>();
  const add = (names: string[] | undefined) => {
    for (const n of names ?? []) {
      const k = normCompany(n);
      if (k) priorityNames.add(k);
    }
  };
  // The saved list is the live truth; the report adds what only the watcher
  // resolves (alias groups, ledger employers) as of its last run.
  add(saved?.priority?.companies ?? report?.priority?.companies);
  add(report?.priority?.resolved);
  const fromTracker = saved?.priority?.fromTracker ?? report?.priority?.from_tracker ?? false;
  if (fromTracker) add(report?.priority?.tracker_companies);

  let wantedTerms: string[] | null = null;
  let cfg: TermsConfig | null = null;
  if (saved?.terms) {
    cfg = saved.terms;
  } else if (report?.terms?.rolling && Number.isInteger(report.terms.lead_weeks)) {
    cfg = {
      leadWeeks: report.terms.lead_weeks,
      horizonMonths: report.terms.horizon_months,
      include: report.terms.include ?? [],
      exclude: report.terms.exclude ?? [],
    };
  }
  if (cfg) {
    wantedTerms = termRows(cfg, today).filter((r) => r.wanted).map((r) => r.term);
  } else if (report?.terms?.rows?.length) {
    // Legacy static list: the watcher's rows are the whole answer.
    wantedTerms = report.terms.rows.filter((r) => r.wanted).map((r) => r.term);
  }
  return { priorityNames, wantedTerms };
}

/** A term the wanted set can speak to: parseable, so "Unknown term" and
 *  manual-ingest oddities are never hidden by it. */
export function isKnownTerm(term: string): boolean {
  return termStart(term) !== null;
}
