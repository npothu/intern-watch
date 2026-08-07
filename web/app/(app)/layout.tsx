import { resolveTrackerUser } from "@/lib/user";
import { SiteHeader } from "@/components/site-header";
import { NotProvisioned } from "@/components/not-provisioned";
import { MotionPreviewInit } from "@/components/motion-preview";

/**
 * Auth-gated app shell for / and /tracker (everything except the Clerk
 * sign-in/sign-up pages, which live outside this route group). If the signed
 * in email isn't provisioned, render the full-page "not provisioned" state
 * instead of the app.
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
  return (
    <>
      {/* Dev-only: carries the "force motion" preview override across pages so
          the motion can be reviewed on a reduced-motion machine. */}
      {process.env.NODE_ENV !== "production" && <MotionPreviewInit />}
      <SiteHeader trackerUser={trackerUser} />
      <main className="flex-1">{children}</main>
    </>
  );
}
