// @vitest-environment node

import { describe, expect, test, vi } from "vitest";
import { Packer } from "docx";
import JSZip from "jszip";
import { composeResumeDoc } from "./resume_docx";
import type { ProfileV2 } from "./profile_schema";
import {
  MAX_EXTRACTION_PAYLOAD_CHARS,
  MAX_IMPORT_BYTES,
  MAX_MODEL_INPUT_CHARS,
  buildImportPrompt,
  extractDocxXml,
  extractResume,
  mapExtractionWithModel,
  meteredInvoke,
  resumeImportFormat,
  validateModelOutput,
  validateProfileV2,
  type ExtractedResume,
} from "./resume_import";

const profile: ProfileV2 = {
  version: 2,
  header: {
    name: "Alex Example",
    contact_line: "alex@example.com",
  },
  skills: {
    languages: ["TypeScript"],
  },
  sections: [
    {
      id: "experience",
      title: "Experience",
      kind: "experience",
      entries: [
        {
          id: "example-co",
          heading: "Example Co",
          subheading: "Engineering Intern",
          date: "Summer 2026",
          bullets: { base: ["Built a reliable import pipeline"] },
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

function extracted(...texts: string[]): ExtractedResume {
  return {
    format: "txt",
    filename: "resume.txt",
    lines: texts.map((text, index) => ({
      id: `line-${String(index + 1).padStart(4, "0")}`,
      text,
      runs: text ? [{ text, bold: false, italics: false }] : [],
      bold: false,
      italics: false,
      hasTab: text.includes("\t"),
      rightTab: false,
      borderBottom: false,
      bullet: false,
    })),
  };
}

function modelResponse(
  mappings: { lineId: string; targetPaths: string[] }[] = [],
  importedProfile: ProfileV2 = profile,
): string {
  return JSON.stringify({ profile: importedProfile, mappings });
}

describe("resume import extraction", () => {
  test("TXT and Markdown preserve ordered lines with stable IDs", async () => {
    const txt = new TextEncoder().encode("Alex Example\r\nExperience\r\nBuilt a tool\r\n");
    const md = new TextEncoder().encode("# Alex Example\n\n- Built a tool\n");

    const txtResult = await extractResume(txt, {
      filename: "resume.txt",
      contentType: "text/plain",
    });
    const mdResult = await extractResume(md, {
      filename: "resume.md",
      contentType: "text/markdown",
    });

    expect(txtResult.format).toBe("txt");
    expect(txtResult.lines.map((line) => [line.id, line.text])).toEqual([
      ["line-0001", "Alex Example"],
      ["line-0002", "Experience"],
      ["line-0003", "Built a tool"],
      ["line-0004", ""],
    ]);
    expect(mdResult.format).toBe("md");
    expect(mdResult.lines.map((line) => line.text)).toEqual([
      "# Alex Example",
      "",
      "- Built a tool",
      "",
    ]);
    expect(mdResult.lines[2].bullet).toBe(true);
  });

  test("file size and type checks reject mismatches, PDFs, and binary text", async () => {
    expect(resumeImportFormat("resume.docx", "")).toBe("docx");
    expect(resumeImportFormat("resume.txt", "application/octet-stream")).toBe("txt");
    expect(resumeImportFormat("resume.markdown", "text/x-markdown")).toBe("md");
    expect(() => resumeImportFormat("resume.pdf", "application/pdf")).toThrow(
      "PDF import is not supported yet",
    );
    expect(() => resumeImportFormat("resume.txt", "application/pdf")).toThrow(
      "PDF import is not supported yet",
    );
    expect(() => resumeImportFormat("resume.txt", "text/markdown")).toThrow(
      "does not match",
    );
    expect(() => resumeImportFormat("resume.rtf", "application/rtf")).toThrow(
      "Upload a DOCX, TXT, or Markdown file",
    );
    await expect(
      extractResume(new Uint8Array(MAX_IMPORT_BYTES + 1), {
        filename: "resume.txt",
        contentType: "text/plain",
      }),
    ).rejects.toThrow("5 MB");
    await expect(
      extractResume(new TextEncoder().encode("%PDF-fake"), {
        filename: "resume.txt",
        contentType: "text/plain",
      }),
    ).rejects.toThrow("PDF import is not supported yet");
    await expect(
      extractResume(new Uint8Array([65, 0, 66]), {
        filename: "resume.txt",
        contentType: "text/plain",
      }),
    ).rejects.toThrow("binary data");
    await expect(
      extractResume(new Uint8Array([0xff]), {
        filename: "resume.txt",
        contentType: "text/plain",
      }),
    ).rejects.toThrow("UTF-8");
  });

  test("DOCX XML retains run and paragraph structural signals", () => {
    const xml = `<?xml version="1.0"?>
      <w:document xmlns:w="urn:test"><w:body>
        <w:p><w:pPr><w:pBdr><w:bottom w:val="single"/></w:pBdr></w:pPr>
          <w:r><w:rPr><w:b/></w:rPr><w:t>Experience</w:t></w:r>
        </w:p>
        <w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="10800"/></w:tabs></w:pPr>
          <w:r><w:rPr><w:b/></w:rPr><w:t>Example Co</w:t><w:tab/></w:r>
          <w:r><w:rPr><w:i/></w:rPr><w:t>Summer 2026</w:t></w:r>
        </w:p>
        <w:p><w:pPr><w:numPr/><w:ind w:left="720" w:hanging="360"/></w:pPr>
          <w:r><w:t>Built a tool</w:t></w:r>
        </w:p>
      </w:body></w:document>`;

    const lines = extractDocxXml(xml);

    expect(lines.map((line) => line.text)).toEqual([
      "Experience",
      "Example Co\tSummer 2026",
      "Built a tool",
    ]);
    expect(lines[0]).toMatchObject({ bold: true, borderBottom: true });
    expect(lines[1]).toMatchObject({ hasTab: true, rightTab: true });
    expect(lines[1].runs).toEqual([
      { text: "Example Co\t", bold: true, italics: false },
      { text: "Summer 2026", bold: false, italics: true },
    ]);
    expect(lines[2]).toMatchObject({
      bullet: true,
      indentLeft: 720,
      hanging: 360,
    });
  });

  test("malformed numeric entities produce the friendly damaged-DOCX error", async () => {
    const zip = new JSZip();
    zip.file(
      "word/document.xml",
      '<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>&#x110000;</w:t></w:r></w:p></w:body></w:document>',
    );
    const bytes = await zip.generateAsync({ type: "uint8array" });

    await expect(
      extractResume(bytes, {
        filename: "resume.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).rejects.toThrow("This DOCX file is damaged or is not a valid Word document.");
  });

  test("a missing declared document size fails closed before decompression", async () => {
    const decompress = vi.fn().mockResolvedValue(new TextEncoder().encode("<w:document/>"));
    vi.spyOn(JSZip, "loadAsync").mockResolvedValueOnce({
      file: vi.fn().mockReturnValue({ async: decompress }),
    } as unknown as JSZip);

    await expect(
      extractResume(new Uint8Array([0x50, 0x4b]), {
        filename: "resume.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).rejects.toThrow("This DOCX file is damaged or is not a valid Word document.");
    expect(decompress).not.toHaveBeenCalled();
  });

  test("an app-produced DOCX round trips paragraph order and rendering signals", async () => {
    const docxProfile: ProfileV2 = {
      ...profile,
      skills: {},
      sections: [
        {
          id: "education",
          title: "Education",
          kind: "education",
          entries: [
            {
              id: "school",
              heading: "Example University",
              location: "Atlanta, GA",
              date: "May 2027",
              degrees: [
                {
                  degree: "B.S. Computer Science",
                  grad_date: "May 2027",
                },
              ],
              bullets: {},
            },
          ],
        },
        profile.sections[0],
      ],
    };
    const buffer = await Packer.toBuffer(
      composeResumeDoc(docxProfile, { projects: [] }),
    );

    const result = await extractResume(new Uint8Array(buffer), {
      filename: "Alex_Example.docx",
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    expect(result.lines.map((line) => line.text)).toEqual([
      "Alex Example",
      "alex@example.com",
      "",
      "Education",
      "Example University | Atlanta, GA\tGraduation May 2027",
      "B.S. Computer Science",
      "",
      "Experience",
      "Example Co\t",
      "Engineering Intern\tSummer 2026",
      "●\tBuilt a reliable import pipeline",
    ]);
    expect(result.lines.find((line) => line.text === "Education")).toMatchObject({
      bold: true,
      borderBottom: true,
    });
    expect(
      result.lines.find((line) => line.text.startsWith("Example University")),
    ).toMatchObject({ hasTab: true, rightTab: true });
    expect(
      result.lines.find((line) => line.text === "B.S. Computer Science")?.italics,
    ).toBe(true);
    expect(
      result.lines.find((line) => line.text.includes("Built a reliable")),
    ).toMatchObject({ bullet: true, indentLeft: 720, hanging: 360 });
  });

  test("app-produced DOCX hyperlinks retain their targets", async () => {
    const linkedProfile: ProfileV2 = {
      ...profile,
      header: {
        ...profile.header,
        links: [{ text: "Portfolio", url: "https://example.com/portfolio" }],
      },
    };
    const buffer = await Packer.toBuffer(composeResumeDoc(linkedProfile, { projects: [] }));

    const result = await extractResume(new Uint8Array(buffer), {
      filename: "Alex_Example.docx",
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    expect(
      result.lines.flatMap((line) => line.runs).find((run) => run.text === "Portfolio"),
    ).toMatchObject({ url: "https://example.com/portfolio" });
  });
});

describe("resume import validation and mappings", () => {
  test("ProfileV2 validation rejects unknown fields and duplicate IDs", () => {
    expect(validateProfileV2(profile)).toEqual({ ok: true, profile });
    const malformed = {
      ...profile,
      unexpected: true,
      sections: [
        profile.sections[0],
        { ...profile.sections[1], id: profile.sections[0].id },
      ],
    };

    const result = validateProfileV2(malformed);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          "profile.unexpected is not part of ProfileV2",
          "profile section IDs must be unique",
        ]),
      );
    }
  });

  test("credible mappings count sections and leave every other nonblank line unmapped", () => {
    const extraction = extracted(
      "Alex Example",
      "Experience",
      "Built a reliable import pipeline",
      "Secret clearance required",
      "",
    );
    const result = validateModelOutput(
      modelResponse([
        { lineId: "line-0001", targetPaths: ["/header/name"] },
        { lineId: "line-0002", targetPaths: ["/sections/0/title"] },
        {
          lineId: "line-0003",
          targetPaths: ["/sections/0/entries/0/bullets/base/0"],
        },
        { lineId: "line-0004", targetPaths: ["/header/contact_line"] },
      ]),
      extraction,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.unmappedLines).toEqual([
        { id: "line-0004", text: "Secret clearance required" },
      ]);
      expect(result.value.sections).toEqual([
        { id: "experience", title: "Experience", kind: "experience", count: 1 },
        { id: "skills", title: "Skills", kind: "skills", count: 1 },
      ]);
    }
  });

  test("a truncated mapped bullet is partial with its dropped content visible", () => {
    const extraction = extracted("Built a reliable import pipeline with retries");
    const truncatedProfile: ProfileV2 = {
      ...profile,
      sections: [
        {
          ...profile.sections[0],
          entries: [
            {
              ...profile.sections[0].entries[0],
              bullets: { base: ["Built a reliable import pipeline"] },
            },
          ],
        },
        profile.sections[1],
      ],
    };
    const result = validateModelOutput(
      modelResponse(
        [
          {
            lineId: "line-0001",
            targetPaths: ["/sections/0/entries/0/bullets/base/0"],
          },
        ],
        truncatedProfile,
      ),
      extraction,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.partialMappedLines).toEqual([
        {
          id: "line-0001",
          text: "Built a reliable import pipeline with retries",
          droppedText: "with retries",
        },
      ]);
      expect(result.value.unmappedLines).toEqual([]);
    }
  });

  test("normalization-only differences are fully mapped", () => {
    const extraction = extracted("Built, a Café / import pipeline");
    const normalizedProfile: ProfileV2 = {
      ...profile,
      sections: [
        {
          ...profile.sections[0],
          entries: [
            {
              ...profile.sections[0].entries[0],
              bullets: { base: ["BUILT  A CAFE\u0301 IMPORT PIPELINE"] },
            },
          ],
        },
        profile.sections[1],
      ],
    };
    const result = validateModelOutput(
      modelResponse(
        [
          {
            lineId: "line-0001",
            targetPaths: ["/sections/0/entries/0/bullets/base/0"],
          },
        ],
        normalizedProfile,
      ),
      extraction,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fullyMappedLines).toEqual([
        { id: "line-0001", text: "Built, a Café / import pipeline" },
      ]);
      expect(result.value.partialMappedLines).toEqual([]);
      expect(result.value.unmappedLines).toEqual([]);
    }
  });

  test("mapping metadata must use unique extraction IDs and real JSON pointers", () => {
    const extraction = extracted("Alex Example");
    const result = validateModelOutput(
      modelResponse([
        {
          lineId: "line-0002",
          targetPaths: ["/missing", "/missing", "header/name", "/bad~2escape"],
        },
      ]),
      extraction,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/lineId does not exist/);
      expect(result.errors.join("\n")).toMatch(/must not contain duplicates/);
      expect(result.errors.join("\n")).toMatch(/RFC 6901/);
      expect(result.errors.join("\n")).toMatch(/does not resolve/);
    }
  });
});

describe("resume import prompt and repair", () => {
  test("repair prompt includes validation errors and prior response within the cap", () => {
    const extraction = extracted("Alex Example");
    const previousResponse = "bad response ".repeat(5_000);
    const prompt = buildImportPrompt(extraction, {
      errors: ["profile.version must be 2"],
      previousResponse,
    });

    expect(prompt.user).toContain("profile.version must be 2");
    expect(prompt.user).toContain("Previous response:");
    expect(prompt.user).toContain("bad response");
    expect(prompt.user.length).toBeLessThanOrEqual(MAX_MODEL_INPUT_CHARS);
  });

  test("structured extraction payloads over the safe cap are rejected", () => {
    const extraction = extracted("x".repeat(MAX_EXTRACTION_PAYLOAD_CHARS));

    expect(() => buildImportPrompt(extraction)).toThrow("too much text");
  });

  test("invalid model shape receives exactly one repair with the prior response", async () => {
    const extraction = extracted("Alex Example");
    const invoke = vi
      .fn<(prompt: { system: string; user: string }) => Promise<string>>()
      .mockResolvedValueOnce("not json")
      .mockResolvedValueOnce(
        modelResponse([{ lineId: "line-0001", targetPaths: ["/header/name"] }]),
      );

    const result = await mapExtractionWithModel(extraction, invoke);

    expect(result.profile.header.name).toBe("Alex Example");
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke.mock.calls[1][0].user).toContain("not json");
    expect(invoke.mock.calls[1][0].user).toContain("not valid JSON");
  });

  test("provider failures are not retried", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("network unavailable"));

    await expect(mapExtractionWithModel(extracted("Alex Example"), invoke)).rejects.toThrow(
      "network unavailable",
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("an empty extraction fails before a model call", async () => {
    const invoke = vi.fn();

    await expect(mapExtractionWithModel(extracted("", "  "), invoke)).rejects.toThrow(
      "does not contain any text",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  test("a malformed repair fails after exactly two model responses", async () => {
    const invoke = vi.fn().mockResolvedValue("still not json");

    await expect(mapExtractionWithModel(extracted("Alex Example"), invoke)).rejects.toThrow(
      "after one repair attempt",
    );
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe("resume import operator metering (meteredInvoke)", () => {
  test("each call that returned text is charged, including the repair", async () => {
    const charge = vi.fn().mockResolvedValue({ allowed: true, used: 1 });
    const invoke = vi
      .fn<(prompt: { system: string; user: string }) => Promise<string>>()
      .mockResolvedValueOnce("not json")
      .mockResolvedValueOnce(
        modelResponse([{ lineId: "line-0001", targetPaths: ["/header/name"] }]),
      );

    const result = await mapExtractionWithModel(
      extracted("Alex Example"),
      meteredInvoke(invoke, charge),
    );

    expect(result.profile.header.name).toBe("Alex Example");
    expect(charge).toHaveBeenCalledTimes(2);
  });

  test("an import that ultimately fails still charges every productive call", async () => {
    const charge = vi.fn().mockResolvedValue({ allowed: true, used: 2 });
    const invoke = vi.fn().mockResolvedValue("still not json");

    await expect(
      mapExtractionWithModel(extracted("Alex Example"), meteredInvoke(invoke, charge)),
    ).rejects.toThrow("after one repair attempt");

    // Two calls burned real tokens, so both count against the allowance even
    // though the user never got an import out of them.
    expect(charge).toHaveBeenCalledTimes(2);
  });

  test("a model transport failure is never charged", async () => {
    const charge = vi.fn();
    const invoke = vi.fn().mockRejectedValue(new Error("network unavailable"));

    await expect(
      mapExtractionWithModel(extracted("Alex Example"), meteredInvoke(invoke, charge)),
    ).rejects.toThrow("network unavailable");

    expect(charge).not.toHaveBeenCalled();
  });

  test("a charge failure never fails the import (cap-race safety)", async () => {
    // The charge blowing up stands in for both a real mutation failure and the
    // cap racing shut between the pre-read and the charge: in either case the
    // model call already happened, so the finished work must be returned.
    const charge = vi.fn().mockRejectedValue(new Error("charge unavailable"));
    const invoke = vi
      .fn<(prompt: { system: string; user: string }) => Promise<string>>()
      .mockResolvedValue(
        modelResponse([{ lineId: "line-0001", targetPaths: ["/header/name"] }]),
      );

    const result = await mapExtractionWithModel(
      extracted("Alex Example"),
      meteredInvoke(invoke, charge),
    );

    expect(result.profile.header.name).toBe("Alex Example");
    expect(charge).toHaveBeenCalledTimes(1);
  });
});
