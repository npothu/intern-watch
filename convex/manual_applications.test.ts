import { beforeAll, expect, test } from "vitest";
import { convexTest } from "convex-test";

import { api } from "./_generated/api";
import schema from "./schema";
import { canonicalUrl, postingIdentity } from "./ingest_extract";
import { dedupInfoForUrl, sha1HexSync } from "./short_key";

const SECRET = "test-tracker-secret";

beforeAll(() => {
  process.env.TRACKER_SECRET = SECRET;
});

test("a company-only manual application becomes a permanent ledger row", async () => {
  const t = convexTest(schema);

  const result = await t.mutation(api.tracker.createManualApplication, {
    user: "u1",
    requestId: "108fc1c1-84e7-4b9e-9ba5-493e88bc1178",
    draft: { company: "  Acme  " },
    secret: SECRET,
  });

  expect(result).toMatchObject({ created: true, status: "applied" });
  expect(result.short).toMatch(/^[0-9a-f]{12}$/);

  const row = await t.run(async (ctx) =>
    ctx.db
      .query("applications")
      .withIndex("by_user_short", (q) =>
        q.eq("user", "u1").eq("short", result.short),
      )
      .unique(),
  );
  expect(row).toMatchObject({
    user: "u1",
    short: result.short,
    status: "applied",
    snapshot: {
      source: "manual-application",
      company: "Acme",
    },
  });
  expect(row?.history).toHaveLength(1);
  expect(row?.history[0]).toMatchObject({ status: "applied" });
  expect(await t.run(async (ctx) => ctx.db.query("matches").collect())).toEqual([]);
  expect(await t.run(async (ctx) => ctx.db.query("ticks").collect())).toEqual([]);
});

test("manual creation keeps optional details and an honest status timeline", async () => {
  const t = convexTest(schema);
  const result = await t.mutation(api.tracker.createManualApplication, {
    user: "u1",
    requestId: "c2c3a9b9-6603-4ca8-adc4-4c356f25900c",
    draft: {
      company: "Acme",
      title: "Software Engineering Intern",
      location: "Austin, TX",
      url: "https://example.com/jobs/123",
      note: "Referred by Sam",
      status: "interview",
      appliedDate: "2026-09-01",
    },
    secret: SECRET,
  });
  const row = await t.run(async (ctx) =>
    ctx.db
      .query("applications")
      .withIndex("by_user_short", (q) =>
        q.eq("user", "u1").eq("short", result.short),
      )
      .unique(),
  );

  expect(row?.snapshot).toMatchObject({
    company: "Acme",
    title: "Software Engineering Intern",
    location: "Austin, TX",
    url: "https://example.com/jobs/123",
    added: "2026-09-01",
  });
  expect(row?.history).toHaveLength(2);
  expect(row?.history[0]).toMatchObject({
    status: "applied",
    at: "2026-09-01T12:00:00.000Z",
  });
  expect(row?.history[1]).toMatchObject({
    status: "interview",
    note: "Referred by Sam",
  });
  expect(row?.createdAt).not.toBe("2026-09-01T12:00:00.000Z");
});

test("manual creation is idempotent and conflicting retries do not mutate history", async () => {
  const t = convexTest(schema);
  const args = {
    user: "u1",
    requestId: "1430af42-ef19-471d-a1b4-17dce7ca8c87",
    draft: { company: "Acme", title: "SWE Intern" },
    secret: SECRET,
  };

  const first = await t.mutation(api.tracker.createManualApplication, args);
  const retry = await t.mutation(api.tracker.createManualApplication, args);
  expect(retry).toEqual({ ...first, created: false });

  await expect(
    t.mutation(api.tracker.createManualApplication, {
      ...args,
      draft: { company: "Different company" },
    }),
  ).rejects.toThrow("request id already used with different application details");

  const rows = await t.run(async (ctx) => ctx.db.query("applications").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0].history).toHaveLength(1);
});

