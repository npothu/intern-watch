// @vitest-environment node

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { PDFDocument } from "pdf-lib";
import PDFKitDocument from "pdfkit/js/pdfkit.standalone.js";
import JSZip from "jszip";
import { copyResume, getResume, putResume } from "../shared/resume-compose";
import schema from "./schema";
import { api, internal } from "./_generated/api";
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
  vi.unstubAllGlobals();
});

describe("PDF-first resume build", () => {
  test.each([undefined, "base", "swe"])(
    "saved hidden projects stay out of generated artifacts (variant %s)",
    async (variant) => {
      const t = convexTest(schema);
      const profile = structuredClone(PROFILE);
      const projects = profile.sections[0].entries;
      projects.unshift({
        ...structuredClone(projects[0]),
        id: "hidden-project",
        heading: "Hidden Project",
        hiddenIn: [variant ?? "base"],
        bullets: { base: ["Hidden project evidence."], swe: ["TypeScript React testing."] },
      });
      await t.mutation(api.resume.putProfile, {
        user: "alice", data: JSON.stringify(profile), secret: SECRET,
      });
      await t.mutation(api.tracker.pushMatches, {
        user: "alice", items: [{ short: "visibility-role", company: "Acme" }], secret: SECRET,
      });
      await t.mutation(api.resume.requestBuild, {
        user: "alice", short: "visibility-role", secret: SECRET,
        jdText: "Requirements: TypeScript React testing.", variant,
      });
      vi.useRealTimers();
      const textSpy = vi.spyOn(PDFKitDocument.prototype, "text");
      try {
        await t.action(internal.resume_node.runBuild, { user: "alice", short: "visibility-role", variant });
        const stored = await t.run((ctx) => ctx.db.query("resumes").first());
        expect(stored).not.toBeNull();
        const report = JSON.parse(stored!.report as string);
        const docx = await t.run(async (ctx) => {
          const blob = await ctx.storage.get(stored!.docxStorageId!);
          return blob!.arrayBuffer();
        });
        const zip = await JSZip.loadAsync(docx);
        const xml = await zip.file("word/document.xml")!.async("string");
        expect(xml).toContain("Job Finder");
        expect(xml).not.toContain("Hidden Project");
        const pdfText = textSpy.mock.calls.map((call) => call[0]).join("\n");
        expect(pdfText).toContain("Job Finder");
        expect(pdfText).not.toContain("Hidden Project");
        expect(report.projects.map((project: { name: string }) => project.name)).toEqual(["Job Finder"]);
        expect(report.scores).not.toHaveProperty("Hidden Project");
      } finally {
        textSpy.mockRestore();
      }
    },
    20_000,
  );

  test("a saved job description can be read and overwritten independently of a build", async () => {
    const t = convexTest(schema);
    await t.mutation(api.tracker.pushMatches, {
      user: "alice",
      items: [{ short: "acme-role", company: "Acme, Inc." }],
      secret: SECRET,
    });

    await t.mutation(api.resume.saveJobDescription, {
      user: "alice",
      short: "acme-role",
      jdText: "First job description",
      secret: SECRET,
    });
    expect(
      await t.query(api.resume.getJobDescription, {
        user: "alice",
        short: "acme-role",
        secret: SECRET,
      }),
    ).toMatchObject({ text: "First job description" });

    await t.mutation(api.resume.saveJobDescription, {
      user: "alice",
      short: "acme-role",
      jdText: "Updated job description",
      secret: SECRET,
    });
    expect(
      await t.query(api.resume.getJobDescription, {
        user: "alice",
        short: "acme-role",
        secret: SECRET,
      }),
    ).toMatchObject({ text: "Updated job description" });
    expect(
      await t.query(api.tracker.getMatches, { user: "alice", secret: SECRET }),
    ).toEqual([
      expect.objectContaining({
        short: "acme-role",
        hasJobDescription: true,
      }),
    ]);
  });

  test("request, action, persistence, and download artifacts work together", async () => {
    const t = convexTest(schema);
    await t.mutation(api.resume.putProfile, {
      user: "alice",
      data: JSON.stringify(PROFILE),
      secret: SECRET,
    });
    await t.mutation(api.tracker.pushMatches, {
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

    const requested = await t.mutation(api.resume.requestBuild, {
      user: "alice",
      short: "acme-role",
      secret: SECRET,
      jdText: "Requirements: TypeScript, React, automated testing, and full-stack development.",
    });
    expect(requested).toEqual({ ok: true });
    const savedMatch = await t.run(async (ctx) =>
      ctx.db
        .query("matches")
        .withIndex("by_user_short", (q) =>
          q.eq("user", "alice").eq("short", "acme-role"),
        )
        .first(),
    );
    expect(savedMatch?.jobDescription).toBe(
      "Requirements: TypeScript, React, automated testing, and full-stack development.",
    );
    expect(
      await t.query(api.resume.getBuildStatus, {
        user: "alice",
        short: "acme-role",
        secret: SECRET,
      }),
    ).toBe("building");

    // requestBuild schedules the action with setTimeout. The fake clock keeps
    // that background copy parked while this test invokes the action itself.
    // PDFKit uses real timers internally, so restore them before rendering.
    vi.useRealTimers();
    await t.action(internal.resume_node.runBuild, {
      user: "alice",
      short: "acme-role",
      variant: "tailored",
    });

    expect(
      await t.query(api.resume.getBuildStatus, {
        user: "alice",
        short: "acme-role",
        secret: SECRET,
      }),
    ).toBeNull();

    const [row] = await t.query(api.tracker.getResumeUrls, {
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
      jdChars: 79,
      variant: "tailored",
      usedLlm: false,
    });
    expect(report.projects[0].name).toBe("Job Finder");
    expect(report.projects[0].variant).toBe("base");
  }, 20_000);
});


test("saved variant builds capture the draft and protect locked text from adversarial rewrites", async () => {
  const t = convexTest(schema);
  let bank = copyResume(PROFILE, "base", "Platform");
  const resume = structuredClone(getResume(bank, "Platform"));
  resume.sections[0].entries[0].bullets = [
    { id: "locked", text: "Protected original evidence", included: true, locked: true },
    { id: "open", text: "Built reliable software", included: true, locked: false },
    { id: "excluded", text: "Excluded secret evidence", included: false, locked: false },
  ];
  resume.sections[0].entries.push({ ...structuredClone(resume.sections[0].entries[0]), id: "duplicate", locked: true,
    bullets: [{ id: "second", text: "Second protected project", included: true, locked: false }] });
  bank = putResume(bank, resume);
  await t.mutation(api.resume.putProfile, { user: "alice", data: JSON.stringify(bank), secret: SECRET });
  await t.mutation(api.tracker.pushMatches, { user: "alice", items: [{ short: "composed-role", company: "Acme" }], secret: SECRET });
  await t.mutation(api.resume.requestBuild, { user: "alice", short: "composed-role", secret: SECRET, variant: "Platform", profileSnapshot: JSON.stringify(bank), jdText: "TypeScript software engineering" });
  const scheduled = await t.run(ctx => ctx.db.system.query("_scheduled_functions").collect());
  const args = scheduled[0].args[0];
  // Later saves must not change an already queued build.
  await t.mutation(api.resume.putProfile, { user: "alice", data: JSON.stringify({ ...PROFILE, sections: [] }), secret: SECRET });
  expect(args.profileSnapshot).toBe(JSON.stringify(bank));
  vi.stubEnv("GEMINI_API_KEY", "fake-key");
  const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const request = String(init?.body);
    expect(request).not.toContain("Protected original evidence");
    expect(request).not.toContain("Second protected project");
    expect(request).not.toContain("Excluded secret evidence");
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify([
      { name: "project-1", bullets: ["Shipped reliable software"] },
      { name: "duplicate", bullets: ["Replaced locked evidence"] },
    ]) }] } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.useRealTimers();
  await t.action(internal.resume_node.runBuild, args);
  const stored = await t.run(ctx => ctx.db.query("resumes").first());
  expect(stored).not.toBeNull();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const report = JSON.parse(stored!.report as string);
  expect(report.projects.map((p: { after: string[] }) => p.after)).toEqual([
    ["Protected original evidence", "Shipped reliable software"], ["Second protected project"],
  ]);
  const bytes = await t.run(async ctx => (await ctx.storage.get(stored!.docxStorageId!))!.arrayBuffer());
  const xml = await (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
  expect(xml).toContain("Protected original evidence");
  expect(xml).toContain("Second protected project");
  expect(xml).not.toContain("Excluded secret evidence");
  expect(xml).not.toContain("Replaced locked evidence");
});
