import type { FollowUp } from "../../convex/referral_types";

export * from "../../convex/referral_types";

export function localDate(date = new Date()): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}
export function followUpDue(record: FollowUp, today: string): boolean {
  return !!record.followUpOn && record.followUpOn <= today;
}
export function followUpLabel(value: string, today: string): string {
  if (!value) return "";
  if (value === today) return "Today";
  return (
    (value < today ? "Overdue · " : "") +
    new Date(value + "T12:00:00").toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      ...(value.slice(0, 4) !== today.slice(0, 4)
        ? { year: "numeric" as const }
        : {}),
    })
  );
}
export type ReferralTarget = { kind: "contact" | "referral"; id: string };
