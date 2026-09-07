"use server";

import { revalidatePath } from "next/cache";
import { resolveTrackerUser } from "@/lib/user";
import { mutateReferrals } from "@/lib/convex";
import type {
  ContactInput,
  ReferralInput,
  ReferralStatus,
  FollowUp,
  ReferralTarget,
} from "@/lib/referrals";

export type ReferralResult =
  | { ok: true; id?: string }
  | { ok: false; error: string };

async function save(
  operation: Parameters<typeof mutateReferrals>[1],
  args: Record<string, unknown>,
): Promise<ReferralResult> {
  const user = await resolveTrackerUser();
  if (!user)
    return {
      ok: false,
      error: "Sign in with a provisioned account to save referrals.",
    };
  try {
    const id = await mutateReferrals(user, operation, args);
    revalidatePath("/referrals");
    return { ok: true, ...(typeof id === "string" ? { id } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const validation = message.split("ConvexError: ")[1]?.split("\n")[0];
    return {
      ok: false,
      error: validation || "Couldn't save your changes. Please try again.",
    };
  }
}

function targetArgs(target: ReferralTarget) {
  return target.kind === "contact"
    ? { contactId: target.id }
    : { referralId: target.id };
}

export async function saveReferralContact(
  input: ContactInput,
  id?: string,
  initialNote?: string,
) {
  return save("saveContact", { input, id, initialNote });
}
export async function saveJobReferral(input: ReferralInput, id?: string) {
  return save("saveReferral", { input, id });
}
export async function changeReferralStatus(id: string, status: ReferralStatus) {
  return save("setStatus", { id, status });
}
export async function changeReferralFollowUp(
  target: ReferralTarget,
  input: FollowUp,
) {
  return save("setFollowUp", { ...targetArgs(target), ...input });
}
export async function archiveReferralRecord(
  target: ReferralTarget,
  archived: boolean,
) {
  return save("setArchived", { ...targetArgs(target), archived });
}
export async function addReferralNote(
  contactId: string,
  note: string,
  referralId?: string,
) {
  return save("addNote", { contactId, note, referralId });
}
