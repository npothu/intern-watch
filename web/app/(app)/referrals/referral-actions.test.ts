import { beforeEach, expect, test, vi } from "vitest";
import { resolveTrackerUser } from "@/lib/user";
import { mutateReferrals } from "@/lib/convex";
import { revalidatePath } from "next/cache";
import {
  changeReferralStatus,
  changeReferralFollowUp,
} from "./referral-actions";

vi.mock("@/lib/user", () => ({ resolveTrackerUser: vi.fn() }));
vi.mock("@/lib/convex", () => ({ mutateReferrals: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
});

test("resolves the account again on each save and refuses unauthenticated mutations", async () => {
  vi.mocked(resolveTrackerUser).mockResolvedValue(null);
  expect(await changeReferralStatus("some-id", "submitted")).toMatchObject({
    ok: false,
  });
  expect(mutateReferrals).not.toHaveBeenCalled();
  vi.mocked(resolveTrackerUser).mockResolvedValue("alice");
  vi.mocked(mutateReferrals).mockResolvedValue(undefined);
  expect(await changeReferralStatus("some-id", "submitted")).toEqual({
    ok: true,
  });
  expect(mutateReferrals).toHaveBeenCalledWith("alice", "setStatus", {
    id: "some-id",
    status: "submitted",
  });
  expect(revalidatePath).toHaveBeenCalledWith("/referrals");
});

test("preserves validation messages and hides backend stack traces", async () => {
  vi.mocked(resolveTrackerUser).mockResolvedValue("alice");
  vi.mocked(mutateReferrals).mockRejectedValue(
    new Error(
      "Server Error\nUncaught ConvexError: Choose a valid follow-up date.\n  at file.ts:1",
    ),
  );
  expect(
    await changeReferralFollowUp(
      { kind: "contact", id: "some-id" },
      { followUpOn: "bad", nextStep: "" },
    ),
  ).toEqual({ ok: false, error: "Choose a valid follow-up date." });
  expect(revalidatePath).not.toHaveBeenCalled();
  vi.mocked(mutateReferrals).mockRejectedValue(
    new Error("private infrastructure details"),
  );
  expect(await changeReferralStatus("some-id", "submitted")).toEqual({
    ok: false,
    error: "Couldn't save your changes. Please try again.",
  });
});
