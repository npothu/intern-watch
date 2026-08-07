import { describe, expect, test } from "vitest";
import { Document } from "docx";
import {
  applyRewrites,
  assemblePrompt,
  buildProjectPayload,
  capFor,
  parseRewrites,
} from "./resume_prompt";
import {
  composeResumeDoc,
  resumeFilename,
  resumeOutline,
  type Profile,
} from "./resume_docx";

// Pure-part tests for the Convex-native resume builder: the LLM prompt
// assembly (port of src/resume/tailor.py) and the .docx section composition
// (port of src/resume/render.py). These are the deterministic surfaces of the
// pipeline and are tested here without a Convex backend.

// A compact, representative profile (mirrors tests/fixtures/resume_bank.json
// shape: header/education/skills/work/projects/community).
const PROFILE: Profile = {
  header: {
    name: "Alex Example",
    contact_line: "Atlanta, Georgia 30332 | alex@example.com",
    citizen_prefix: "US Citizen | ",
    links: [
      { text: "linkedin.com/in/alex", url: "https://linkedin.com/in/alex" },
    ],
  },
  education: {
    institution: "Georgia Institute of Technology | Atlanta, GA",
    grad_date: "Expected Graduation May 2027",
    degree: "B.S Computer Science",
    threads: "Concentrations: Systems & AI",
    gpa: "GPA 3.7/4.0",
  },
  skills: {
    coursework: ["Operating Systems", "Data Structures & Algorithms"],
    languages: ["C", "Python", "TypeScript"],
    tools: ["Docker", "React"],
    certifications: ["AWS Cloud Practitioner"],
  },
  work_experience: {
    "Acme Corp": {
      location: "Atlanta, GA",
      role: "Software Intern",
      date: "Summer 2026",
      bullets: {
        base: ["Built features for a web platform using React and FastAPI."],
      },
    },
  },
  projects: {
    "Simple Prep": {
      tech: ["React", "TypeScript"],
      date: "Fall 2025",
      tags: ["full-stack"],
      bullets: {
        base: ["Developed a meal planning platform with REST APIs."],
      },
    },
  },
  community: {
    "Teaching Assistant": {
      heading_runs: [{ text: "Teaching Assistant (", bold: true }],
      date: "2025–2026",
      bullets: { base: ["Guides students in low-level systems code."] },
    },
  },
};

const CONTENT = {
  projects: [
    {
      name: "Simple Prep",
      tech: "React, TypeScript",
      date: "Fall 2025",
      bullets: ["Developed a meal planning platform with REST APIs."],
    },
  ],
};

describe("resume_prompt: capFor / payload / prompt (tailor.py port)", () => {
  test("capFor floors at CAP_FLOOR and adds CAP_SLACK", () => {
    expect(capFor("short")).toBe(140);
    const long = "x".repeat(200);
    expect(capFor(long)).toBe(215);
  });

  test("buildProjectPayload attaches per-bullet max_chars", () => {
    const payload = buildProjectPayload([
      { name: "P", tech: "React", bullets: ["abc"] },
    ]);
    expect(payload[0].name).toBe("P");
    expect(payload[0].tech).toBe("React");
    expect(payload[0].bullets[0]).toEqual({ text: "abc", max_chars: 140 });
  });

  test("assemblePrompt ports the tailor system prompt and includes the JD + payload", () => {
    const { system, user } = assemblePrompt("Backend role. Python. Docker.", [
      { name: "P", tech: "React", bullets: [{ text: "abc", max_chars: 140 }] },
    ]);
    expect(system).toContain("You are a resume bullet editor");
    expect(system).toContain('Respond with ONLY a JSON array');
    expect(user).toContain("Backend role. Python. Docker.");
    expect(user).toContain('"name": "P"');
    expect(user).toContain('"max_chars": 140');
    expect(user).toContain("copy project name exactly");
  });

  test("parseRewrites strips code fences and extracts the JSON array", () => {
    const text = '```json\n[{"name":"P","bullets":["b1"]}]\n```';
    expect(parseRewrites(text)).toEqual([{ name: "P", bullets: ["b1"] }]);
    expect(() => parseRewrites("no array here")).toThrow();
  });

  test("applyRewrites applies valid rewrites and falls back on over-length", () => {
    const projects = [
      { name: "P", bullets: ["original bullet text"] },
    ];
    const good = [{ name: "P", bullets: ["rewritten"] }];
    const applied = applyRewrites(projects, good);
    expect(applied.projects[0].bullets).toEqual(["rewritten"]);
    expect(applied.projects[0].llmRewritten).toBe(true);

    // Over-length rewrite reverts to the original bullet.
    const long = "x".repeat(600);
    const over = applyRewrites(projects, [{ name: "P", bullets: [long] }]);
    expect(over.projects[0].bullets).toEqual(["original bullet text"]);
    expect(over.projects[0].llmRewritten).toBe(false);
    expect(over.notes.some((n) => n.includes("over-length"))).toBe(true);

    // Mismatched bullet count is rejected, not applied.
    const bad = applyRewrites(projects, [{ name: "P", bullets: ["a", "b"] }]);
    expect(bad.projects[0].bullets).toEqual(["original bullet text"]);
  });
});

