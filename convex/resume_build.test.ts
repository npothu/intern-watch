// @vitest-environment node

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { PDFDocument } from "pdf-lib";
import schema from "./schema";
import * as resume from "./resume";
import * as tracker from "./tracker";
import { runBuild } from "./resume_node";
import type { ProfileV2 } from "./profile_schema";

const SECRET = "test-tracker-secret";

const PROFILE: ProfileV2 = {
  version: 2,
  header: {
    name: "Alex Example",
    contact_line: "Atlanta, GA | alex@example.com",
  },
  skills: {
    languages: ["TypeScript"],
    tools: ["React", "Node.js"],
  },
  sections: [
    {
      id: "projects",
      title: "Programming Projects",
      kind: "projects",
      entries: [
        {
          id: "project-1",
          heading: "Job Finder",
          date: "2026",
          tech: ["TypeScript", "React"],
          tags: ["full stack"],
          bullets: {
            base: ["Built a reliable job-search workflow with automated tests."],
          },
        },
      ],
    },
    {
      id: "skills",
      title: "Skills",
      kind: "skills",
      entries: [],
    },
  ],
};

beforeAll(() => {
  process.env.TRACKER_SECRET = SECRET;
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("GEMINI_API_KEY", "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("PDF-first resume build", () => {
  test("request, action, persistence, and download artifacts work together", async () => {
    const t = convexTest(schema);
    await t.mutation(resume.putProfile, {
      user: "alice",
      data: JSON.stringify(PROFILE),
      secret: SECRET,
    });
    await t.mutation(tracker.pushMatches, {
      user: "alice",
      items: [
        {
          short: "acme-role",
          company: "Acme, Inc.",
          title: "Software Engineer",
          location: "Atlanta, GA",
        },
      ],
      secret: SECRET,
    });

    const requested = await t.mutation(resume.requestBuild, {
      user: "alice",
      short: "acme-role",
      secret: SECRET,
      jdText: "Requirements: TypeScript, React, automated testing, and full-stack development.",
    });
    expect(requested).toEqual({ ok: true });
    expect(
      await t.query(resume.getBuildStatus, {
        user: "alice",
        short: "acme-role",
        secret: SECRET,
      }),
    ).toBe("building");

    // requestBuild schedules the action with setTimeout. The fake clock keeps
    // that background copy parked while this test invokes the action itself.
    // PDFKit uses real timers internally, so restore them before rendering.
    vi.useRealTimers();
    await t.action(runBuild, {
      user: "alice",
      short: "acme-role",
      jdText: "Requirements: TypeScript, React, automated testing, and full-stack development.",
    });

    expect(
      await t.query(resume.getBuildStatus, {
        user: "alice",
        short: "acme-role",
        secret: SECRET,
      }),
    ).toBeNull();

    const [row] = await t.query(tracker.getResumeUrls, {
      user: "alice",
      secret: SECRET,
    });
    expect(row).toMatchObject({
      short: "acme-role",
      format: "pdf",
      filename: "Alex_Example_AcmeInc.pdf",
      docxFilename: "Alex_Example_AcmeInc.docx",
    });
    expect(row.url).toMatch(/^https?:/);
    expect(row.docxUrl).toMatch(/^https?:/);

    const stored = await t.run(async (ctx) =>
      ctx.db
        .query("resumes")
        .withIndex("by_user_short", (q) =>
          q.eq("user", "alice").eq("short", "acme-role"),
        )
        .first(),
    );
    expect(stored?.artifactFormat).toBe("pdf");
    const pdfBlob = await t.run(async (ctx) => {
      const blob = await ctx.storage.get(stored!.storageId);
      return blob && { type: blob.type, bytes: await blob.arrayBuffer() };
    });
    const docxBlob = await t.run(async (ctx) => {
      const blob = await ctx.storage.get(stored!.docxStorageId!);
      return blob && { type: blob.type, bytes: await blob.arrayBuffer() };
    });
    expect(pdfBlob?.type).toBe("application/pdf");
    expect(docxBlob?.type).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );

    const pdf = await PDFDocument.load(pdfBlob!.bytes);
    expect(pdf.getPageCount()).toBe(1);
    const docxPrefix = new Uint8Array(docxBlob!.bytes).slice(0, 2);
    expect([...docxPrefix]).toEqual([0x50, 0x4b]);

    const report = JSON.parse(stored!.report as string);
    expect(report).toMatchObject({
      format: "pdf",
      pageCount: 1,
      jdSource: "manual",
      usedLlm: false,
    });
    expect(report.projects[0].name).toBe("Job Finder");
  }, 20_000);
});
