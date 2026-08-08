import { resolveTrackerUser } from "@/lib/user";
import { getInboxActions } from "@/lib/convex";
import { Inbox } from "@/components/inbox/inbox";
import { ViewSwitch } from "@/components/nav/view-switch";

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
    <div className="mx-auto w-full max-w-[1060px] px-5 pt-5 pb-24">
      {/* The Inbox component owns everything below this - it has no header
          row of its own to fold the switch into, so this is a standalone row
          at the same y-offset the switch sits at on every other surface. */}
      <div className="mb-3">
        <ViewSwitch active="inbox" />
      </div>
      <Inbox initialActions={actions} health={health} />
    </div>
  );
}
