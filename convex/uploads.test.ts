import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TRACKER_SECRET", "upload-test-secret");
  vi.stubEnv("CONVEX_SITE_URL", "https://upload-test.convex.site");
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

test("upload capabilities are single-use and the stored file belongs only to their owner", async () => {
  const t = convexTest(schema);
  const url = new URL(await t.action(api.uploads.prepare, { user: "alice", secret: "upload-test-secret" }));
  const path = url.pathname + url.search;
  const response = await t.fetch(path, { method: "POST", body: "Synthetic resume", headers: { "Content-Type": "text/plain" } });
  expect(response.status).toBe(200);
  const { storageId } = await response.json();
  expect((await t.fetch(path, { method: "POST", body: "Replay" })).status).toBe(403);
  const claim = { storageId, filename: "resume.txt", contentType: "text/plain", secret: "upload-test-secret" };
  await expect(t.mutation(api.resume.claimProfileImportUpload, { ...claim, user: "bob" })).rejects.toThrow("not found");
  await t.mutation(api.resume.claimProfileImportUpload, { ...claim, user: "alice" });
  await expect(t.mutation(api.resume.claimProfileImportUpload, { ...claim, user: "alice" })).rejects.toThrow("not found");
  expect(await t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null)).toBe(true);
});

test("expired and oversized uploads are rejected without storing a blob", async () => {
  const t = convexTest(schema);
  const prepare = async () => {
    const u = new URL(await t.action(api.uploads.prepare, { user: "alice", secret: "upload-test-secret" }));
    return u.pathname + u.search;
  };
  const path = await prepare();
  expect((await t.fetch(path, { method: "POST", body: "x".repeat(5 * 1024 * 1024 + 1) })).status).toBe(413);
  const expired = await prepare();
  vi.setSystemTime(Date.now() + 31 * 60_000);
  expect((await t.fetch(expired, { method: "POST", body: "resume" })).status).toBe(403);
  expect(await t.run(async (ctx) => ctx.db.system.query("_storage").collect())).toEqual([]);
});
