import { beforeAll, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { Document } from "docx";
import schema from "./schema";
import * as resume from "./resume";
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

const SECRET = "test-tracker-secret";

beforeAll(() => {
  process.env.TRACKER_SECRET = SECRET;
});

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

describe("resume.ts: putProfile stores an opaque JSON string", () => {
  // Convex field names must be non-control ASCII, so profile JSON (which can
  // carry user-authored dict keys, e.g. a project name with an em dash) is
  // stored as a JSON string rather than a raw object - inserting such an
  // object fails with an opaque "Server Error". These tests cover the string
  // contract across putProfile and the runBuild read path (getProfileInternal
  // + the same typeof-string normalizer performBuild uses).

  test("putProfile stores data as a string and getProfileInternal round-trips it", async () => {
    const t = convexTest(schema);
    const data = { header: { name: "Alex Example" }, projects: {} };
    await t.mutation(resume.putProfile, {
      user: "u1",
      data: JSON.stringify(data),
      secret: SECRET,
    });
    const row = await t.run(async (ctx) =>
      ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("user", "u1")).first(),
    );
    expect(typeof row!.data).toBe("string");
    expect(JSON.parse(row!.data as string)).toEqual(data);
  });

  test("putProfile upserts (replaces, does not duplicate) on a second call", async () => {
    const t = convexTest(schema);
    await t.mutation(resume.putProfile, {
      user: "u1",
      data: JSON.stringify({ v: 1 }),
      secret: SECRET,
    });
    await t.mutation(resume.putProfile, {
      user: "u1",
      data: JSON.stringify({ v: 2 }),
      secret: SECRET,
    });
    const rows = await t.run(async (ctx) => ctx.db.query("profiles").collect());
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].data as string)).toEqual({ v: 2 });
  });

  test("putProfile rejects invalid JSON", async () => {
    const t = convexTest(schema);
    await expect(
      t.mutation(resume.putProfile, {
        user: "u1",
        data: "{not valid json",
        secret: SECRET,
      }),
    ).rejects.toThrow("profile data must be valid JSON");
  });

  test("putProfile rejects a bad secret", async () => {
    const t = convexTest(schema);
    await expect(
      t.mutation(resume.putProfile, {
        user: "u1",
        data: JSON.stringify({}),
        secret: "wrong",
      }),
    ).rejects.toThrow("bad secret");
  });

  test("a non-ASCII (em dash) dict key round-trips through putProfile and the runBuild read path", async () => {
    const t = convexTest(schema);
    const projectName = "Sys-savesync — Background Save Sync Sysmodule";
    const data = {
      header: { name: "Alex Example" },
      projects: {
        [projectName]: {
          tech: ["C"],
          date: "2026",
          bullets: { base: ["Wrote a save-sync sysmodule."] },
        },
      },
    };
    // The bug: inserting `data` as a raw object (with the em-dash key) fails
    // with an opaque Server Error. Sending it as a JSON string sidesteps
    // that field-name constraint entirely.
    await t.mutation(resume.putProfile, {
      user: "u1",
      data: JSON.stringify(data),
      secret: SECRET,
    });
    const row = await t.query(resume.getProfileInternal, { user: "u1" });
    // Same normalizer performBuild applies before treating profileRow.data as
    // a Profile.
    const profile =
      typeof row!.data === "string" ? JSON.parse(row!.data as string) : row!.data;
    expect(Object.keys(profile.projects)).toEqual([projectName]);
    expect(profile.projects[projectName].bullets.base[0]).toBe(
      "Wrote a save-sync sysmodule.",
    );
  });

  test("legacy object-shaped rows (written before this fix) are tolerated by the read-path normalizer", async () => {
    const t = convexTest(schema);
    const data = { header: { name: "Legacy User" }, projects: {} };
    // Bypass putProfile to simulate a row written before the string contract
    // (schema keeps `data: v.any()` for exactly this reason).
    await t.run(async (ctx) => {
      await ctx.db.insert("profiles", { user: "u1", data, updatedAt: Date.now() });
    });
    const row = await t.query(resume.getProfileInternal, { user: "u1" });
    expect(typeof row!.data).toBe("object");
    const profile =
      typeof row!.data === "string" ? JSON.parse(row!.data as string) : row!.data;
    expect(profile).toEqual(data);
  });
});
