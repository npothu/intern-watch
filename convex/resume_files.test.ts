import { beforeAll, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";

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
