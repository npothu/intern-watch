import { v, ConvexError } from "convex/values";
import {
  mutation,
  query,
  type QueryCtx,
  type MutationCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  contactFields,
  referralFields,
  followUpFields,
  referralStatusValidator,
} from "./referral_schema";
import {
  safeReferralUrl,
  validFollowUpDate,
  REFERRAL_STATUS,
  type FollowUp,
} from "./referral_types";

const authFields = { user: v.string(), secret: v.string() };
function authorize(user: string, secret: string) {
  if (!process.env.TRACKER_SECRET || secret !== process.env.TRACKER_SECRET)
    throw new Error("bad secret");
  if (!user.trim()) throw new ConvexError("A user is required.");
}
function text(value: string, label: string, max = 200, required = false) {
  const result = value.trim();
  if (required && !result) throw new ConvexError(label + " is required.");
  if (result.length > max)
    throw new ConvexError(
      label + " is too long (maximum " + max + " characters).",
    );
  return result;
}
function url(value: string, label: string) {
  const result = text(value, label, 2000);
  const safe = safeReferralUrl(result);
  if (result && !safe)
    throw new ConvexError(label + " must be an http or https URL.");
  return safe;
}
function followUp(input: FollowUp) {
  if (!validFollowUpDate(input.followUpOn))
    throw new ConvexError("Choose a valid follow-up date.");
  return {
    followUpOn: input.followUpOn,
    nextStep: text(input.nextStep, "Next step", 500),
  };
}
async function contactFor(
  ctx: QueryCtx,
  user: string,
  id: Id<"referralContacts">,
) {
  const row = await ctx.db.get(id);
  if (!row || row.user !== user) throw new ConvexError("Contact not found.");
  return row;
}
async function referralFor(ctx: QueryCtx, user: string, id: Id<"referrals">) {
  const row = await ctx.db.get(id);
  if (!row || row.user !== user) throw new ConvexError("Referral not found.");
  return row;
}
async function addActivity(
  ctx: MutationCtx,
  user: string,
  contactId: Id<"referralContacts">,
  message: string,
  referralId?: Id<"referrals">,
) {
  await ctx.db.insert("referralNotes", {
    user,
    contactId,
    referralId,
    text: message,
    createdAt: Date.now(),
  });
}

async function ensureUniqueJob(
  ctx: QueryCtx,
  record: Pick<
    Doc<"referrals">,
    "contactId" | "jobShort" | "url" | "company" | "requisitionId"
  >,
  exclude?: Id<"referrals">,
) {
  const siblings = await ctx.db
    .query("referrals")
    .withIndex("by_contact", (q) => q.eq("contactId", record.contactId))
    .collect();
  if (
    siblings.some(
      (r) =>
        r._id !== exclude &&
        !r.archived &&
        ((record.jobShort && r.jobShort === record.jobShort) ||
          (record.url && r.url === record.url) ||
          (record.requisitionId &&
            r.requisitionId === record.requisitionId &&
            r.company.toLowerCase() === record.company.toLowerCase())),
    )
  )
    throw new ConvexError(
      "This contact already has a referral for that job. Edit the existing referral instead.",
    );
}

export const getOverview = query({
  args: authFields,
  handler: async (ctx, { user, secret }) => {
    authorize(user, secret);
    const [contacts, referrals, notes] = await Promise.all([
      ctx.db
        .query("referralContacts")
        .withIndex("by_user", (q) => q.eq("user", user))
        .collect(),
      ctx.db
        .query("referrals")
        .withIndex("by_user", (q) => q.eq("user", user))
        .collect(),
      ctx.db
        .query("referralNotes")
        .withIndex("by_user", (q) => q.eq("user", user))
        .order("desc")
        .collect(),
    ]);
    return {
      contacts: contacts.map(
        ({ _id, _creationTime: _time, user: _user, ...row }) => ({
          id: _id,
          ...row,
        }),
      ),
      referrals: referrals.map(
        ({ _id, _creationTime: _time, user: _user, ...row }) => ({
          id: _id,
          ...row,
        }),
      ),
      notes: notes.map((n) => ({
        id: n._id,
        contactId: n.contactId,
        referralId: n.referralId ?? "",
        text: n.text,
        createdAt: n.createdAt,
      })),
    };
  },
});

export const saveContact = mutation({
  args: {
    ...authFields,
    id: v.optional(v.id("referralContacts")),
    input: v.object(contactFields),
    initialNote: v.optional(v.string()),
  },
  handler: async (ctx, { user, secret, id, input, initialNote }) => {
    authorize(user, secret);
    if (id) await contactFor(ctx, user, id);
    const email = text(input.email, "Email", 320);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new ConvexError("Enter a valid email address.");
    const fields = {
      name: text(input.name, "Name", 200, true),
      company: text(input.company, "Company", 200, true),
      relationship: text(input.relationship, "Relationship"),
      email,
      profileUrl: url(input.profileUrl, "Profile link"),
      availability: input.availability,
      ...followUp(input),
      updatedAt: Date.now(),
    };
    const note = text(initialNote ?? "", "Note", 5000);
    if (id) {
      await ctx.db.patch(id, fields);
      return id;
    }
    const newId = await ctx.db.insert("referralContacts", {
      ...fields,
      user,
      archived: false,
      createdAt: Date.now(),
    });
    if (note) await addActivity(ctx, user, newId, note);
    return newId;
  },
});

