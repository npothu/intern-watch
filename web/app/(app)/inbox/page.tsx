import { resolveTrackerUser } from "@/lib/user";
import { getInboxActions } from "@/lib/convex";
import { Inbox } from "@/components/inbox/inbox";

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
  const { actions, health } = await getInboxActions(user).catch(() => ({
    actions: [],
    health: null,
  }));
  return (
    <div className="mx-auto w-full max-w-[1060px] px-5 pb-24 pt-4">
      <Inbox initialActions={actions} health={health} />
    </div>
  );
}
