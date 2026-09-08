import { defineTable } from "convex/server";
import { v } from "convex/values";

export const availabilityValidator = v.union(
  v.literal("can_refer"),
  v.literal("not_asked"),
  v.literal("unavailable"),
);
export const referralStatusValidator = v.union(
  v.literal("planned"),
  v.literal("requested"),
  v.literal("submitted"),
  v.literal("declined"),
  v.literal("canceled"),
);
export const followUpFields = { followUpOn: v.string(), nextStep: v.string() };
export const contactFields = {
  name: v.string(),
  company: v.string(),
  relationship: v.string(),
  email: v.string(),
  profileUrl: v.string(),
  availability: availabilityValidator,
  ...followUpFields,
};
export const referralFields = {
  contactId: v.id("referralContacts"),
  jobShort: v.string(),
  company: v.string(),
  title: v.string(),
  url: v.string(),
  term: v.string(),
  requisitionId: v.string(),
  status: referralStatusValidator,
  ...followUpFields,
};
const recordFields = {
  user: v.string(),
  archived: v.boolean(),
  createdAt: v.number(),
  updatedAt: v.number(),
};

export const referralTables = {
  referralContacts: defineTable({ ...contactFields, ...recordFields }).index(
    "by_user",
    ["user"],
  ),
  referrals: defineTable({ ...referralFields, ...recordFields })
    .index("by_user", ["user"])
    .index("by_contact", ["contactId"]),
  referralNotes: defineTable({
    user: v.string(),
    contactId: v.id("referralContacts"),
    referralId: v.optional(v.id("referrals")),
    text: v.string(),
    createdAt: v.number(),
  })
    .index("by_user", ["user"])
    .index("by_contact", ["contactId"]),
};