export const saveReferral = mutation({
  args: {
    ...authFields,
    id: v.optional(v.id("referrals")),
    input: v.object(referralFields),
  },
  handler: async (ctx, { user, secret, id, input }) => {
    authorize(user, secret);
    const previous = id ? await referralFor(ctx, user, id) : null;
    const contact = await contactFor(ctx, user, input.contactId);
    if (contact.archived && previous?.contactId !== contact._id)
      throw new ConvexError("Restore this contact before logging a referral.");
    if (previous && previous.contactId !== contact._id)
      throw new ConvexError(
        "A referral's contact cannot be changed. Log a separate referral for another person.",
      );
    const jobShort = text(input.jobShort, "Job key", 12);
    if (jobShort && !/^[0-9a-f]{12}$/.test(jobShort))
      throw new ConvexError("Invalid job key.");
    let job = {
      company: input.company,
      title: input.title,
      url: input.url,
      term: input.term,
    };
    if (jobShort) {
      const [match, application] = await Promise.all([
        ctx.db
          .query("matches")
          .withIndex("by_user_short", (q) =>
            q.eq("user", user).eq("short", jobShort),
          )
          .first(),
        ctx.db
          .query("applications")
          .withIndex("by_user_short", (q) =>
            q.eq("user", user).eq("short", jobShort),
          )
          .first(),
      ]);
      const source = match?.item ?? application?.snapshot;
      if (source && typeof source === "object") {
        const string = (key: string) =>
          typeof source[key] === "string" ? (source[key] as string) : "";
        job = {
          company: string("company"),
          title: string("title"),
          url: string("url"),
          term: string("term"),
        };
      } else if (previous?.jobShort === jobShort) {
        job = previous;
      } else {
        throw new ConvexError(
          "This job is no longer available. Add it manually with its job details.",
        );
      }
    }
    const fields = {
      contactId: contact._id,
      jobShort,
      company: text(job.company, "Company", 200, true),
      title: text(job.title, "Job title", 500, true),
      url: url(job.url, "Job link"),
      term: text(job.term, "Term"),
      requisitionId: text(input.requisitionId, "Requisition ID"),
      status: input.status,
      ...followUp(input),
      updatedAt: Date.now(),
    };
    if (!previous?.archived) await ensureUniqueJob(ctx, fields, id);
    if (id) {
      await ctx.db.patch(id, fields);
      if (previous?.status !== fields.status)
        await addActivity(
          ctx,
          user,
          contact._id,
          fields.title + ": " + REFERRAL_STATUS[fields.status],
          id,
        );
      return id;
    }
    const newId = await ctx.db.insert("referrals", {
      ...fields,
      user,
      archived: false,
      createdAt: Date.now(),
    });
    await addActivity(
      ctx,
      user,
      contact._id,
      fields.title + ": " + REFERRAL_STATUS[fields.status],
      newId,
    );
    return newId;
  },
});

export const setStatus = mutation({
  args: {
    ...authFields,
    id: v.id("referrals"),
    status: referralStatusValidator,
  },
  handler: async (ctx, { user, secret, id, status }) => {
    authorize(user, secret);
    const referral = await referralFor(ctx, user, id);
    if (referral.status === status) return;
    await ctx.db.patch(id, { status, updatedAt: Date.now() });
    await addActivity(
      ctx,
      user,
      referral.contactId,
      referral.title + ": " + REFERRAL_STATUS[status],
      id,
    );
  },
});

export const setFollowUp = mutation({
  args: {
    ...authFields,
    contactId: v.optional(v.id("referralContacts")),
    referralId: v.optional(v.id("referrals")),
    ...followUpFields,
  },
  handler: async (ctx, { user, secret, contactId, referralId, ...input }) => {
    authorize(user, secret);
    if (!!contactId === !!referralId)
      throw new ConvexError("Choose one contact or referral.");
    const row = contactId
      ? await contactFor(ctx, user, contactId)
      : await referralFor(ctx, user, referralId!);
    await ctx.db.patch(row._id, { ...followUp(input), updatedAt: Date.now() });
  },
});

export const setArchived = mutation({
  args: {
    ...authFields,
    contactId: v.optional(v.id("referralContacts")),
    referralId: v.optional(v.id("referrals")),
    archived: v.boolean(),
  },
  handler: async (ctx, { user, secret, contactId, referralId, archived }) => {
    authorize(user, secret);
    if (!!contactId === !!referralId)
      throw new ConvexError("Choose one contact or referral.");
    const row = contactId
      ? await contactFor(ctx, user, contactId)
      : await referralFor(ctx, user, referralId!);
    if (!archived && "contactId" in row)
      await ensureUniqueJob(ctx, row, row._id);
    await ctx.db.patch(row._id, { archived, updatedAt: Date.now() });
  },
});

export const addNote = mutation({
  args: {
    ...authFields,
    contactId: v.id("referralContacts"),
    referralId: v.optional(v.id("referrals")),
    note: v.string(),
  },
  handler: async (ctx, { user, secret, contactId, referralId, note }) => {
    authorize(user, secret);
    await contactFor(ctx, user, contactId);
    if (
      referralId &&
      (await referralFor(ctx, user, referralId)).contactId !== contactId
    )
      throw new ConvexError("This referral belongs to a different contact.");
    await addActivity(
      ctx,
      user,
      contactId,
      text(note, "Note", 5000, true),
      referralId,
    );
  },
});
