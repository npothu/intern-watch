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
    lines: texts.map((text, index) => {
      const id = `line-${String(index + 1).padStart(4, "0")}`;
      const runs = text ? [{ text, bold: false, italics: false }] : [];
      return {
        id,
        text,
        runs,
        segments: text
          ? [
              {
                id: `${id}-segment-0001`,
                text,
                boundaryBefore: "start",
                rightAligned: false,
                runs,
              },
            ]
          : [],
        bold: false,
        italics: false,
        hasTab: text.includes("\t"),
        rightTab: false,
        borderBottom: false,
        bullet: false,
      };
    }),
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
    expect(txtResult.lines[0].segments).toEqual([
      {
        id: "line-0001-segment-0001",
        text: "Alex Example",
        boundaryBefore: "start",
        rightAligned: false,
        runs: [{ text: "Alex Example", bold: false, italics: false }],
      },
    ]);
    expect(mdResult.lines[2].segments[0]).toMatchObject({
      id: "line-0003-segment-0001",
      text: "- Built a tool",
    });
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

  test("DOCX XML exposes stable formatted segments for tabs and explicit pipes", () => {
    const xml = `<w:document xmlns:w="urn:test"><w:body>
      <w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="10800"/></w:tabs></w:pPr>
        <w:r><w:rPr><w:b/></w:rPr><w:t>Example Co</w:t><w:tab/></w:r>
        <w:r><w:t>Atlanta, GA</w:t></w:r>
      </w:p>
      <w:p>
        <w:r><w:rPr><w:b/></w:rPr><w:t>Resume Importer</w:t></w:r>
        <w:r><w:t xml:space="preserve"> | </w:t></w:r>
        <w:r><w:rPr><w:i/></w:rPr><w:t>React, TypeScript</w:t></w:r>
      </w:p>
    </w:body></w:document>`;

    const lines = extractDocxXml(xml);

    expect(lines[0].segments).toEqual([
      {
        id: "line-0001-segment-0001",
        text: "Example Co",
        boundaryBefore: "start",
        rightAligned: false,
        runs: [{ text: "Example Co", bold: true, italics: false }],
      },
      {
        id: "line-0001-segment-0002",
        text: "Atlanta, GA",
        boundaryBefore: "tab",
        rightAligned: true,
        runs: [{ text: "Atlanta, GA", bold: false, italics: false }],
      },
    ]);
    expect(lines[1].segments).toEqual([
      expect.objectContaining({
        id: "line-0002-segment-0001",
        text: "Resume Importer",
        boundaryBefore: "start",
      }),
      expect.objectContaining({
        id: "line-0002-segment-0002",
        text: "React, TypeScript",
        boundaryBefore: "pipe",
      }),
    ]);
    expect(lines[1].segments[1].runs).toEqual([
      { text: "React, TypeScript", bold: false, italics: true },
    ]);
  });

  test.each([
    ["Project|React, TypeScript", ["Project", "React, TypeScript"]],
    ["Project |React, TypeScript", ["Project", "React, TypeScript"]],
    ["Project| React, TypeScript", ["Project", "React, TypeScript"]],
  ])("DOCX XML segments unspaced pipe layout in %s", (text, expected) => {
    const [line] = extractDocxXml(`<w:document xmlns:w="urn:test"><w:body>
      <w:p><w:r><w:t>${text}</w:t></w:r></w:p>
    </w:body></w:document>`);

    expect(line.segments.map((segment) => segment.text)).toEqual(expected);
    expect(line.segments[1].boundaryBefore).toBe("pipe");
  });

  test("right-tab paragraphs preserve space-aligned trailing columns", () => {
    const [line] = extractDocxXml(`<w:document xmlns:w="urn:test"><w:body>
      <w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="10800"/></w:tabs></w:pPr>
        <w:r><w:t xml:space="preserve">Flight Computer | C++, Linux, Docker                      Aug - December 2025</w:t></w:r>
      </w:p>
    </w:body></w:document>`);

    expect(line.segments.map((segment) => ({
      text: segment.text,
      boundaryBefore: segment.boundaryBefore,
      rightAligned: segment.rightAligned,
    }))).toEqual([
      {
        text: "Flight Computer",
        boundaryBefore: "start",
        rightAligned: false,
      },
      {
        text: "C++, Linux, Docker",
        boundaryBefore: "pipe",
        rightAligned: false,
      },
      {
        text: "Aug - December 2025",
        boundaryBefore: "tab",
        rightAligned: true,
      },
    ]);
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
  test("a null contact line is normalized to the contract's empty string", () => {
    const response = JSON.parse(modelResponse()) as {
      profile: { header: { contact_line: unknown } };
    };
    response.profile.header.contact_line = null;

    const result = validateModelOutput(JSON.stringify(response), extracted("Alex Example"));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.profile.header.contact_line).toBe("");
  });

  test("education institution fields cannot become a fabricated second degree", () => {
    const lines = extractDocxXml(`<w:document xmlns:w="urn:test"><w:body>
      <w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="10800"/></w:tabs></w:pPr>
        <w:r><w:rPr><w:b/></w:rPr><w:t>Georgia Institute of Technology</w:t></w:r>
        <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve"> | Atlanta, GA</w:t></w:r>
        <w:r><w:tab/><w:t>Expected Graduation May 2027</w:t></w:r>
      </w:p>
      <w:p><w:r><w:rPr><w:i/></w:rPr><w:t>B.S Computer Science / GPA 3.7</w:t></w:r></w:p>
      <w:p><w:r><w:rPr><w:i/></w:rPr><w:t>Concentrations: Systems and Architecture &amp; Information Internetworks</w:t></w:r></w:p>
    </w:body></w:document>`);
    const importedProfile: ProfileV2 = {
      ...profile,
      skills: {},
      sections: [
        {
          id: "education",
          title: "Education",
          kind: "education",
          entries: [
            {
              id: "georgia-tech",
              heading: "Georgia Institute of Technology",
              location: "Atlanta, GA",
              date: "Expected Graduation May 2027",
              degrees: [
                {
                  degree: "B.S Computer Science",
                  concentration:
                    "Systems and Architecture & Information Internetworks",
                  grad_date: "May 2027",
                  gpa: "3.7",
                },
                {
                  degree: "Georgia Institute of Technology",
                  concentration: "Atlanta, GA",
                  grad_date: "May 2028",
                },
              ],
              bullets: { base: [] },
            },
          ],
        },
      ],
    };
    const result = validateModelOutput(
      modelResponse(
        lines.map((line) => ({
          lineId: line.id,
          targetPaths: ["/sections/0/entries/0/degrees"],
        })),
        importedProfile,
      ),
      { format: "docx", filename: "resume.docx", lines },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const errors = result.errors.join("\n");
      expect(errors).toMatch(/education.*degree.*institution/i);
      expect(errors).toMatch(/education.*concentration.*location/i);
      expect(errors).toMatch(/education.*graduation.*source/i);
    }
  });

  test("labeled education coursework cannot be accepted as an entry bullet", () => {
    const coursework =
      "Coursework: Operating Systems, Compilers & Interpreters, Computer Organization";
    const importedProfile: ProfileV2 = {
      ...profile,
      skills: {},
      sections: [
        {
          id: "education",
          title: "Education",
          kind: "education",
          entries: [
            {
              id: "georgia-tech",
              heading: "Georgia Institute of Technology",
              date: "May 2027",
              degrees: [
                {
                  degree: "B.S Computer Science",
                  grad_date: "May 2027",
                },
              ],
              bullets: { base: [coursework] },
            },
          ],
        },
      ],
    };
    const result = validateModelOutput(
      modelResponse(
        [
          {
            lineId: "line-0004",
            targetPaths: ["/sections/0/entries/0/bullets/base/0"],
          },
        ],
        importedProfile,
      ),
      extracted(
        "Georgia Institute of Technology",
        "Expected Graduation May 2027",
        "B.S Computer Science",
        coursework,
      ),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(
        /coursework.*top-level skills\.coursework/i,
      );
    }
  });

  test("experience columns cannot be accepted in the wrong semantic fields", () => {
    const extraction = extracted(
      "Example Co\tAtlanta, GA",
      "Engineering Intern\tSummer 2026",
    );
    const misplacedProfile: ProfileV2 = {
      ...profile,
      sections: [
        {
          ...profile.sections[0],
          entries: [
            {
              ...profile.sections[0].entries[0],
              heading: "Example Co | Atlanta, GA",
              subheading: "",
              location: "",
              date: "Engineering Intern | Summer 2026",
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
            targetPaths: ["/sections/0/entries/0/heading"],
          },
          {
            lineId: "line-0002",
            targetPaths: ["/sections/0/entries/0/date"],
          },
        ],
        misplacedProfile,
      ),
      extraction,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/experience.*heading.*location/i);
      expect(result.errors.join("\n")).toMatch(/experience.*date.*role/i);
    }
  });

  test("project technology columns cannot remain in the project heading", () => {
    const extraction = extracted(
      "Resume Importer | React, TypeScript, PostgreSQL, Docker",
    );
    const misplacedProfile: ProfileV2 = {
      ...profile,
      sections: [
        {
          id: "projects",
          title: "Projects",
          kind: "projects",
          entries: [
            {
              id: "resume-importer",
              heading: "Resume Importer | React, TypeScript, PostgreSQL, Docker",
              tech: [],
              date: "",
              bullets: { base: [] },
            },
          ],
        },
      ],
    };

    const result = validateModelOutput(
      modelResponse(
        [
          {
            lineId: "line-0001",
            targetPaths: ["/sections/0/entries/0/heading"],
          },
        ],
        misplacedProfile,
      ),
      extraction,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/project.*heading.*tech/i);
    }
  });

  test("experience fields are inferred only from credibly mapped source lines", () => {
    const lines = extractDocxXml(`<w:document xmlns:w="urn:test"><w:body>
      <w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="10800"/></w:tabs></w:pPr>
        <w:r><w:t>Example Co</w:t><w:tab/><w:t>Atlanta, GA</w:t></w:r>
      </w:p>
      <w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="10800"/></w:tabs></w:pPr>
        <w:r><w:t>Engineering Intern</w:t><w:tab/><w:t>Summer 2026</w:t></w:r>
      </w:p>
    </w:body></w:document>`);
    const extraction: ExtractedResume = {
      format: "docx",
      filename: "resume.docx",
      lines,
    };
    const incompleteProfile: ProfileV2 = {
      ...profile,
      sections: [
        {
          ...profile.sections[0],
          entries: [
            {
              ...profile.sections[0].entries[0],
              heading: "Example Co",
              subheading: "",
              location: "",
              date: "",
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
            targetPaths: ["/sections/0/entries/0/heading"],
          },
          {
            lineId: "line-0002",
            targetPaths: ["/sections/0/entries/0/date"],
          },
        ],
        incompleteProfile,
      ),
      extraction,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const errors = result.errors.join("\n");
      expect(errors).toMatch(/experience.*location.*source segment/i);
      expect(errors).not.toMatch(/experience.*role.*source segment/i);
      expect(errors).not.toMatch(/experience.*date.*source segment/i);
    }
  });

  test.each([
    ["role", "", "Summer 2026", "/sections/0/entries/0/date"],
    ["date", "Engineering Intern", "", "/sections/0/entries/0/subheading"],
  ])(
    "experience %s cannot be omitted from a credibly mapped role and date line",
    (missingField, subheading, date, targetPath) => {
      const [line] = extractDocxXml(`<w:document xmlns:w="urn:test"><w:body>
        <w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="10800"/></w:tabs></w:pPr>
          <w:r><w:t>Engineering Intern</w:t><w:tab/><w:t>Summer 2026</w:t></w:r>
        </w:p>
      </w:body></w:document>`);
      const incompleteProfile: ProfileV2 = {
        ...profile,
        sections: [
          {
            ...profile.sections[0],
            entries: [
              {
                ...profile.sections[0].entries[0],
                subheading,
                date,
              },
            ],
          },
          profile.sections[1],
        ],
      };
      const result = validateModelOutput(
        modelResponse(
          [{ lineId: "line-0001", targetPaths: [targetPath] }],
          incompleteProfile,
        ),
        { format: "docx", filename: "resume.docx", lines: [line] },
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join("\n")).toMatch(
          new RegExp(`experience.*${missingField}.*source segment`, "i"),
        );
      }
    },
  );

  test("project tech and date required by clear source segments cannot be omitted", () => {
    const [line] = extractDocxXml(`<w:document xmlns:w="urn:test"><w:body>
      <w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="10800"/></w:tabs></w:pPr>
        <w:r><w:t>Resume Importer</w:t></w:r>
        <w:r><w:t xml:space="preserve"> | </w:t></w:r>
        <w:r><w:t>React, TypeScript</w:t><w:tab/><w:t>Summer 2026</w:t></w:r>
      </w:p>
    </w:body></w:document>`);
    const extraction: ExtractedResume = {
      format: "docx",
      filename: "resume.docx",
      lines: [line],
    };
    const incompleteProfile: ProfileV2 = {
      ...profile,
      sections: [
        {
          id: "projects",
          title: "Projects",
          kind: "projects",
          entries: [
            {
              id: "resume-importer",
              heading: "Resume Importer",
              tech: [],
              date: "",
              bullets: { base: [] },
            },
          ],
        },
      ],
    };

    const result = validateModelOutput(
      modelResponse(
        [
          {
            lineId: "line-0001",
            targetPaths: ["/sections/0/entries/0/heading"],
          },
        ],
        incompleteProfile,
      ),
      extraction,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const errors = result.errors.join("\n");
      expect(errors).toMatch(/project.*tech.*source segment/i);
      expect(errors).toMatch(/project.*date.*source segment/i);
    }
  });

  test("tab-separated project technology cannot be omitted", () => {
    const [line] = extractDocxXml(`<w:document xmlns:w="urn:test"><w:body>
      <w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="10800"/></w:tabs></w:pPr>
        <w:r><w:t>Resume Importer</w:t><w:tab/><w:t>React, TypeScript</w:t><w:tab/><w:t>Summer 2026</w:t></w:r>
      </w:p>
    </w:body></w:document>`);
    const incompleteProfile: ProfileV2 = {
      ...profile,
      sections: [
        {
          id: "projects",
          title: "Projects",
          kind: "projects",
          entries: [
            {
              id: "resume-importer",
              heading: "Resume Importer",
              tech: [],
              date: "Summer 2026",
              bullets: { base: [] },
            },
          ],
        },
      ],
    };
    const result = validateModelOutput(
      modelResponse(
        [
          {
            lineId: "line-0001",
            targetPaths: [
              "/sections/0/entries/0/heading",
              "/sections/0/entries/0/date",
            ],
          },
        ],
        incompleteProfile,
      ),
      { format: "docx", filename: "resume.docx", lines: [line] },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/project.*tech.*source segment/i);
    }
  });

  test.each([
    ["May Mobility", "Ann Arbor, MI"],
    ["March of Dimes", "Arlington, VA"],
  ])("company name %s is not mistaken for a date", (organization, location) => {
    const [line] = extractDocxXml(`<w:document xmlns:w="urn:test"><w:body>
      <w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="10800"/></w:tabs></w:pPr>
        <w:r><w:t>${organization}</w:t><w:tab/><w:t>${location}</w:t></w:r>
      </w:p>
    </w:body></w:document>`);
    const importedProfile: ProfileV2 = {
      ...profile,
      sections: [
        {
          ...profile.sections[0],
          entries: [
            {
              ...profile.sections[0].entries[0],
              heading: organization,
              location,
              date: "",
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
            targetPaths: ["/sections/0/entries/0/heading"],
          },
        ],
        importedProfile,
      ),
      { format: "docx", filename: "resume.docx", lines: [line] },
    );

    expect(result.ok).toBe(true);
  });

  test.each(["Hybrid Cloud Engineer", "Summer Associate"])(
    "job title %s is not mistaken for a location or date",
    (role) => {
      const [line] = extractDocxXml(`<w:document xmlns:w="urn:test"><w:body>
        <w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="10800"/></w:tabs></w:pPr>
          <w:r><w:t>${role}</w:t><w:tab/><w:t>June 2026</w:t></w:r>
        </w:p>
      </w:body></w:document>`);
      const importedProfile: ProfileV2 = {
        ...profile,
        sections: [
          {
            ...profile.sections[0],
            entries: [
              {
                ...profile.sections[0].entries[0],
                subheading: role,
                location: "",
                date: "June 2026",
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
              targetPaths: [
                "/sections/0/entries/0/subheading",
                "/sections/0/entries/0/date",
              ],
            },
          ],
          importedProfile,
        ),
        { format: "docx", filename: "resume.docx", lines: [line] },
      );

      expect(result.ok).toBe(true);
    },
  );

  test("a technology containing a year is not mistaken for a project date", () => {
    const [line] = extractDocxXml(`<w:document xmlns:w="urn:test"><w:body>
      <w:p><w:r><w:t>Migration Tool | Visual Studio 2022, .NET</w:t></w:r></w:p>
    </w:body></w:document>`);
    const importedProfile: ProfileV2 = {
      ...profile,
      sections: [
        {
          id: "projects",
          title: "Projects",
          kind: "projects",
          entries: [
            {
              id: "migration-tool",
              heading: "Migration Tool",
              tech: ["Visual Studio 2022", ".NET"],
              date: "",
              bullets: { base: [] },
            },
          ],
        },
      ],
    };
    const result = validateModelOutput(
      modelResponse(
        [
          {
            lineId: "line-0001",
            targetPaths: [
              "/sections/0/entries/0/heading",
              "/sections/0/entries/0/tech",
            ],
          },
        ],
        importedProfile,
      ),
      { format: "docx", filename: "resume.docx", lines: [line] },
    );

    expect(result.ok).toBe(true);
  });

  test("dates cannot remain embedded in semantic experience name fields", () => {
    const misplacedProfile: ProfileV2 = {
      ...profile,
      sections: [
        {
          ...profile.sections[0],
          entries: [
            {
              ...profile.sections[0].entries[0],
              heading: "Example Co | Summer 2026",
              date: "",
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
            targetPaths: ["/sections/0/entries/0/heading"],
          },
        ],
        misplacedProfile,
      ),
      extracted("Example Co | Summer 2026"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/experience.*date.*heading/i);
    }
  });

  test("ambiguous experience field placement is returned as a semantic warning", () => {
    const suspiciousProfile: ProfileV2 = {
      ...profile,
      sections: [
        {
          ...profile.sections[0],
          entries: [
            {
              ...profile.sections[0].entries[0],
              heading: "Example Co, Atlanta, GA",
              location: "",
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
            targetPaths: ["/sections/0/entries/0/heading"],
          },
        ],
        suspiciousProfile,
      ),
      extracted("Example Co, Atlanta, GA"),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.semanticWarnings.join("\n")).toMatch(
        /experience.*heading.*location/i,
      );
    }
  });

  test("date and location words in bullet prose do not force header fields", () => {
    const [line] = extractDocxXml(`<w:document xmlns:w="urn:test"><w:body>
      <w:p><w:pPr><w:numPr/></w:pPr>
        <w:r><w:t>Collaborated remotely during Summer 2026</w:t></w:r>
      </w:p>
    </w:body></w:document>`);
    const extraction: ExtractedResume = {
      format: "docx",
      filename: "resume.docx",
      lines: [line],
    };
    const undatedProfile: ProfileV2 = {
      ...profile,
      sections: [
        {
          ...profile.sections[0],
          entries: [
            {
              ...profile.sections[0].entries[0],
              location: "",
              date: "",
              bullets: { base: ["Collaborated remotely during Summer 2026"] },
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
        undatedProfile,
      ),
      extraction,
    );

    expect(result.ok).toBe(true);
  });

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

  test("field-level mappings preserve valid source segment provenance", () => {
    const [line] = extractDocxXml(`<w:document xmlns:w="urn:test"><w:body>
      <w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="10800"/></w:tabs></w:pPr>
        <w:r><w:t>Example Co</w:t><w:tab/><w:t>Atlanta, GA</w:t></w:r>
      </w:p>
    </w:body></w:document>`);
    const extraction: ExtractedResume = {
      format: "docx",
      filename: "resume.docx",
      lines: [line],
    };
    const locatedProfile: ProfileV2 = {
      ...profile,
      sections: [
        {
          ...profile.sections[0],
          entries: [
            {
              ...profile.sections[0].entries[0],
              heading: "Example Co",
              location: "Atlanta, GA",
            },
          ],
        },
        profile.sections[1],
      ],
    };

    const result = validateModelOutput(
      JSON.stringify({
        profile: locatedProfile,
        mappings: [
          {
            lineId: "line-0001",
            targetPaths: ["/sections/0/entries/0/heading"],
            segmentMappings: [
              {
                segmentId: "line-0001-segment-0001",
                targetPaths: ["/sections/0/entries/0/heading"],
              },
              {
                segmentId: "line-0001-segment-0002",
                targetPaths: ["/sections/0/entries/0/location"],
              },
            ],
          },
        ],
      }),
      extraction,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mappings[0].segmentMappings).toEqual([
        {
          segmentId: "line-0001-segment-0001",
          targetPaths: ["/sections/0/entries/0/heading"],
        },
        {
          segmentId: "line-0001-segment-0002",
          targetPaths: ["/sections/0/entries/0/location"],
        },
      ]);
      expect(result.value.fullyMappedLines).toEqual([
        { id: "line-0001", text: "Example Co\tAtlanta, GA" },
      ]);
      expect(result.value.partialMappedLines).toEqual([]);
    }
  });

  test("valid segment targets retain a mapping when its aggregate target is stale", () => {
    const [line] = extractDocxXml(`<w:document xmlns:w="urn:test"><w:body>
      <w:p><w:r><w:t>Example Co</w:t></w:r></w:p>
    </w:body></w:document>`);
    const result = validateModelOutput(
      JSON.stringify({
        profile,
        mappings: [
          {
            lineId: "line-0001",
            targetPaths: ["/missing"],
            segmentMappings: [
              {
                segmentId: "line-0001-segment-0001",
                targetPaths: ["/sections/0/entries/0/heading"],
              },
            ],
          },
        ],
      }),
      { format: "docx", filename: "resume.docx", lines: [line] },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mappings).toHaveLength(1);
      expect(result.value.mappings[0].targetPaths).toEqual([]);
      expect(result.value.fullyMappedLines).toEqual([
        { id: "line-0001", text: "Example Co" },
      ]);
    }
  });

  test("stale entry mappings cannot trigger source-backed semantic errors", () => {
    const [line] = extractDocxXml(`<w:document xmlns:w="urn:test"><w:body>
      <w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="10800"/></w:tabs></w:pPr>
        <w:r><w:t>Unrelated Co</w:t><w:tab/><w:t>Atlanta, GA</w:t></w:r>
      </w:p>
    </w:body></w:document>`);
    const extraction: ExtractedResume = {
      format: "docx",
      filename: "resume.docx",
      lines: [line],
    };

    const result = validateModelOutput(
      modelResponse([
        {
          lineId: "line-0001",
          targetPaths: ["/sections/0/entries/0/heading/missing"],
        },
      ]),
      extraction,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.mappings).toEqual([]);
      expect(result.value.unmappedLines).toEqual([
        { id: "line-0001", text: "Unrelated Co\tAtlanta, GA" },
      ]);
    }
  });

  test.each([
    "/sections/0/entries/0/heading",
    "/sections/0/entries/0/bullets/base/0",
  ])("unrelated content mapped to %s cannot trigger semantic errors", (targetPath) => {
    const [line] = extractDocxXml(`<w:document xmlns:w="urn:test"><w:body>
      <w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="10800"/></w:tabs></w:pPr>
        <w:r><w:t>Other Co</w:t><w:tab/><w:t>Atlanta, GA</w:t></w:r>
      </w:p>
    </w:body></w:document>`);
    const mappedProfile: ProfileV2 = {
      ...profile,
      sections: [
        {
          ...profile.sections[0],
          entries: [
            {
              ...profile.sections[0].entries[0],
              location: "",
              bullets: { base: ["Other Co Atlanta, GA"] },
            },
          ],
        },
        profile.sections[1],
      ],
    };
    const result = validateModelOutput(
      modelResponse([{ lineId: "line-0001", targetPaths: [targetPath] }], mappedProfile),
      { format: "docx", filename: "resume.docx", lines: [line] },
    );

    expect(result.ok).toBe(true);
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
    }
  });
});

