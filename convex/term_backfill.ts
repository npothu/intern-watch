import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import { inferTermDetailed } from "./ingest_extract";

// One-off repair for match rows stored with no term: re-run inferTermDetailed
// over the title, URL and stored JD text. DRY RUN BY DEFAULT - it reports what
// it would set and writes nothing until called with dryRun: false:
//
//   npx convex run term_backfill:backfillTerms '{}'                 # report
//   npx convex run term_backfill:backfillTerms '{"dryRun": false}'  # write
//
// Only existing match rows are touched. A job the watcher rejected never
// became a match, so it stays rejected (CLAUDE.md: rejected jobs are final).
// Rows carrying a hand correction (overrides.term) are skipped. A watcher row
// keeps the backfilled term across runs because pushMatches never replaces a
// known term with a blank one.

const PAGE = 200;
const SAMPLE = 15;

type Counts = {
  scanned: number;
  blank: number;
  blankWithJd: number;
  corrected: number;
  resolved: number;
  resolvedFromJd: number;
  explicit: number;
  inferred: number;
  unresolved: number;
  written: number;
};

type Sample = { user: string; short: string; title: string; term: string; confidence: string; source: string | null };

const zero = (): Counts => ({
  scanned: 0, blank: 0, blankWithJd: 0, corrected: 0, resolved: 0, resolvedFromJd: 0,
  explicit: 0, inferred: 0, unresolved: 0, written: 0,
});

function isBlankTerm(term: unknown): boolean {
  return typeof term !== "string" || !term.trim() || /^unknown/i.test(term.trim());
}

export const backfillPage = internalMutation({
  args: {
    user: v.optional(v.string()),
    cursor: v.union(v.string(), v.null()),
    dryRun: v.boolean(),
  },
  handler: async (ctx, { user, cursor, dryRun }) => {
    const query = user
      ? ctx.db.query("matches").withIndex("by_user", (q) => q.eq("user", user))
      : ctx.db.query("matches");
    const page = await query.paginate({ cursor, numItems: PAGE });
    const counts = zero();
    const samples: Sample[] = [];
    for (const row of page.page) {
      counts.scanned++;
      if (!isBlankTerm(row.item?.term)) continue;
      counts.blank++;
      if (row.overrides?.term) { counts.corrected++; continue; }
      const jd = row.jobDescription?.trim() ? row.jobDescription : null;
      if (jd) counts.blankWithJd++;
      const added = typeof row.item?.added === "string" && /^\d{4}-\d{2}-\d{2}/.test(row.item.added)
        ? row.item.added : undefined;
      const got = inferTermDetailed({ title: row.item?.title, url: row.item?.url, jd, today: added });
      if (!got.term) { counts.unresolved++; continue; }
      counts.resolved++;
      if (got.source === "jd") counts.resolvedFromJd++;
      if (got.confidence === "explicit") counts.explicit++; else counts.inferred++;
      if (samples.length < SAMPLE) {
        samples.push({
          user: row.user, short: row.short, title: String(row.item?.title ?? ""),
          term: got.term, confidence: got.confidence, source: got.source,
        });
      }
      if (!dryRun) {
        await ctx.db.patch(row._id, { item: { ...row.item, term: got.term, termConfidence: got.confidence } });
        counts.written++;
      }
    }
    return { counts, samples, cursor: page.continueCursor, isDone: page.isDone };
  },
});

/** Page through matches (optionally one user's) and report or apply the backfill. */
export const backfillTerms = internalAction({
  args: { user: v.optional(v.string()), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { user, dryRun }): Promise<{ dryRun: boolean; counts: Counts; samples: Sample[] }> => {
    const dry = dryRun ?? true;
    const counts = zero();
    const samples: Sample[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: { counts: Counts; samples: Sample[]; cursor: string; isDone: boolean } =
        await ctx.runMutation(internal.term_backfill.backfillPage, { user, cursor, dryRun: dry });
      for (const k of Object.keys(counts) as (keyof Counts)[]) counts[k] += page.counts[k];
      samples.push(...page.samples.slice(0, SAMPLE - samples.length));
      if (page.isDone) break;
      cursor = page.cursor;
    }
    return { dryRun: dry, counts, samples };
  },
});
