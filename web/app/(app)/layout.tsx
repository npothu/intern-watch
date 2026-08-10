import { resolveTrackerUser } from "@/lib/user";
import { getHealth } from "@/lib/convex";
import { SiteHeader } from "@/components/site-header";
import { NotProvisioned } from "@/components/not-provisioned";
import { InboxPendingProvider } from "@/components/nav/view-counts";
import { ViewCycle } from "@/components/nav/view-cycle";

/**
 * Auth-gated app shell for the whole app (everything except the Clerk
 * sign-in/sign-up pages, which live outside this route group). If the signed
 * in email isn't provisioned, render the full-page "not provisioned" state
 * instead of the app.
 *
 * The header's health dot + inbox badge come from one getHealth call here.
 * A failed health read degrades to null (the dot shows "no data") rather
 * than taking the whole shell down - health reporting must never be the
 * thing that breaks the page.
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
  const health = await getHealth(trackerUser).catch(() => null);
  return (
    <InboxPendingProvider value={health?.pendingInbox ?? 0}>
      {/* Global `t` view-cycle - see components/nav/view-cycle.tsx for why
          this can't live inside any one surface. */}
      <ViewCycle />
      <SiteHeader trackerUser={trackerUser} health={health} />
      <main className="flex-1">{children}</main>
    </InboxPendingProvider>
  );
}
