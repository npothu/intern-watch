import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import * as resume from "./resume";
import { runProfileImport } from "./resume_node";
import type { Id } from "./_generated/dataModel";

// The resume-import claim/poll/apply flow, exercised against convex-test.
//
// Fake timers keep claimProfileImportUpload's scheduled runProfileImport from
// firing in the background (the convex-test scheduler rides on setTimeout);
// tests that want the mapping run invoke the action directly, the way the
// ingest tests invoke runIngest.

const SECRET = "test-tracker-secret";

beforeAll(() => {
  process.env.TRACKER_SECRET = SECRET;
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type T = ReturnType<typeof convexTest>;

async function storeText(t: T, text: string): Promise<Id<"_storage">> {
  return await t.run(async (ctx) =>
    ctx.storage.store(new Blob([text], { type: "text/plain" })),
  );
}

async function blobExists(t: T, id: Id<"_storage">): Promise<boolean> {
  return await t.run(async (ctx) => (await ctx.storage.get(id)) !== null);
}

async function claim(t: T, user: string, storageId: Id<"_storage">) {
  return await t.mutation(resume.claimProfileImportUpload, {
    user,
    storageId,
    filename: "resume.txt",
    contentType: "text/plain",
    secret: SECRET,
  });
}

// A minimal valid ProfileV2 the fake model returns, whose header fully covers
// the uploaded line "Alex Example" so the mapping validates cleanly.
const IMPORTED_PROFILE = {
  version: 2,
  header: { name: "Alex Example", contact_line: "alex@example.com" },
  skills: {},
  sections: [
    {
      id: "experience",
      title: "Experience",
      kind: "experience",
      entries: [
        {
          id: "example-co",
          heading: "Example Co",
          date: "Summer 2026",
          bullets: { base: ["Built a reliable import pipeline"] },
        },
      ],
    },
  ],
};

const VALID_MODEL_TEXT = JSON.stringify({
  profile: IMPORTED_PROFILE,
  mappings: [{ lineId: "line-0001", targetPaths: ["/header/name"] }],
});

function geminiResponse(text: string): Response {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

async function llmCountFor(t: T, user: string): Promise<number> {
  const row = await t.run(async (ctx) =>
    ctx.db.query("settings").withIndex("by_user", (q) => q.eq("user", user)).first(),
  );
  return row?.llmCount ?? 0;
}

describe("claim / discard: the pending-import record owns the storage id", () => {
  test("claim records the upload under the user and a re-claim deletes the abandoned blob", async () => {
    const t = convexTest(schema);
    const first = await storeText(t, "first upload");
    await claim(t, "alice", first);

    const rows = await t.run(async (ctx) => ctx.db.query("profileImports").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].user).toBe("alice");
    expect(rows[0].storageId).toBe(first);
    expect(rows[0].status).toBe("mapping");

    const second = await storeText(t, "second upload");
    await claim(t, "alice", second);

    const after = await t.run(async (ctx) => ctx.db.query("profileImports").collect());
    expect(after).toHaveLength(1);
    expect(after[0].storageId).toBe(second);
    // The abandoned first upload went with its claim.
    expect(await blobExists(t, first)).toBe(false);
    expect(await blobExists(t, second)).toBe(true);
  });

  test("another user's discard cannot reach my pending upload", async () => {
    const t = convexTest(schema);
    const blob = await storeText(t, "alice resume");
    await claim(t, "alice", blob);

    // Mallory has no way to name Alice's storage id: discard takes none.
    await t.mutation(resume.discardProfileImportUpload, {
      user: "mallory",
      secret: SECRET,
    });

    expect(await blobExists(t, blob)).toBe(true);
    const record = await t.query(resume.getPendingProfileImport, { user: "alice" });
    expect(record?.storageId).toBe(blob);
  });

  test("discard deletes exactly the caller's recorded blob and record", async () => {
    const t = convexTest(schema);
    const blob = await storeText(t, "alice resume");
    await claim(t, "alice", blob);

    await t.mutation(resume.discardProfileImportUpload, { user: "alice", secret: SECRET });

    expect(await blobExists(t, blob)).toBe(false);
    expect(await t.query(resume.getPendingProfileImport, { user: "alice" })).toBeNull();
  });

  test("a stale abandoned claim is swept (blob and row) on the next claim by anyone", async () => {
    const t = convexTest(schema);
    const abandoned = await storeText(t, "abandoned resume");
    await t.run(async (ctx) => {
      await ctx.db.insert("profileImports", {
        user: "ghost",
        storageId: abandoned,
        filename: "resume.txt",
        contentType: "text/plain",
        status: "mapping",
        // Older than IMPORT_STALE_MS (30 min).
        createdAt: Date.now() - 31 * 60_000,
      });
    });

    const fresh = await storeText(t, "fresh resume");
    await claim(t, "bob", fresh);

    expect(await blobExists(t, abandoned)).toBe(false);
    expect(await t.query(resume.getPendingProfileImport, { user: "ghost" })).toBeNull();
    // Bob's own fresh claim is untouched by the sweep.
    expect(await blobExists(t, fresh)).toBe(true);
  });

  test("finishProfileImport ignores an outcome for a superseded storage id", async () => {
    const t = convexTest(schema);
    const current = await storeText(t, "current upload");
    const superseded = await storeText(t, "superseded upload");
    await claim(t, "alice", current);

    await t.mutation(resume.finishProfileImport, {
      user: "alice",
      storageId: superseded,
      error: "stale mapping outcome",
    });

    const record = await t.query(resume.getPendingProfileImport, { user: "alice" });
    expect(record?.status).toBe("mapping");
    expect(record?.storageId).toBe(current);
    expect(await blobExists(t, current)).toBe(true);
  });

  test("getProfileImportStatus surfaces the ready preview written by finishProfileImport", async () => {
    const t = convexTest(schema);
    const blob = await storeText(t, "alice resume");
    await claim(t, "alice", blob);

    await t.mutation(resume.finishProfileImport, {
      user: "alice",
      storageId: blob,
      preview: JSON.stringify({ profile: IMPORTED_PROFILE }),
    });

    const status = await t.query(resume.getProfileImportStatus, {
      user: "alice",
      secret: SECRET,
    });
    expect(status?.status).toBe("ready");
    expect(JSON.parse(status!.preview!).profile.header.name).toBe("Alex Example");
    // The temporary blob dies the moment the mapping settles.
    expect(await blobExists(t, blob)).toBe(false);
  });
});

describe("runProfileImport: the mapping action reads only the caller's own record", () => {
  test("a user with no pending record maps nothing and touches nobody's blob", async () => {
    const t = convexTest(schema);
    const blob = await storeText(t, "alice resume");
    await claim(t, "alice", blob);
    vi.stubEnv("GEMINI_API_KEY", "operator-key");
    const fetchMock = vi.fn(async () => geminiResponse(VALID_MODEL_TEXT));
    vi.stubGlobal("fetch", fetchMock);

    // There is no argument through which mallory can name alice's storage id:
    // the action's only input is the user, and mallory's record is empty.
    await t.action(runProfileImport, { user: "mallory" });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await blobExists(t, blob)).toBe(true);
    const record = await t.query(resume.getPendingProfileImport, { user: "alice" });
    expect(record?.status).toBe("mapping");
  });

  test("a clean mapping charges the operator allowance once and lands a ready preview", async () => {
    const t = convexTest(schema);
    const blob = await storeText(t, "Alex Example");
    await claim(t, "alice", blob);
    vi.stubEnv("GEMINI_API_KEY", "operator-key");
    vi.stubGlobal("fetch", vi.fn(async () => geminiResponse(VALID_MODEL_TEXT)));

    await t.action(runProfileImport, { user: "alice" });

    const status = await t.query(resume.getProfileImportStatus, {
      user: "alice",
      secret: SECRET,
    });
    expect(status?.status).toBe("ready");
    expect(JSON.parse(status!.preview!).profile.header.name).toBe("Alex Example");
    expect(await blobExists(t, blob)).toBe(false);
    expect(await llmCountFor(t, "alice")).toBe(1);
  });

  test("a repaired mapping charges twice - both calls burned tokens", async () => {
    const t = convexTest(schema);
    const blob = await storeText(t, "Alex Example");
    await claim(t, "alice", blob);
    vi.stubEnv("GEMINI_API_KEY", "operator-key");
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(geminiResponse("not json"))
      .mockResolvedValueOnce(geminiResponse(VALID_MODEL_TEXT));
    vi.stubGlobal("fetch", fetchMock);

    await t.action(runProfileImport, { user: "alice" });

    const status = await t.query(resume.getProfileImportStatus, {
      user: "alice",
      secret: SECRET,
    });
    expect(status?.status).toBe("ready");
    expect(await llmCountFor(t, "alice")).toBe(2);
  });

  test("an import the model cannot map still charges both calls, fails the record, and frees the blob", async () => {
    const t = convexTest(schema);
    const blob = await storeText(t, "Alex Example");
    await claim(t, "alice", blob);
    vi.stubEnv("GEMINI_API_KEY", "operator-key");
    vi.stubGlobal("fetch", vi.fn(async () => geminiResponse("still not json")));

    await t.action(runProfileImport, { user: "alice" });

    const status = await t.query(resume.getProfileImportStatus, {
      user: "alice",
      secret: SECRET,
    });
    expect(status?.status).toBe("failed");
    expect(status?.error).toBeTruthy();
    // Before the fix this path charged ZERO while burning two model calls,
    // draining the shared quota invisibly on every retry.
    expect(await llmCountFor(t, "alice")).toBe(2);
    expect(await blobExists(t, blob)).toBe(false);
  });

  test("with no key configured the record fails with an actionable error and the blob is freed", async () => {
    const t = convexTest(schema);
    const blob = await storeText(t, "Alex Example");
    await claim(t, "alice", blob);
    // No GEMINI_API_KEY, no user key.

    await t.action(runProfileImport, { user: "alice" });

    const status = await t.query(resume.getProfileImportStatus, {
      user: "alice",
      secret: SECRET,
    });
    expect(status?.status).toBe("failed");
    expect(status?.error).toContain("Resume import needs semantic mapping");
    expect(await blobExists(t, blob)).toBe(false);
  });
});

describe("applyProfileImport: snapshot before overwrite", () => {
  test("replacing an existing profile parks it in profileBackups first", async () => {
    const t = convexTest(schema);
    const oldData = JSON.stringify({ version: 2, header: { name: "Old Me" } });
    await t.mutation(resume.putProfile, { user: "alice", data: oldData, secret: SECRET });

    const newData = JSON.stringify(IMPORTED_PROFILE);
    await t.mutation(resume.applyProfileImport, {
      user: "alice",
      data: newData,
      secret: SECRET,
    });

    const backups = await t.run(async (ctx) => ctx.db.query("profileBackups").collect());
    expect(backups).toHaveLength(1);
    expect(backups[0].user).toBe("alice");
    expect(backups[0].fromVersion).toBe(2);
    expect(backups[0].data).toBe(oldData);

    const profiles = await t.run(async (ctx) => ctx.db.query("profiles").collect());
    expect(profiles).toHaveLength(1);
    expect(profiles[0].data).toBe(newData);
  });

  test("an empty-looking stored profile is still snapshotted", async () => {
    const t = convexTest(schema);
    // The blank scaffold: "empty" is a client-side copy judgment, and the
    // backup is what makes getting it wrong recoverable.
    const blank = JSON.stringify({ version: 2, header: { name: "", contact_line: "" }, skills: {}, sections: [] });
    await t.mutation(resume.putProfile, { user: "alice", data: blank, secret: SECRET });

    await t.mutation(resume.applyProfileImport, {
      user: "alice",
      data: JSON.stringify(IMPORTED_PROFILE),
      secret: SECRET,
    });

    const backups = await t.run(async (ctx) => ctx.db.query("profileBackups").collect());
    expect(backups).toHaveLength(1);
    expect(backups[0].data).toBe(blank);
  });

  test("a first-ever profile inserts without a backup and consumes the pending record", async () => {
    const t = convexTest(schema);
    const blob = await storeText(t, "Alex Example");
    await claim(t, "alice", blob);
    await t.mutation(resume.finishProfileImport, {
      user: "alice",
      storageId: blob,
      preview: JSON.stringify({ profile: IMPORTED_PROFILE }),
    });

    await t.mutation(resume.applyProfileImport, {
      user: "alice",
      data: JSON.stringify(IMPORTED_PROFILE),
      secret: SECRET,
    });

    expect(await t.run(async (ctx) => ctx.db.query("profileBackups").collect())).toHaveLength(0);
    expect(await t.run(async (ctx) => ctx.db.query("profiles").collect())).toHaveLength(1);
    // Confirming consumed the ready import record.
    expect(await t.query(resume.getPendingProfileImport, { user: "alice" })).toBeNull();
  });

  test("invalid JSON is rejected before anything is written", async () => {
    const t = convexTest(schema);
    await expect(
      t.mutation(resume.applyProfileImport, {
        user: "alice",
        data: "{broken",
        secret: SECRET,
      }),
    ).rejects.toThrow("profile data must be valid JSON");
  });
});