describe("resume_docx: section composition (render.py port)", () => {
  test("outline renders header, sections and content in the expected order", () => {
    const lines = resumeOutline(PROFILE, CONTENT);
    // Header block first.
    expect(lines[0]).toBe("Alex Example");
    expect(lines[1]).toBe("Atlanta, Georgia 30332 | alex@example.com");
    expect(lines[2]).toContain("linkedin.com/in/alex");

    const idx = {
      edu: lines.indexOf("Education"),
      work: lines.indexOf("Work Experience"),
      projects: lines.indexOf("Programming Projects"),
      community: lines.indexOf("Community"),
      skills: lines.indexOf("Skills"),
    };
    expect(idx.edu).toBeGreaterThan(-1);
    expect(idx.projects).toBeGreaterThan(-1);
    expect(idx.community).toBeGreaterThan(-1);
    expect(idx.skills).toBeGreaterThan(-1);
    // Sections appear in render.py.order: Education, Work, Projects, Community, Skills.
    expect(idx.edu).toBeLessThan(idx.work);
    expect(idx.work).toBeLessThan(idx.projects);
    expect(idx.projects).toBeLessThan(idx.community);
    expect(idx.community).toBeLessThan(idx.skills);

    // Projects: the tailored project heading + its bullet render.
    expect(lines[idx.projects + 1]).toContain("Simple Prep");
    expect(lines[idx.projects + 1]).toContain("React, TypeScript");
    expect(
      lines.some((l) => l.includes("Developed a meal planning platform")),
    ).toBe(true);

    // Skills lines.
    expect(lines.some((l) => l.startsWith("Languages:") && l.includes("Python"))).toBe(true);
    expect(lines.some((l) => l.startsWith("Certifications:") && l.includes("AWS"))).toBe(true);
  });

  test("composeResumeDoc returns a docx Document with one section", () => {
    const doc = composeResumeDoc(PROFILE, CONTENT);
    expect(doc).toBeInstanceOf(Document);
    expect(() => doc).not.toThrow();
  });

  test("resumeFilename is First_Last_Company.docx (build.py out_name)", () => {
    expect(resumeFilename(PROFILE, "Acme, Inc.")).toBe("Alex_Example_AcmeInc.docx");
    expect(resumeFilename(PROFILE, "")).toBe("Alex_Example_Tailored.docx");
  });

  test("outline omits the Work Experience section when there are no entries", () => {
    const noWork: Profile = {
      ...PROFILE,
      work_experience: {},
    };
    const lines = resumeOutline(noWork, CONTENT);
    expect(lines).not.toContain("Work Experience");
  });
});
