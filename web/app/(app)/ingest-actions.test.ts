import { beforeEach, expect, test, vi } from "vitest";
import { resolveTrackerUser } from "@/lib/user";
import { getIngestStatus, requestIngest } from "@/lib/convex";
import { addJobUrl, getIngestStatusAction } from "./ingest-actions";

// The Add URL dialog's server actions follow the API rule (lib/ingest-short):
// no short until a match backs it.

vi.mock("@/lib/user", () => ({ resolveTrackerUser: vi.fn() }));
vi.mock("@/lib/convex", () => ({ requestIngest: vi.fn(), getIngestStatus: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveTrackerUser).mockResolvedValue("alice");
});

const row = (status: string) => ({
  _id: "ing1", user: "alice", short: "0123456789ab", url: "https://example.com/jobs/1",
  status, createdAt: 1, updatedAt: 1,
});

test("addJobUrl hands out a short only for a job already in matches", async () => {
  vi.mocked(requestIngest).mockResolvedValue({ ingestId: "ing1", status: "fetching", short: "0123456789ab" });
  expect(await addJobUrl("https://example.com/jobs/1")).toEqual({ ok: true, ingestId: "ing1", status: "fetching" });
  vi.mocked(requestIngest).mockResolvedValue({ ingestId: "ing1", status: "in_progress", short: "0123456789ab" });
  expect(await addJobUrl("https://example.com/jobs/1")).toEqual({ ok: true, ingestId: "ing1", status: "in_progress" });
  vi.mocked(requestIngest).mockResolvedValue({ ingestId: "ing2", status: "already_exists", short: "0123456789ab" });
  expect(await addJobUrl("https://example.com/jobs/1"))
    .toEqual({ ok: true, ingestId: "ing2", status: "already_exists", short: "0123456789ab" });
});

test("a polled ingest carries its short only once done", async () => {
  for (const status of ["fetching", "extracting", "failed"]) {
    vi.mocked(getIngestStatus).mockResolvedValue(row(status));
    const got = await getIngestStatusAction("ing1");
    expect(got).toMatchObject({ status });
    expect(got).not.toHaveProperty("short");
  }
  vi.mocked(getIngestStatus).mockResolvedValue(row("done"));
  expect(await getIngestStatusAction("ing1")).toMatchObject({ status: "done", short: "0123456789ab" });
});
