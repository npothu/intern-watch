import { beforeAll, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";

beforeAll(() => { process.env.TRACKER_SECRET = "file-test-secret"; });

test("file downloads require server authorization and look up the requesting owner's row", async () => {
  const t = convexTest(schema);
  const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob(["Synthetic PDF"] )));
  await t.mutation(api.tracker.attachResume, { user: "alice", short: "0123456789ab", filename: "resume.docx", storageId, secret: "file-test-secret" });
  const path = "/resume/file?short=0123456789ab&slot=current&user=";
  expect((await t.fetch(path + "alice")).status).toBe(401);
  const headers = { Authorization: "Bearer file-test-secret" };
  expect((await t.fetch(path + "bob", { headers })).status).toBe(404);
  const response = await t.fetch(path + "alice", { headers });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("Synthetic PDF");
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(response.headers.get("Location")).toBeNull();
});

test("rotating legacy bearer links preserves shared file bytes and invalidates old IDs", async () => {
  const t = convexTest(schema);
  const storageId = await t.run(ctx => ctx.storage.store(new Blob(["Private synthetic resume"])));
  for (const short of ["0123456789ab", "abcdef012345"]) {
    await t.mutation(api.tracker.attachResume, { user: "alice", short, filename: "resume.docx", storageId, secret: "file-test-secret" });
  }
  expect(await t.action(internal.resume_files.rotateLegacyLinks, {})).toEqual({ rotated: 2, remaining: false });
  expect(await t.run(async ctx => (await ctx.storage.get(storageId)) !== null)).toBe(false);
  const rows = await t.run(ctx => ctx.db.query("resumes").collect());
  for (const row of rows) {
    expect(await t.run(async ctx => (await ctx.storage.get(row.storageId))?.text())).toBe("Private synthetic resume");
  }
  expect(await t.action(internal.resume_files.rotateLegacyLinks, {})).toEqual({ rotated: 0, remaining: false });
});
