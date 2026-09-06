// @vitest-environment node
import { describe, expect, test, vi } from "vitest";
import JSZip from "jszip";
import PDFKitDocument from "pdfkit/js/pdfkit.standalone.js";
import { PDFDocument } from "pdf-lib";
import {
  addFromLibrary,
  applyCuts,
  copyResume,
  deleteResumeVariant,
  getResume,
  putResume,
  resolveResume,
  resumeRevision,
  savedResumes,
  type SavedResume,
} from "../shared/resume-compose";
import type { ProfileV2 } from "./profile_schema";
import { exportResume } from "./resume_export";
import { suggestResumeCuts } from "./resume_cuts";

const fixture = (): ProfileV2 => ({
  version: 2,
  header: { name: "Alex Example", contact_line: "alex@example.com" },
  skills: {},
  variants: ["swe"],
  sections: [
    {
      id: "work",
      title: "Experience",
      kind: "experience",
      entries: [
        {
          id: "job",
          heading: "Acme",
          date: "2026",
          hiddenIn: ["swe"],
          bullets: { base: ["Base experience"], swe: [] },
        },
      ],
    },
    {
      id: "projects",
      title: "Projects",
      kind: "projects",
      entries: [
        {
          id: "p1",
          heading: "Same name",
          date: "2026",
          bullets: {
            base: ["First evidence", "Duplicate", "Duplicate"],
            swe: ["Variant evidence", "Duplicate", "Duplicate"],
          },
        },
      ],
    },
    {
      id: "more",
      title: "Research projects",
      kind: "projects",
      entries: [
        {
          id: "p2",
          heading: "Same name",
          date: "2025",
          bullets: { base: ["Second project evidence"] },
        },
      ],
    },
  ],
});
const modify = (resume: SavedResume) => {
  const copy = structuredClone(resume);
  copy.sections[1].entries[0].bullets[1].included = false;
  copy.sections[1].entries[0].bullets[2].locked = true;
  return copy;
};

describe("saved resume composition", () => {
  test("legacy variants preserve sparse fallback, explicit empty arrays, visibility and duplicate occurrences", () => {
    const p = fixture(),
      r = getResume(p, "swe");
    expect(r.sections[0].entries[0]).toMatchObject({
      included: false,
      bullets: [],
    });
    expect(r.sections[2].entries[0].bullets[0].text).toBe(
      "Second project evidence",
    );
    expect(
      new Set(r.sections[1].entries[0].bullets.map((b) => b.id)).size,
    ).toBe(3);
    expect(savedResumes({ ...p, savedResumes: [] })).toEqual([]);
  });
  test("copies retain hidden bullets and locks, and remain independent of Library and source", () => {
    const p = putResume(fixture(), modify(getResume(fixture(), "swe")));
    const copy = copyResume(p, "swe", "Platform");
    const r = getResume(copy, "Platform");
    expect(r.sections[1].entries[0].bullets[1].included).toBe(false);
    expect(r.sections[1].entries[0].bullets[2].locked).toBe(true);
    r.header.name = "Changed";
    r.sections[1].entries[0].bullets.reverse();
    copy.sections = [];
    expect(getResume(p, "swe").header.name).toBe("Alex Example");
    expect(getResume(p, "swe").sections[1].entries[0].bullets[0].text).toBe(
      "Variant evidence",
    );
    expect(resolveResume(r).sections).toHaveLength(3);
  });
  test("deleting a migrated variant removes legacy keys and cannot resurrect it", () => {
    const p = deleteResumeVariant(fixture(), "swe");
    expect(savedResumes(p)).toEqual([]);
    expect(p.sections[0].entries[0].hiddenIn).toEqual([]);
    expect(p.sections[1].entries[0].bullets.swe).toBeUndefined();
    expect(() => getResume(p, "swe")).toThrow("no longer exists");
  });
  test("Library additions are excluded and repeated imports do not duplicate occurrences", () => {
    const p = fixture(),
      r = getResume(p, "base");
    p.sections[1].entries[0].bullets.base.push("New evidence");
    const imported = addFromLibrary(p, r);
    expect(imported.sections[1].entries[0].bullets.at(-1)).toMatchObject({
      text: "New evidence",
      included: false,
    });
    expect(addFromLibrary(p, imported)).toEqual(imported);
  });
  test("PDF and Word use identical selections across every project section and never repeat headings", async () => {
    const p = putResume(fixture(), modify(getResume(fixture(), "swe")));
    const text = vi.spyOn(PDFKitDocument.prototype, "text");
    try {
      const pdf = await exportResume(p, "swe", "pdf");
      expect((await PDFDocument.load(pdf.bytes)).getPageCount()).toBe(1);
      const drawn = text.mock.calls.map((c) => String(c[0]));
      expect(drawn.filter((s) => s === "Same name")).toHaveLength(2);
      expect(drawn.join("\n")).not.toContain("Base experience");
      expect(drawn.filter((s) => s === "Duplicate")).toHaveLength(1);
      const docx = await exportResume(p, "swe", "docx");
      const xml = await (
        await JSZip.loadAsync(docx.bytes)
      )
        .file("word/document.xml")!
        .async("string");
      expect(xml).toContain("Second project evidence");
      expect(xml).toContain("Variant evidence");
      expect(xml).not.toContain("Base experience");
      expect(xml.match(/Duplicate/g)).toHaveLength(1);
    } finally {
      text.mockRestore();
    }
  });
  test("cut proposals preserve locked content, bind to source, and apply only accepted choices", async () => {
    const r = getResume(fixture(), "swe");
    r.sections[1].entries[0].bullets = Array.from({ length: 24 }, (_, i) => ({
      id: `long${i}`,
      text:
        `Evidence ${i}: ` +
        "Built reliable systems using TypeScript and automated integration testing. ".repeat(
          4,
        ),
      included: true,
      locked: i === 1,
    }));
    const original = structuredClone(r);
    const proposal = await suggestResumeCuts(r);
    expect(proposal.beforePages).toBeGreaterThan(1);
    expect(proposal.cuts.length).toBeGreaterThan(0);
    expect(proposal.cuts.some((c) => c.bulletId === "long1")).toBe(false);
    expect(r).toEqual(original);
    const accepted = applyCuts(r, proposal, [proposal.cuts[0].id]);
    expect(
      accepted.sections[1].entries[0].bullets.filter((b) => !b.included),
    ).toHaveLength(1);
    const changed = structuredClone(r);
    changed.sections[1].entries[0].locked = true;
    expect(resumeRevision(changed)).not.toBe(proposal.revision);
    expect(() => applyCuts(changed, proposal, [proposal.cuts[0].id])).toThrow(
      "resume changed",
    );
  });
});
