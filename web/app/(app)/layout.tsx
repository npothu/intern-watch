import { resolveTrackerUser } from "@/lib/user";
import { getHealth } from "@/lib/convex";
import { SiteHeader } from "@/components/site-header";
import { NotProvisioned } from "@/components/not-provisioned";
import { MotionPreviewInit } from "@/components/motion-preview";

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
    <>
      {/* Dev-only: carries the "force motion" preview override across pages so
          the motion can be reviewed on a reduced-motion machine. */}
      {process.env.NODE_ENV !== "production" && <MotionPreviewInit />}
      <SiteHeader
        trackerUser={trackerUser}
        inboxCount={health?.pendingInbox ?? 0}
        health={health}
      />
      <main className="flex-1">{children}</main>
    </>
  );
}
