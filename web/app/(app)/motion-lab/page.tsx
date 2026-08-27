import { notFound } from "next/navigation";
import { Triage } from "@/components/matches/triage";
import { MotionPreviewToggle } from "@/components/motion-preview";
import type { TriageRow } from "@/app/(app)/page";

/**
 * Motion lab: the real triage surface over fixtures, with every write kept
 * local (`demo`). It exists so the animation work can be exercised to
 * destruction - tick, untick, hide ten rows, undo the burst, retype the search
 * - without any of it reaching a real tracker's ticks or applications ledger.
 *
 * Dev-only: 404s in production, so it can't ship as a route by accident.
 */

const row = (
  short: string,
  company: string,
  title: string,
  location: string,
  term: string,
  added: string,
  tag: string,
  salary: string,
  extra: Partial<TriageRow> = {}
): TriageRow => ({
  key: `demo:${short}`,
  short,
  company,
  title,
  location,
  term,
  added,
  tag,
  salary,
  url: "https://example.com/",
  resumeUrl: null,
  applied: false,
  saved: false,
  dismissed: false,
  hasJobDescription: false,
  ...extra,
});

const ROWS: TriageRow[] = [
  // Priority employers land in the pinned group above the term groups.
  row("msft-az1", "Microsoft", "Software Engineering Intern - Azure Core", "Redmond, WA", "Summer 2027", "2026-08-05", "[PRIORITY]", "$56/hr", { priority: true }),
  row("meta-rl2", "Meta", "Software Engineer Intern - Reality Labs", "Menlo Park, CA", "Spring 2027", "2026-08-03", "[PRIORITY]", "$62/hr", { priority: true, saved: true }),
  row("nvda-gpu1", "NVIDIA", "Software Engineering Intern, GPU Systems", "Santa Clara, CA", "Summer 2027", "2026-08-04", "[top]", "$52/hr", { applied: true }),
  row("snow-db2", "Snowflake", "Software Engineer Intern - Database Engine", "Bellevue, WA", "Summer 2027", "2026-08-03", "[top]", "$55/hr", { saved: true }),
  row("cap1-be4", "Capital One", "Technology Intern - Backend Platforms", "Atlanta, GA", "Summer 2027", "2026-08-02", "[atl]", ""),
  row("strp-pay9", "Stripe", "Software Engineer Intern, Payments Infrastructure", "New York, NY", "Summer 2027", "2026-08-02", "[top]", "$60/hr"),
  row("dbx-sync3", "Dropbox", "Software Engineer Intern - Sync Engine", "Remote, US", "Summer 2027", "2026-08-01", "", "$48/hr"),
  row("tsla-emb7", "Tesla", "Embedded Software Engineer Intern - Chassis Systems", "Palo Alto, CA", "Fall 2026", "2026-07-30", "[top]", ""),
  row("amzn-sde2", "Amazon", "Software Development Engineer Internship - Fall 2026 (US)", "Seattle, WA", "Fall 2026", "2026-07-29", "[top]", "$51/hr", { resumeUrl: "#demo" }),
  row("dely-ops5", "Delta Air Lines", "IT Software Engineering Intern", "Atlanta, GA", "Fall 2026", "2026-07-28", "[atl]", ""),
  row("hd-plat1", "The Home Depot", "Software Engineer Intern - Platform", "Atlanta, GA", "Fall 2026", "2026-07-27", "[atl]", "$44/hr"),
  row("univ-cre8", "Universal Creative", "Ride Systems Software Intern", "Orlando, FL", "Spring 2027", "2026-07-26", "[gone]", ""),
  row("mdb-atlas", "MongoDB", "Software Engineer Intern - Atlas", "Remote, US", "Spring 2027", "2026-07-25", "", "$50/hr"),
  row("dsny-park", "Disney", "Software Engineering Intern - Park Technology", "Orlando, FL", "Spring 2027", "2026-07-24", "[top]", ""),
  row("figm-ed3", "Figma", "Software Engineer Intern - Editor", "San Francisco, CA", "Spring 2027", "2026-07-23", "[top]", "$58/hr"),
  row("chwy-ml2", "Chewy", "Machine Learning Engineer Intern", "Boston, MA", "Spring 2027", "2026-07-22", "", ""),
];

export default function MotionLabPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <>
      <div className="mx-auto w-full max-w-[1060px] px-5 pt-5">
        <MotionPreviewToggle />
      </div>
      <Triage rows={ROWS} demo />
    </>
  );
}
