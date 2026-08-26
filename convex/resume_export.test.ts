// @vitest-environment node

import { describe, expect, test, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import PDFKitDocument from "pdfkit/js/pdfkit.standalone.js";
import { migrateProfile, type ProfileV1, type ProfileV2 } from "./profile_schema";
import {
  fullResumeContent,
  fullResumeFilename,
  resumeOutline,
} from "./resume_renderers/docx";
import { exportResume, parseExportProfile } from "./resume_export";

const longBullet =
  "Built and operated a production software platform with measurable reliability improvements using TypeScript, PostgreSQL, Docker, and automated tests.";

const PROJECT_NAMES = Array.from({ length: 12 }, (_, i) => `Project ${i + 1}`);

// A bank far too big for one page: 12 projects x 4 long bullets plus two jobs
// and two community entries. The fitted build would drop most of it; the full
// export must keep all of it.
const bigV1: ProfileV1 = {
  header: {
    name: "Alex Example",
    contact_line: "Atlanta, GA | alex@example.com | (555) 555-0100",
    links: [{ text: "linkedin.com/in/alex", url: "https://linkedin.com/in/alex" }],
  },
  education: {
    institution: "Georgia Institute of Technology | Atlanta, GA",
    grad_date: "May 2027",
    degree: "B.S. Computer Science",
    threads: "Concentrations: Systems and Intelligence",
    gpa: "GPA 3.8/4.0",
  },
  skills: {
    coursework: ["Operating Systems", "Algorithms"],
    languages: ["TypeScript", "Python"],
    tools: ["React", "Docker"],
  },
  work_experience: {
    "Acme Software": {
      location: "Atlanta, GA",
      role: "Software Engineering Intern",
      date: "May 2026 - August 2026",
      bullets: { base: [longBullet, longBullet, longBullet] },
    },
    "Beta Labs": {
      location: "Remote",
      role: "Research Assistant",
      date: "Jan 2026 - May 2026",
      bullets: { base: [longBullet, longBullet], swe: ["Shipped the swe-only bullet."] },
    },
  },
  projects: Object.fromEntries(
    PROJECT_NAMES.map((name) => [
      name,
      {
        tech: ["TypeScript", "React"],
        date: "2025 - 2026",
        bullets: { base: [longBullet, longBullet, longBullet, longBullet] },
      },
    ]),
  ),
  community: {
    "Computing Club": { date: "2024 - Present", bullets: { base: [longBullet, longBullet] } },
    "Peer Tutor": { date: "2025 - Present", bullets: { base: [longBullet] } },
  },
};

function bigProfile(): ProfileV2 {
  const p = migrateProfile(bigV1);
  // Hide one project and one job in the swe variant, and give one project
  // swe-specific bullets, so the variant plumbing is observable end to end.
  const projects = p.sections.find((s) => s.kind === "projects")!;
  projects.entries[0].hiddenIn = ["swe"];
  projects.entries[1].bullets.swe = ["The swe project bullet."];
  const experience = p.sections.find((s) => s.kind === "experience")!;
  experience.entries[0].hiddenIn = ["swe"];
  return p;
}

/** Every string PDFKit was asked to draw, in order. */
function drawnText(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map(([text]) => String(text));
}

describe("full resume export", () => {
  test("PDF keeps every project and paginates instead of fitting", async () => {
    const textSpy = vi.spyOn(PDFKitDocument.prototype, "text");
    const addPageSpy = vi.spyOn(PDFKitDocument.prototype, "addPage");
    try {
      const out = await exportResume(bigProfile(), "base", "pdf");
      if (process.env.RESUME_PDF_OUTPUT) {
        await writeFile(process.env.RESUME_PDF_OUTPUT, out.bytes);
      }
      expect(out.filename).toBe("Alex_Example_Resume.pdf");
      expect(out.contentType).toBe("application/pdf");
      expect(new TextDecoder().decode(out.bytes.slice(0, 5))).toBe("%PDF-");

      const parsed = await PDFDocument.load(out.bytes);
      expect(parsed.getPageCount()).toBeGreaterThan(1);
      for (const page of parsed.getPages()) {
        expect(page.getWidth()).toBeCloseTo(612);
        expect(page.getHeight()).toBeCloseTo(792);
      }
      // Our placement adds every page; PDFKit's own overflow pagination never
      // fires (it would add pages without going through addPage's margins).
      expect(addPageSpy).toHaveBeenCalledTimes(parsed.getPageCount());

      const drawn = drawnText(textSpy);
      for (const name of PROJECT_NAMES) expect(drawn).toContain(name);
      expect(drawn.filter((t) => t === longBullet).length).toBe(
        12 * 4 + 3 + 2 + 2 + 1,
      );
      expect(drawn).toContain("Acme Software");
      expect(drawn).toContain("Beta Labs");
    } finally {
      textSpy.mockRestore();
      addPageSpy.mockRestore();
    }
  });

  test("PDF honours the variant across every section", async () => {
    const textSpy = vi.spyOn(PDFKitDocument.prototype, "text");
    try {
      const out = await exportResume(bigProfile(), "swe", "pdf");
      if (process.env.RESUME_PDF_OUTPUT) {
        await writeFile(process.env.RESUME_PDF_OUTPUT.replace(/\.pdf$/, "_swe.pdf"), out.bytes);
      }
      expect(out.filename).toBe("Alex_Example_Resume_swe.pdf");
      const drawn = drawnText(textSpy);
      expect(drawn).not.toContain("Project 1");
      expect(drawn).toContain("Project 2");
      expect(drawn).toContain("The swe project bullet.");
      expect(drawn).not.toContain("Acme Software");
      expect(drawn).toContain("Beta Labs");
      expect(drawn).toContain("Shipped the swe-only bullet.");
    } finally {
      textSpy.mockRestore();
    }
  });

  test("every drawn block sits inside the page's margins", async () => {
    // Placement must stop PDFKit from ever drawing past the bottom margin:
    // a y past 756 would mean a block was drawn where it did not fit.
    const textSpy = vi.spyOn(PDFKitDocument.prototype, "text");
    try {
      await exportResume(bigProfile(), "base", "pdf");
      const ys = textSpy.mock.calls
        .map((call) => call[2])
        .filter((y): y is number => typeof y === "number");
      expect(ys.length).toBeGreaterThan(50);
      expect(Math.max(...ys)).toBeLessThanOrEqual(792 - 36);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(36);
    } finally {
      textSpy.mockRestore();
    }
  });

  test("DOCX renders the variant's full content", async () => {
    const profile = bigProfile();
    const out = await exportResume(profile, "swe", "docx");
    expect(out.filename).toBe("Alex_Example_Resume_swe.docx");
    expect(out.contentType).toContain("wordprocessingml");
    // A .docx is a zip.
    expect(out.bytes[0]).toBe(0x50);
    expect(out.bytes[1]).toBe(0x4b);

    const lines = resumeOutline(profile, fullResumeContent(profile, "swe"), "swe");
    expect(lines.some((l) => l.startsWith("Project 1 |"))).toBe(false);
    expect(lines.some((l) => l.startsWith("Project 2 |"))).toBe(true);
    expect(lines.filter((l) => l.startsWith("Project ")).length).toBe(11);
    expect(lines).toContain("●\tThe swe project bullet.");
    expect(lines.some((l) => l.startsWith("Acme Software"))).toBe(false);
    expect(lines).toContain("●\tShipped the swe-only bullet.");
  });

  test("fullResumeContent keeps bank order and falls back to base bullets", () => {
    const profile = bigProfile();
    const content = fullResumeContent(profile, "swe");
    expect(content.projects.map((p) => p.name)).toEqual(PROJECT_NAMES.slice(1));
    expect(content.projects[0].bullets).toEqual(["The swe project bullet."]);
    expect(content.projects[1].bullets).toEqual([longBullet, longBullet, longBullet, longBullet]);
    expect(content.projects[0].tech).toBe("TypeScript, React");
  });

  test("filenames slug the variant and never the base", () => {
    const profile = bigProfile();
    expect(fullResumeFilename(profile, "base", "pdf")).toBe("Alex_Example_Resume.pdf");
    expect(fullResumeFilename(profile, "data sci/ml", "docx")).toBe(
      "Alex_Example_Resume_datasciml.docx",
    );
  });

  test("parseExportProfile rejects non-profiles with a user-facing message", () => {
    expect(() => parseExportProfile("{")).toThrow("not valid JSON");
    expect(() => parseExportProfile("[]")).toThrow("not a resume profile");
    expect(parseExportProfile(JSON.stringify(bigProfile())).version).toBe(2);
  });
});
