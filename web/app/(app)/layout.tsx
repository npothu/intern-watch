import { resolveTrackerUser } from "@/lib/user";
import { getHealth, getWatcherRuns } from "@/lib/convex";
import { loadViewCounts } from "@/lib/app-data";
import { SiteHeader } from "@/components/site-header";
import { NotProvisioned } from "@/components/not-provisioned";
import { ViewCountsProvider } from "@/components/nav/view-counts";
import { ViewCycle } from "@/components/nav/view-cycle";

/**
 * Auth-gated app shell for the whole app (everything except the Clerk
 * sign-in/sign-up pages, which live outside this route group). If the signed
 * in email isn't provisioned, render the full-page "not provisioned" state
 * instead of the app.
 *
 * The header's health dot and Inbox count come from one getHealth call here.
 * Its Matches/Tracker counts come from lib/app-data.ts, started here but
 * streamed rather than awaited (on `/` and Referrals the reads are shared with
 * the page through the per-request cache). Either read failing degrades - the
 * dot to "no data", the counts to absent - rather than taking the whole shell
 * down: header numbers must never be the thing that breaks the page.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const trackerUser = await resolveTrackerUser();
  if (!trackerUser) {
    return <NotProvisioned />;
  }
  // Not awaited: the counts stream into the header (ViewCountsProvider), so
  // their reads never hold up the shell or the page.
  const counts = loadViewCounts(trackerUser).catch(() => null);
  // Same for the watcher sparkline's runs (getWatcherRuns never rejects; an
  // absent query or a failed read is [] and the sparkline does not draw).
  // `renderedAt` is this request's server time, the same instant the page's
  // <LoadedAt /> stamps for the "as of" readout: the sparkline's 24h window
  // ends there and its "since" caption measures from it on first paint.
  // eslint-disable-next-line react-hooks/purity
  const renderedAt = Date.now();
  const runs = getWatcherRuns(trackerUser, renderedAt - 24 * 3600e3);
  const health = await getHealth(trackerUser).catch(() => null);
  return (
    <ViewCountsProvider inboxPending={health?.pendingInbox ?? 0} seed={counts}>
      {/* Global `t` view-cycle - see components/nav/view-cycle.tsx for why
          this can't live inside any one surface. */}
      <ViewCycle />
      <SiteHeader trackerUser={trackerUser} health={health} runs={runs} renderedAt={renderedAt} />
      <main className="flex-1">{children}</main>
    </ViewCountsProvider>
  );
}
