import { resolveTrackerUser } from "@/lib/user";
import { getInboxActions } from "@/lib/convex";
import { Inbox } from "@/components/inbox/inbox";
import { PAGE_CONTAINER } from "@/lib/layout";

export const dynamic = "force-dynamic";

/**
 * The mail-triage inbox: pending `inboxActions` rows - recruiter emails the
 * classifier identified but was not decisive about - each resolvable in one
 * click into a tracker status change (convex/mail.ts resolveAction writes
 * through the same applyStatus as a hand-set status).
 */
export default async function InboxPage() {
  const user = await resolveTrackerUser();
  if (!user) return null; // layout already rendered NotProvisioned
  const { actions, applications, health } = await getInboxActions(user).catch(() => ({
    actions: [],
    applications: [],
    health: null,
  }));
  return (
    <div className={`${PAGE_CONTAINER} pt-5 pb-24 min-[700px]:pt-7`}>
      <Inbox initialActions={actions} applications={applications} health={health} />
    </div>
  );
}