describe("resume import prompt and repair", () => {
  test("community sections import with the community kind without a repair call", async () => {
    const communityProfile: ProfileV2 = {
      ...profile,
      sections: [
        ...profile.sections,
        {
          id: "sec-community",
          title: "Community",
          kind: "experience",
          entries: [
            {
              id: "peer-mentor",
              heading: "Peer Mentor",
              date: "2026",
              bullets: { base: ["Mentored local students"] },
            },
          ],
        },
      ],
    };
    const extraction = extracted("Community", "Peer Mentor", "Mentored local students");
    const invoke = vi.fn().mockResolvedValue(modelResponse([], communityProfile));

    const result = await mapExtractionWithModel(extraction, invoke);

    expect(result.profile.sections.at(-1)?.kind).toBe("community");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("singular project section kinds import as ProfileV2 projects", async () => {
    const projectProfile = {
      ...profile,
      sections: [
        {
          id: "sec-projects",
          title: "Programming Projects",
          kind: "project",
          entries: [
            {
              id: "importer",
              heading: "Resume Importer",
              date: "2026",
              bullets: { base: ["Imported DOCX resumes"] },
            },
          ],
        },
      ],
    };
    const invoke = vi.fn().mockResolvedValue(
      JSON.stringify({ profile: projectProfile, mappings: [] }),
    );

    const result = await mapExtractionWithModel(extracted("Programming Projects"), invoke);

    expect(result.profile.sections[0].kind).toBe("projects");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("unknown section kinds remain invalid instead of becoming custom sections", () => {
    const result = validateModelOutput(
      JSON.stringify({
        profile: {
          ...profile,
          sections: [
            {
              ...profile.sections[0],
              id: "research",
              title: "Research",
              kind: "experiance",
            },
          ],
        },
        mappings: [],
      }),
      extracted("Research"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain(
        "profile.sections[0].kind must be a ProfileV2 section kind",
      );
    }
  });

  test("stale mapping targets do not reject an otherwise valid profile", async () => {
    const extraction = extracted("Alex Example");
    const invoke = vi.fn().mockResolvedValue(
      modelResponse([{ lineId: "line-0001", targetPaths: ["/sections/99/title"] }]),
    );

    const result = await mapExtractionWithModel(extraction, invoke);

    expect(result.mappings).toEqual([]);
    expect(result.unmappedLines).toEqual([{ id: "line-0001", text: "Alex Example" }]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("response-rooted profile pointers import as profile-relative mappings", async () => {
    const extraction = extracted("Alex Example");
    const invoke = vi.fn().mockResolvedValue(
      modelResponse([{ lineId: "line-0001", targetPaths: ["/profile/header/name"] }]),
    );

    const result = await mapExtractionWithModel(extraction, invoke);

    expect(result.mappings[0].targetPaths).toEqual(["/header/name"]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("display skill categories import as canonical ProfileV2 keys", async () => {
    const extraction = extracted("Languages: C#", "Systems & Tools: Git");
    const invoke = vi.fn().mockResolvedValue(
      JSON.stringify({
        profile: {
          ...profile,
          skills: {
            Languages: ["C#"],
            "Systems & Tools": ["Git"],
          },
        },
        mappings: [
          { lineId: "line-0001", targetPaths: ["/skills/Languages"] },
          { lineId: "line-0002", targetPaths: ["/skills/Systems & Tools/0"] },
        ],
      }),
    );

    const result = await mapExtractionWithModel(extraction, invoke);

    expect(result.profile.skills).toEqual({ languages: ["C#"], tools: ["Git"] });
    expect(result.mappings.map((mapping) => mapping.targetPaths)).toEqual([
      ["/skills/languages"],
      ["/skills/tools/0"],
    ]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("conflicting link labels remain invalid model output", () => {
    const result = validateModelOutput(
      JSON.stringify({
        profile: {
          ...profile,
          header: {
            ...profile.header,
            links: [
              {
                text: "LinkedIn",
                label: "Professional profile",
                url: "https://linkedin.com/in/alex",
              },
            ],
          },
        },
        mappings: [],
      }),
      extracted("LinkedIn https://linkedin.com/in/alex"),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toContain("profile.header.links[0].label is not part of ProfileV2");
    }
  });

  test("prompt names the exact ProfileV2 header link fields", () => {
    const prompt = buildImportPrompt(extracted("LinkedIn https://linkedin.com/in/alex"));

    expect(prompt.system).toContain("header.links items use exactly {text,url}");
    expect(prompt.system).toContain(
      "skills uses only coursework, languages, tools, and certifications",
    );
    expect(prompt.system).toContain("targetPaths must not start with /profile/");
    expect(prompt.system).toContain(
      "Map work authorization or citizenship text to header.citizen_prefix",
    );
    expect(prompt.system).toContain(
      "Use kind community for Community sections",
    );
    expect(prompt.system).toContain(
      "kind must be one of education, experience, projects, community, skills, or custom",
    );
  });

  test("prompt defines section semantics and field-level source provenance", () => {
    const prompt = buildImportPrompt(extracted("Example Co | Atlanta, GA"));

    expect(prompt.system).toContain(
      "Experience: heading is the organization, subheading is the role, location is the place, and date is the employment period",
    );
    expect(prompt.system).toContain(
      "Projects: heading is only the project name, tech is the explicit technology list, and date is only the project period",
    );
    expect(prompt.system).toContain("Education:");
    expect(prompt.system).toContain(
      "Create one education entry per institution and one degree item per explicit degree credential",
    );
    expect(prompt.system).toContain(
      "Multiple concentrations for one degree stay together in that degree's concentration string",
    );
    expect(prompt.system).toContain(
      "Never create a degree from an institution, location, or graduation date",
    );
    expect(prompt.system).toContain("Community:");
    expect(prompt.system).toContain("Skills:");
    expect(prompt.system).toContain(
      "Tabs and pipe separators are layout evidence, not literal heading content",
    );
    expect(prompt.system).toContain("Incorrect:");
    expect(prompt.system).toContain("Correct:");
    expect(prompt.system).toContain("segmentMappings");
    expect(prompt.system).toContain("segmentId");
    expect(prompt.system).toContain("contact_line");
    expect(prompt.system).toContain("empty string");
  });

  test("common link labels import as ProfileV2 link text without a repair call", async () => {
    const extraction = extracted(
      "LinkedIn https://linkedin.com/in/alex",
      "GitHub https://github.com/alex",
    );
    const invoke = vi.fn().mockResolvedValue(
      JSON.stringify({
        profile: {
          ...profile,
          header: {
            ...profile.header,
            links: [
              { label: "LinkedIn", url: "https://linkedin.com/in/alex" },
              { text: "GitHub", url: "https://github.com/alex" },
            ],
          },
        },
        mappings: [
          {
            lineId: "line-0001",
            targetPaths: ["/header/links/0/label", "/header/links/0/url"],
          },
          {
            lineId: "line-0002",
            targetPaths: ["/header/links/1/text", "/header/links/1/url"],
          },
        ],
      }),
    );

    const result = await mapExtractionWithModel(extraction, invoke);

    expect(result.profile.header.links).toEqual([
      { text: "LinkedIn", url: "https://linkedin.com/in/alex" },
      { text: "GitHub", url: "https://github.com/alex" },
    ]);
    expect(result.mappings.map((mapping) => mapping.targetPaths)).toEqual([
      ["/header/links/0/text", "/header/links/0/url"],
      ["/header/links/1/text", "/header/links/1/url"],
    ]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

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

  test("prompt serialization does not duplicate line and segment text", () => {
    const extraction = extracted("x".repeat(30_000));
    expect(JSON.stringify(extraction).length).toBeGreaterThan(
      MAX_EXTRACTION_PAYLOAD_CHARS,
    );

    expect(() => buildImportPrompt(extraction)).not.toThrow();
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

  test("semantic placement failures receive one actionable repair call", async () => {
    const extraction = extracted(
      "Example Co | Atlanta, GA",
      "Engineering Intern | Summer 2026",
    );
    const misplacedProfile: ProfileV2 = {
      ...profile,
      sections: [
        {
          ...profile.sections[0],
          entries: [
            {
              ...profile.sections[0].entries[0],
              heading: "Example Co | Atlanta, GA",
              subheading: "",
              location: "",
              date: "Engineering Intern | Summer 2026",
            },
          ],
        },
        profile.sections[1],
      ],
    };
    const repairedProfile: ProfileV2 = {
      ...profile,
      sections: [
        {
          ...profile.sections[0],
          entries: [
            {
              ...profile.sections[0].entries[0],
              heading: "Example Co",
              subheading: "Engineering Intern",
              location: "Atlanta, GA",
              date: "Summer 2026",
            },
          ],
        },
        profile.sections[1],
      ],
    };
    const invoke = vi
      .fn<(prompt: { system: string; user: string }) => Promise<string>>()
      .mockResolvedValueOnce(
        modelResponse(
          [
            {
              lineId: "line-0001",
              targetPaths: ["/sections/0/entries/0/heading"],
            },
            {
              lineId: "line-0002",
              targetPaths: ["/sections/0/entries/0/date"],
            },
          ],
          misplacedProfile,
        ),
      )
      .mockResolvedValueOnce(modelResponse([], repairedProfile));

    const result = await mapExtractionWithModel(extraction, invoke);

    expect(result.profile.sections[0].entries[0]).toMatchObject({
      heading: "Example Co",
      subheading: "Engineering Intern",
      location: "Atlanta, GA",
      date: "Summer 2026",
    });
    expect(invoke).toHaveBeenCalledTimes(2);
    const repairPrompt = invoke.mock.calls[1][0].user;
    expect(repairPrompt).toContain("experience heading contains a location column");
    expect(repairPrompt).toContain("Preserve valid entries and content");
    expect(repairPrompt).toContain("semantic fields");
    expect(repairPrompt).toContain("segment mappings");
  });

  test("fabricated education degrees receive one actionable repair call", async () => {
    const extraction = extracted(
      "Georgia Institute of Technology",
      "Atlanta, GA",
      "Expected Graduation May 2027",
      "B.S Computer Science / GPA 3.7",
      "Concentrations: Systems and Architecture & Information Internetworks",
    );
    const educationEntry = {
      id: "georgia-tech",
      heading: "Georgia Institute of Technology",
      location: "Atlanta, GA",
      date: "Expected Graduation May 2027",
      bullets: { base: [] as string[] },
    };
    const misplacedProfile: ProfileV2 = {
      ...profile,
      skills: {},
      sections: [
        {
          id: "education",
          title: "Education",
          kind: "education",
          entries: [
            {
              ...educationEntry,
              degrees: [
                {
                  degree: "B.S Computer Science",
                  concentration:
                    "Systems and Architecture & Information Internetworks",
                  grad_date: "May 2027",
                  gpa: "3.7",
                },
                {
                  degree: "Georgia Institute of Technology",
                  concentration: "Atlanta, GA",
                  grad_date: "May 2028",
                },
              ],
            },
          ],
        },
      ],
    };
    const repairedProfile: ProfileV2 = {
      ...misplacedProfile,
      sections: [
        {
          ...misplacedProfile.sections[0],
          entries: [
            {
              ...educationEntry,
              degrees: [misplacedProfile.sections[0].entries[0].degrees![0]],
            },
          ],
        },
      ],
    };
    const mappings = extraction.lines.map((line) => ({
      lineId: line.id,
      targetPaths: ["/sections/0/entries/0/degrees"],
    }));
    const invoke = vi
      .fn<(prompt: { system: string; user: string }) => Promise<string>>()
      .mockResolvedValueOnce(modelResponse(mappings, misplacedProfile))
      .mockResolvedValueOnce(modelResponse(mappings, repairedProfile));

    const result = await mapExtractionWithModel(extraction, invoke);

    expect(result.profile.sections[0].entries[0].degrees).toEqual([
      {
        degree: "B.S Computer Science",
        concentration: "Systems and Architecture & Information Internetworks",
        grad_date: "May 2027",
        gpa: "3.7",
      },
    ]);
    expect(invoke).toHaveBeenCalledTimes(2);
    const repairPrompt = invoke.mock.calls[1][0].user;
    expect(repairPrompt).toContain("education degree repeats the institution");
    expect(repairPrompt).toContain("education concentration repeats the location");
    expect(repairPrompt).toContain("education graduation date is not supported");
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
