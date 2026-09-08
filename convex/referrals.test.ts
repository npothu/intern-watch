import { beforeAll, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import type { ContactInput, ReferralInput } from "./referral_types";

const secret = "referrals-test-secret";
const auth = { user: "alice", secret };
const bob = { user: "bob", secret };
const contact: ContactInput = {
  name: " Maya Chen ",
  company: "Stripe",
  email: "maya@example.com",
  profileUrl: "https://example.com/maya",
  relationship: "Former teammate",
  availability: "can_refer",
  followUpOn: "2026-09-07",
  nextStep: "Send resume",
};
const job = (
  contactId: string,
  overrides: Partial<ReferralInput> = {},
): ReferralInput => ({
  contactId,
  jobShort: "",
  company: "Stripe",
  title: "Software Engineer Intern",
  url: "https://example.com/jobs/1",
  term: "Summer 2027",
  requisitionId: "",
  status: "requested",
  followUpOn: "2026-09-10",
  nextStep: "Check submission",
  ...overrides,
});
beforeAll(() => {
  process.env.TRACKER_SECRET = secret;
});

describe("referrals", () => {
  test("logs a contact before choosing a role, edits it, then saves multiple referrals and notes", async () => {
    const t = convexTest(schema);
    expect(await t.query(api.referrals.getOverview, auth)).toEqual({
      contacts: [],
      referrals: [],
      notes: [],
    });
    const id = await t.mutation(api.referrals.saveContact, {
      ...auth,
      input: contact,
      initialNote: "Offered to refer me.",
    });
    let data = await t.query(api.referrals.getOverview, auth);
    expect(data.contacts[0]).toMatchObject({
      id,
      name: "Maya Chen",
      availability: "can_refer",
      archived: false,
    });
    expect(data.contacts[0]).not.toHaveProperty("user");
    expect(data.notes[0].text).toBe("Offered to refer me.");
    await t.mutation(api.referrals.saveContact, {
      ...auth,
      id,
      input: { ...contact, email: "new@example.com", followUpOn: "" },
    });
    const first = await t.mutation(api.referrals.saveReferral, {
      ...auth,
      input: job(id),
    });
    await t.mutation(api.referrals.saveReferral, {
      ...auth,
      input: job(id, {
        title: "Data Science Intern",
        url: "https://example.com/jobs/2",
      }),
    });
    await t.mutation(api.referrals.addNote, {
      ...auth,
      contactId: id,
      referralId: first,
      note: " Sent my resume. ",
    });
    data = await t.query(api.referrals.getOverview, auth);
    expect(data.contacts[0]).toMatchObject({
      email: "new@example.com",
      followUpOn: "",
    });
    expect(data.referrals).toHaveLength(2);
    expect(
      data.notes.some(
        (n: { text: string; referralId: string }) =>
          n.text === "Sent my resume." && n.referralId === first,
      ),
    ).toBe(true);
  });

  test("snapshots linked jobs from the owning account and keeps them when Matches is pruned", async () => {
    const t = convexTest(schema);
    const id = await t.mutation(api.referrals.saveContact, {
      ...auth,
      input: contact,
    });
    const matchId = await t.run((ctx) =>
      ctx.db.insert("matches", {
        user: auth.user,
        short: "123456abcdef",
        item: {
          company: "Stripe",
          title: "Real job",
          url: "https://example.com/real",
          term: "Fall 2027",
        },
        pushedAt: Date.now(),
      }),
    );
    const referralId = await t.mutation(api.referrals.saveReferral, {
      ...auth,
      input: job(id, {
        jobShort: "123456abcdef",
        title: "Client-supplied spoof",
      }),
    });
    await t.run((ctx) => ctx.db.delete(matchId));
    await t.mutation(api.referrals.saveReferral, {
      ...auth,
      id: referralId,
      input: job(id, {
        jobShort: "123456abcdef",
        title: "Another spoof",
        status: "submitted",
      }),
    });
    const data = await t.query(api.referrals.getOverview, auth);
    expect(data.referrals[0]).toMatchObject({
      title: "Real job",
      url: "https://example.com/real",
      term: "Fall 2027",
      status: "submitted",
    });
    expect(
      await t.run((ctx) => ctx.db.query("applications").collect()),
    ).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("ticks").collect())).toEqual([]);
  });

  test("can link a Tracker-only snapshot and changing referral status preserves application status", async () => {
    const t = convexTest(schema);
    const id = await t.mutation(api.referrals.saveContact, {
      ...auth,
      input: contact,
    });
    const appId = await t.run((ctx) =>
      ctx.db.insert("applications", {
        user: auth.user,
        short: "abcdef123456",
        status: "interview",
        history: [{ status: "interview", at: "2026-09-01" }],
        createdAt: "2026-08-01",
        snapshot: {
          company: "Stripe",
          title: "Archived posting",
          url: "https://example.com/old",
        },
      }),
    );
    const rid = await t.mutation(api.referrals.saveReferral, {
      ...auth,
      input: job(id, { jobShort: "abcdef123456" }),
    });
    await t.mutation(api.referrals.setStatus, {
      ...auth,
      id: rid,
      status: "submitted",
    });
    await t.mutation(api.referrals.setStatus, {
      ...auth,
      id: rid,
      status: "submitted",
    });
    const data = await t.query(api.referrals.getOverview, auth);
    expect(data.referrals[0]).toMatchObject({
      title: "Archived posting",
      status: "submitted",
    });
    expect(
      data.notes.filter((n: { text: string }) => n.text.includes("Submitted")),
    ).toHaveLength(1);
    expect((await t.run((ctx) => ctx.db.get(appId)))?.status).toBe("interview");
  });

  test("rejects unauthorized reads and cross-user reads or writes by ID", async () => {
    const t = convexTest(schema);
    const id = await t.mutation(api.referrals.saveContact, {
      ...auth,
      input: contact,
    });
    const rid = await t.mutation(api.referrals.saveReferral, {
      ...auth,
      input: job(id),
    });
    expect(await t.query(api.referrals.getOverview, bob)).toEqual({
      contacts: [],
      referrals: [],
      notes: [],
    });
    await expect(
      t.query(api.referrals.getOverview, { ...auth, secret: "wrong" }),
    ).rejects.toThrow(/bad secret/);
    await expect(
      t.mutation(api.referrals.saveContact, {
        ...auth,
        secret: "wrong",
        input: contact,
      }),
    ).rejects.toThrow(/bad secret/);
    await expect(
      t.mutation(api.referrals.saveContact, { ...bob, id, input: contact }),
    ).rejects.toThrow(/Contact not found/);
    await expect(
      t.mutation(api.referrals.saveReferral, { ...bob, input: job(id) }),
    ).rejects.toThrow(/Contact not found/);
    await expect(
      t.mutation(api.referrals.saveReferral, {
        ...bob,
        id: rid,
        input: job(id),
      }),
    ).rejects.toThrow(/Referral not found/);
    await expect(
      t.mutation(api.referrals.setStatus, {
        ...bob,
        id: rid,
        status: "submitted",
      }),
    ).rejects.toThrow(/Referral not found/);
    await expect(
      t.mutation(api.referrals.setFollowUp, {
        ...bob,
        contactId: id,
        followUpOn: "",
        nextStep: "",
      }),
    ).rejects.toThrow(/Contact not found/);
    await expect(
      t.mutation(api.referrals.setArchived, {
        ...bob,
        referralId: rid,
        archived: true,
      }),
    ).rejects.toThrow(/Referral not found/);
    await expect(
      t.mutation(api.referrals.addNote, {
        ...bob,
        contactId: id,
        note: "injected",
      }),
    ).rejects.toThrow(/Contact not found/);
    const otherId = await t.mutation(api.referrals.saveContact, {
      ...auth,
      input: { ...contact, name: "Another contact" },
    });
    await expect(
      t.mutation(api.referrals.addNote, {
        ...auth,
        contactId: otherId,
        referralId: rid,
        note: "wrong contact",
      }),
    ).rejects.toThrow(/different contact/);
  });

  test("rejects a linked job that exists only for another user", async () => {
    const t = convexTest(schema);
    const id = await t.mutation(api.referrals.saveContact, {
      ...auth,
      input: contact,
    });
    await t.run((ctx) =>
      ctx.db.insert("matches", {
        user: bob.user,
        short: "111111111111",
        item: { company: "Private company", title: "Private job" },
        pushedAt: Date.now(),
      }),
    );
    await expect(
      t.mutation(api.referrals.saveReferral, {
        ...auth,
        input: job(id, { jobShort: "111111111111" }),
      }),
    ).rejects.toThrow(/no longer available/);
  });

  test("guards duplicate requests while allowing different people at the same company", async () => {
    const t = convexTest(schema);
    const id = await t.mutation(api.referrals.saveContact, {
      ...auth,
      input: contact,
    });
    const rid = await t.mutation(api.referrals.saveReferral, {
      ...auth,
      input: job(id),
    });
    await expect(
      t.mutation(api.referrals.saveReferral, { ...auth, input: job(id) }),
    ).rejects.toThrow(/already has a referral/);
    await t.mutation(api.referrals.saveReferral, {
      ...auth,
      id: rid,
      input: job(id, { nextStep: "Follow up tomorrow" }),
    });
    const another = await t.mutation(api.referrals.saveContact, {
      ...auth,
      input: { ...contact, name: "Sam Lee" },
    });
    await t.mutation(api.referrals.saveReferral, {
      ...auth,
      input: job(another),
    });
    expect(
      (await t.query(api.referrals.getOverview, auth)).referrals,
    ).toHaveLength(2);
  });

  test("archives and restores without losing job history; follow-ups are independent", async () => {
    const t = convexTest(schema);
    const id = await t.mutation(api.referrals.saveContact, {
      ...auth,
      input: contact,
    });
    const rid = await t.mutation(api.referrals.saveReferral, {
      ...auth,
      input: job(id),
    });
    await t.mutation(api.referrals.setFollowUp, {
      ...auth,
      referralId: rid,
      followUpOn: "",
      nextStep: "",
    });
    expect(
      (await t.query(api.referrals.getOverview, auth)).contacts[0].followUpOn,
    ).toBe("2026-09-07");
    await t.mutation(api.referrals.setArchived, {
      ...auth,
      contactId: id,
      archived: true,
    });
    await expect(
      t.mutation(api.referrals.saveReferral, {
        ...auth,
        input: job(id, { url: "https://example.com/new" }),
      }),
    ).rejects.toThrow(/Restore this contact/);
    await t.mutation(api.referrals.setArchived, {
      ...auth,
      referralId: rid,
      archived: true,
    });
    let data = await t.query(api.referrals.getOverview, auth);
    expect(data.contacts[0].archived).toBe(true);
    expect(data.referrals[0]).toMatchObject({
      archived: true,
      followUpOn: "",
      nextStep: "",
    });
    expect(data.notes).toHaveLength(1);
    await t.mutation(api.referrals.setArchived, {
      ...auth,
      contactId: id,
      archived: false,
    });
    await t.mutation(api.referrals.setArchived, {
      ...auth,
      referralId: rid,
      archived: false,
    });
    data = await t.query(api.referrals.getOverview, auth);
    expect(data.contacts[0].archived).toBe(false);
    expect(data.referrals[0].archived).toBe(false);
  });

  test("restoring an archived request cannot create an active duplicate", async () => {
    const t = convexTest(schema);
    const contactId = await t.mutation(api.referrals.saveContact, {
      ...auth,
      input: contact,
    });
    const id = await t.mutation(api.referrals.saveReferral, {
      ...auth,
      input: job(contactId),
    });
    await t.mutation(api.referrals.setArchived, {
      ...auth,
      referralId: id,
      archived: true,
    });
    await t.mutation(api.referrals.saveReferral, {
      ...auth,
      input: job(contactId),
    });
    await expect(
      t.mutation(api.referrals.setArchived, {
        ...auth,
        referralId: id,
        archived: false,
      }),
    ).rejects.toThrow(/already has a referral/);
    const data = await t.query(api.referrals.getOverview, auth);
    expect(
      data.referrals.filter((r: { archived: boolean }) => !r.archived),
    ).toHaveLength(1);
  });

  test("validates empty names, impossible dates, unsafe URLs, notes and record targets", async () => {
    const t = convexTest(schema);
    for (const change of [
      { name: " " },
      { company: " " },
      { followUpOn: "2026-02-30" },
      { profileUrl: "javascript:alert(1)" },
      { email: "not-an-email" },
    ]) {
      await expect(
        t.mutation(api.referrals.saveContact, {
          ...auth,
          input: { ...contact, ...change },
        }),
      ).rejects.toThrow();
    }
    const id = await t.mutation(api.referrals.saveContact, {
      ...auth,
      input: contact,
    });
    await expect(
      t.mutation(api.referrals.saveReferral, {
        ...auth,
        input: job(id, { url: "data:text/html,test" }),
      }),
    ).rejects.toThrow(/http or https/);
    await expect(
      t.mutation(api.referrals.addNote, { ...auth, contactId: id, note: " " }),
    ).rejects.toThrow(/required/);
    await expect(
      t.mutation(api.referrals.addNote, {
        ...auth,
        contactId: id,
        note: "x".repeat(5001),
      }),
    ).rejects.toThrow(/too long/);
    await expect(
      t.mutation(api.referrals.setFollowUp, {
        ...auth,
        contactId: id,
        followUpOn: "2026-13-01",
        nextStep: "",
      }),
    ).rejects.toThrow(/valid follow-up/);
    await expect(
      t.mutation(api.referrals.setArchived, { ...auth, archived: true }),
    ).rejects.toThrow(/Choose one/);
    expect((await t.query(api.referrals.getOverview, auth)).notes).toHaveLength(
      0,
    );
  });
});
