// @vitest-environment node

import { describe, expect, test, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import PDFKitDocument from "pdfkit/js/pdfkit.standalone.js";
import { migrateProfile, type ProfileV1 } from "./profile_schema";
import { projectEntries } from "./resume_renderers/docx";
import { buildResumePdf } from "./resume_renderers/pdf";

const PROJECT_NAMES = [
  "Finance Autofiller",
  "Travel Collaboration App",
  "Comet",
  "Delta",
  "Echo",
  "Forge",
  "Grove",
];

const longBullet =
  "Built and operated a production software platform with measurable reliability improvements using TypeScript, PostgreSQL, Docker, and automated tests.";

const profileV1: ProfileV1 = {
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
    coursework: ["Operating Systems", "Algorithms", "Database Systems"],
    languages: ["TypeScript", "Python", "C", "SQL"],
    tools: ["React", "Node.js", "Docker", "PostgreSQL", "AWS"],
  },
  work_experience: {
    "Acme Software": {
      location: "Atlanta, GA",
      role: "Software Engineering Intern",
      date: "May 2026 - August 2026",
      bullets: { base: [longBullet, longBullet, longBullet] },
    },
  },
  projects: Object.fromEntries(
    PROJECT_NAMES.map((name) => [
      name,
      {
        tech: ["TypeScript", "React", "PostgreSQL"],
        date: "2025 - 2026",
        bullets: {
          base: [longBullet, longBullet, longBullet],
          concise: [longBullet],
        },
      },
    ]),
  ),
  community: {
    "Computing Club": {
      date: "2024 - Present",
      bullets: { base: [longBullet, longBullet] },
    },
    "Peer Tutor": {
      date: "2025 - Present",
      bullets: { base: [longBullet, longBullet] },
    },
  },
};

describe("PDF-first resume renderer", () => {
  test("fits an oversized bank to one validated US Letter page", async () => {
    const textSpy = vi.spyOn(PDFKitDocument.prototype, "text");
    const profile = migrateProfile(profileV1);
    const content = {
      projects: projectEntries(profile).map((entry) => ({
        name: entry.heading,
        tech: (entry.tech ?? []).join(", "),
        date: entry.date,
        bullets: entry.bullets.base,
      })),
    };
    const scores = Object.fromEntries(
      PROJECT_NAMES.map((name, index) => [name, PROJECT_NAMES.length - index]),
    );

    const result = await buildResumePdf(profile, content, {
      scores,
    });
    const parsed = await PDFDocument.load(result.bytes);
    const page = parsed.getPage(0);
    if (process.env.RESUME_PDF_OUTPUT) {
      await writeFile(process.env.RESUME_PDF_OUTPUT, result.bytes);
    }

    expect(new TextDecoder().decode(result.bytes.slice(0, 5))).toBe("%PDF-");
    expect(parsed.getPageCount()).toBe(1);
    expect(page.getWidth()).toBeCloseTo(612);
    expect(page.getHeight()).toBeCloseTo(792);
    expect(result.heightPt).toBeLessThanOrEqual(result.safeHeightPt);
    expect(result.notes.length).toBeGreaterThan(0);
    expect(result.content.projects.length).toBeGreaterThanOrEqual(4);

    const nameCall = textSpy.mock.calls.find(([text]) => text === "Finance Autofiller");
    const separatorCall = textSpy.mock.calls.find(([text]) => text === " | ");
    expect(nameCall?.[3]).toMatchObject({ lineBreak: false });
    expect(separatorCall?.[3]).toMatchObject({ lineBreak: false });
    expect(separatorCall?.[2]).toBe(nameCall?.[2]);
    textSpy.mockRestore();
  });
});
