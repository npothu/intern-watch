import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api, internal } from "./_generated/api";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("TRACKER_SECRET", "disconnect-test");
  vi.stubEnv("MAIL_PUBSUB_TOPIC", "");
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

const connection = { user: "alice", email: "alice@gmail.com", refreshToken: "synthetic-ciphertext", refreshTokenIv: "synthetic-iv" };

test("one mailbox cannot be claimed by a second user", async () => {
  const t = convexTest(schema);
  await t.mutation(internal.mail.storeMailAccount, connection);
  await expect(t.mutation(internal.mail.storeMailAccount, { ...connection, user: "bob", email: " Alice@gmail.com " })).rejects.toThrow("already connected");
  expect(await t.query(internal.mail.getAccount, { user: "bob" })).toBeNull();
});

test("disconnect invalidates in-flight writes and cannot affect another user", async () => {
  const t = convexTest(schema);
  await t.mutation(internal.mail.storeMailAccount, connection);
  const old = (await t.query(internal.mail.getAccount, { user: "alice" }))!;
  await t.mutation(api.mail.disconnect, { user: "bob", secret: "disconnect-test" });
  expect(await t.query(internal.mail.getAccount, { user: "alice" })).not.toBeNull();
  await t.mutation(api.mail.disconnect, { user: "alice", secret: "disconnect-test" });
  await t.mutation(internal.mail.storeMailAccount, connection);
  await t.mutation(internal.mail.recordOutcome, {
    accountId: old._id, user: "alice", gmailMessageId: "late", threadId: "late",
    accountEmail: connection.email,
    headers: { from: "", subject: "", date: "", messageId: "" },
  });
  await t.mutation(internal.mail.stampError, { rowId: old._id, message: "late error" });
  expect(await t.run(ctx => ctx.db.query("mailMessages").collect())).toHaveLength(0);
  expect((await t.query(internal.mail.getAccount, { user: "alice" }))?.lastError).toBeUndefined();
});