test("changing a URL-backed draft cannot move the same request to a new key", async () => {
  const t = convexTest(schema);
  const requestId = "f063699f-febd-4a81-b5a7-ac3b5a014716";
  await t.mutation(api.tracker.createManualApplication, {
    user: "u1",
    requestId,
    draft: { company: "Acme", url: "https://example.com/jobs/one" },
    secret: SECRET,
  });

  await expect(
    t.mutation(api.tracker.createManualApplication, {
      user: "u1",
      requestId,
      draft: { company: "Acme", url: "https://example.com/jobs/two" },
      secret: SECRET,
    }),
  ).rejects.toThrow("request id already used with different application details");
  expect(await t.run(async (ctx) => ctx.db.query("applications").collect()))
    .toHaveLength(1);
});

test("a supplied job link reuses the watcher-compatible match identity", async () => {
  const t = convexTest(schema);
  const url = "https://jobs.ashbyhq.com/acme/67fadb77-43d8-4436-b66e-e0804447f7a0";
  const key = postingIdentity(url)!;
  const identity = { dedupKey: key, short: sha1HexSync(key).slice(0, 12) };
  await t.run(async (ctx) => {
    await ctx.db.insert("matches", {
      user: "u1",
      short: identity.short,
      item: { key: identity.dedupKey, company: "Acme", title: "SWE Intern", url },
      pushedAt: Date.now(),
    });
  });

  const result = await t.mutation(api.tracker.createManualApplication, {
    user: "u1",
    requestId: "2ccbc6a1-34c2-41a6-9a67-dd16d77fe831",
    draft: { company: "Acme", title: "SWE Intern", url },
    secret: SECRET,
  });

  expect(result.short).toBe(identity.short);
  const applications = await t.run(async (ctx) => ctx.db.query("applications").collect());
  expect(applications).toHaveLength(1);
  expect(applications[0].snapshot).toMatchObject({ key: identity.dedupKey, url });
});

test("unlinking an applied match cannot remove a linked manual application", async () => {
  const t = convexTest(schema);
  const url = "https://jobs.ashbyhq.com/acme/37fadb77-43d8-4436-b66e-e0804447f7a0";
  const key = postingIdentity(url)!;
  const short = sha1HexSync(key).slice(0, 12);
  await t.run(async (ctx) => {
    await ctx.db.insert("matches", {
      user: "u1",
      short,
      item: { key, company: "Acme", title: "SWE Intern", url },
      pushedAt: Date.now(),
    });
  });
  await t.mutation(api.tracker.createManualApplication, {
    user: "u1",
    requestId: "9a6f8f32-847b-4f78-b02b-6c7dc0376e3c",
    draft: { company: "Acme", title: "SWE Intern", url },
    secret: SECRET,
  });

  await t.mutation(api.tracker.setTicks, {
    user: "u1",
    writes: [{ short, field: "applied", value: true }],
    secret: SECRET,
  });
  await t.mutation(api.tracker.setTicks, {
    user: "u1",
    writes: [{ short, field: "applied", value: false }],
    secret: SECRET,
  });

  expect(await t.run(async (ctx) => ctx.db.query("applications").collect()))
    .toHaveLength(1);
});

test("a job link keeps the identity a later URL ingest will derive", async () => {
  const t = convexTest(schema);
  const url = "https://job-boards.greenhouse.io/acme/jobs/1234567";
  const postingKey = postingIdentity(url);
  const identity = postingKey
    ? { dedupKey: postingKey, short: sha1HexSync(postingKey).slice(0, 12) }
    : dedupInfoForUrl(canonicalUrl(url), url);

  const result = await t.mutation(api.tracker.createManualApplication, {
    user: "u1",
    requestId: "08ab7f87-e9f5-4768-8825-d19f672725c9",
    draft: { company: "Example", url },
    secret: SECRET,
  });

  expect(result.short).toBe(identity.short);
});

