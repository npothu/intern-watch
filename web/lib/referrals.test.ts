import { buildReferralJobs } from "./referral-jobs";
import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import {
  followUpDue,
  followUpLabel,
  validFollowUpDate,
  safeReferralUrl,
} from "./referrals";

const modules = import.meta.glob("../../convex/**/*.ts");

describe("referral job picker and calendar dates", () => {
  test("reflects an Applied untick immediately even while the watcher snapshot is stale", async () => {
    const auth = { user: "alice", secret: "referral-picker-test" };
    process.env.TRACKER_SECRET = auth.secret;
    const backend = convexTest(schema, modules);
    await backend.mutation(api.tracker.pushMatches, {
      ...auth,
      items: [{
        key: "job", short: "123456abcdef", company: "Stripe", title: "Intern",
        url: "https://example.com", term: "Summer 2027", applied: true,
        location: "", added: "", tag: "", salary: "",
      }],
    });
    for (const value of [true, false]) {
      await backend.mutation(api.tracker.setTicks, {
        ...auth, writes: [{ short: "123456abcdef", field: "applied", value }],
      });
      const matches = await backend.query(api.tracker.getMatches, auth);
      const ledger = await backend.query(api.tracker.getLedger, auth);
      expect(matches[0].applied).toBe(true);
      expect(buildReferralJobs(matches, ledger)[0]).toMatchObject({
        applicationStatus: value ? "applied" : "", inMatches: true,
      });
    }
  });
  test("keeps Tracker-only jobs and merges live matches by short key", () => {
    const jobs = buildReferralJobs(
      [
        {
          key: "job",
          short: "123456abcdef",
          company: "Stripe",
          title: "Intern",
          url: "https://example.com",
          term: "Summer 2027",
          location: "",
          added: "",
          tag: "",
          salary: "",
        },
      ],
      {
        "123456abcdef": {
          status: "interview",
          snapshot: {
            company: "Stripe",
            title: "Intern",
            url: "https://example.com",
          },
        },
        abcdef123456: {
          status: "applied",
          snapshot: {
            company: "Microsoft",
            title: "Old posting",
            url: "https://example.com/old",
            term: "Summer 2027",
          },
        },
      },
    );
    expect(jobs).toHaveLength(2);
    expect(jobs.find((j) => j.short === "123456abcdef")).toMatchObject({
      applicationStatus: "interview",
      inMatches: true,
      term: "Summer 2027",
    });
    expect(jobs.find((j) => j.short === "abcdef123456")).toMatchObject({
      title: "Old posting",
      applicationStatus: "applied",
      inMatches: false,
      term: "Summer 2027",
    });
  });
  test("retains the term in the Convex array-shaped ledger after a match is pruned", () => {
    expect(buildReferralJobs([], [{
      short: "abcdef123456", status: "applied",
      snapshot: { company: "Microsoft", title: "Intern", term: "Summer 2027" },
    }])[0]).toMatchObject({ term: "Summer 2027", inMatches: false });
  });
  test("treats a date as due for the whole local day and supports leap days", () => {
    expect(
      followUpDue({ followUpOn: "2026-09-07", nextStep: "" }, "2026-09-07"),
    ).toBe(true);
    expect(followUpDue({ followUpOn: "", nextStep: "" }, "2026-09-07")).toBe(
      false,
    );
    expect(followUpLabel("2026-09-06", "2026-09-07")).toBe("Overdue · Sep 6");
    expect(validFollowUpDate("2028-02-29")).toBe(true);
    expect(validFollowUpDate("2026-02-29")).toBe(false);
    expect(validFollowUpDate("2026-09-07T00:00:00Z")).toBe(false);
  });
  test("only renders safe external links", () => {
    expect(safeReferralUrl("javascript:alert(1)")).toBe("");
    expect(safeReferralUrl("https://user:password@example.com")).toBe("");
    expect(safeReferralUrl("https://example.com/jobs")).toBe(
      "https://example.com/jobs",
    );
  });
});
