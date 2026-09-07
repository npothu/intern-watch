// Dependency-free contract shared by Convex and the web app.
export const AVAILABILITY = {
  can_refer: "Can refer",
  not_asked: "Not asked",
  unavailable: "Unavailable",
} as const;
export const REFERRAL_STATUS = {
  planned: "Planned",
  requested: "Requested",
  submitted: "Submitted",
  declined: "Declined",
  canceled: "Canceled",
} as const;
export type Availability = keyof typeof AVAILABILITY;
export type ReferralStatus = keyof typeof REFERRAL_STATUS;

export type FollowUp = { followUpOn: string; nextStep: string };
export type ContactInput = FollowUp & {
  name: string;
  company: string;
  relationship: string;
  email: string;
  profileUrl: string;
  availability: Availability;
};
export type ReferralInput = FollowUp & {
  contactId: string;
  jobShort: string;
  company: string;
  title: string;
  url: string;
  term: string;
  requisitionId: string;
  status: ReferralStatus;
};
type SavedRecord = {
  id: string;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
};
export type ReferralContact = ContactInput & SavedRecord;
export type JobReferral = ReferralInput & SavedRecord;
export type ReferralNote = {
  id: string;
  contactId: string;
  referralId: string;
  text: string;
  createdAt: number;
};
export type ReferralData = {
  contacts: ReferralContact[];
  referrals: JobReferral[];
  notes: ReferralNote[];
};
export type ReferralJob = {
  short: string;
  company: string;
  title: string;
  url: string;
  term: string;
  applicationStatus: string;
  inMatches: boolean;
};

/** Calendar dates, with impossible dates rejected instead of rolled forward. */
export function validFollowUpDate(value: string): boolean {
  if (value === "") return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T12:00:00Z");
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

export function safeReferralUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    )
      return url.href;
  } catch {
    /* The caller supplies a field-specific error. */
  }
  return "";
}