test("a Jobright id outranks the employer ATS identity", async () => {
  const t = convexTest(schema);
  const jobrightId = "6a75372837da8525e8cdcbb9";
  const url = `https://jobs.ashbyhq.com/acme/67fadb77-43d8-4436-b66e-e0804447f7a0?jr_id=${jobrightId}`;
  const key = `jr:${jobrightId}`;

  const result = await t.mutation(api.tracker.createManualApplication, {
    user: "u1",
    requestId: "cd095e00-4753-4819-8034-881e70402752",
    draft: { company: "Acme", url },
    secret: SECRET,
  });

  expect(result.short).toBe(sha1HexSync(key).slice(0, 12));
  expect((await t.run(async (ctx) => ctx.db.query("applications").first()))?.snapshot)
    .toMatchObject({ key });
});

test("direct and employer Jobright URLs cannot create duplicate applications", async () => {
  const t = convexTest(schema);
  const jobrightId = "7b75372837da8525e8cdcbb8";
  await t.mutation(api.tracker.createManualApplication, {
    user: "u1",
    requestId: "5260a10e-65aa-49c1-b393-10b82d20947f",
    draft: {
      company: "Acme",
      url: `https://jobright.ai/jobs/info/${jobrightId}`,
    },
    secret: SECRET,
  });

  await expect(
    t.mutation(api.tracker.createManualApplication, {
      user: "u1",
      requestId: "3aa54511-62f6-4919-ad52-2abc5d7b7e51",
      draft: {
        company: "Acme",
        url: `https://jobs.ashbyhq.com/acme/67fadb77-43d8-4436-b66e-e0804447f7a0?jr_id=${jobrightId}`,
      },
      secret: SECRET,
    }),
  ).rejects.toThrow("an application with this job link already exists");
  expect(await t.run(async (ctx) => ctx.db.query("applications").collect()))
    .toHaveLength(1);
});

test("a company-only key collision probes past matches in the shared namespace", async () => {
  const t = convexTest(schema);
  const requestId = "05acd255-f1ed-46c1-8282-811375933418";
  const collision = sha1HexSync(`manual-application:${requestId}`).slice(0, 12);
  await t.run(async (ctx) => {
    await ctx.db.insert("matches", {
      user: "u1",
      short: collision,
      item: { key: "different-job", company: "Existing Co", title: "Other role" },
      pushedAt: Date.now(),
    });
  });

  const result = await t.mutation(api.tracker.createManualApplication, {
    user: "u1",
    requestId,
    draft: { company: "Acme" },
    secret: SECRET,
  });

  expect(result.short).not.toBe(collision);
  expect(await t.run(async (ctx) => ctx.db.query("applications").collect()))
    .toHaveLength(1);
});

test("a company-only key collision cannot inherit an unrelated resume", async () => {
  const t = convexTest(schema);
  const requestId = "660f56d5-8af5-4829-951b-d9cad925a5cc";
  const collision = sha1HexSync(`manual-application:${requestId}`).slice(0, 12);
  await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob(["resume"]));
    await ctx.db.insert("resumes", {
      user: "u1",
      short: collision,
      filename: "other.pdf",
      storageId,
      updatedAt: Date.now(),
    });
  });

  const result = await t.mutation(api.tracker.createManualApplication, {
    user: "u1",
    requestId,
    draft: { company: "Acme" },
    secret: SECRET,
  });

  expect(result.short).not.toBe(collision);
});

test.each([
  [{ company: "   " }, "company is required"],
  [{ company: "Acme", url: "javascript:alert(1)" }, "job link must start with http"],
  [{ company: "Acme", appliedDate: "2026-02-30" }, "valid date"],
  [{ company: "Acme", status: "ghosted" }, "invalid status"],
])("manual creation rejects invalid input without writing", async (draft, message) => {
  const t = convexTest(schema);
  await expect(
    t.mutation(api.tracker.createManualApplication, {
      user: "u1",
      requestId: "af75d050-2c3e-46d1-a231-bb175c25ea52",
      draft,
      secret: SECRET,
    }),
  ).rejects.toThrow(message);
  expect(await t.run(async (ctx) => ctx.db.query("applications").collect())).toEqual([]);
});
