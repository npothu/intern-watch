import { describe, expect, it } from "vitest";
import {
  blankEntry,
  blankProfile,
  bulletsFor,
  isProfileEmpty,
  outlineLines,
  profileCounts,
  variantsOf,
  visibleEntries,
  type Entry,
  type ProfileV2,
  type SectionKind,
} from "./profile";

function entry(overrides: Partial<Entry> & { heading: string }): Entry {
  return {
    id: "e-1",
    date: "",
    bullets: {},
    ...overrides,
  };
}

describe("bulletsFor", () => {
  it("falls back to base when the variant key is missing", () => {
    const e = entry({ heading: "Co", bullets: { base: ["a", "b"], swe: ["c"] } });
    expect(bulletsFor(e, "data")).toEqual(["a", "b"]);
  });

  it("returns [] when neither the variant nor base exists", () => {
    const e = entry({ heading: "Co", bullets: { swe: ["c"] } });
    expect(bulletsFor(e, "data")).toEqual([]);
  });
});

describe("visibleEntries", () => {
  it("excludes entries hidden for the variant and includes unhidden ones", () => {
    const section = {
      id: "s",
      title: "Work Experience",
      kind: "experience" as SectionKind,
      entries: [
        entry({ heading: "A", hiddenIn: ["swe"], bullets: {} }),
        entry({ heading: "B", bullets: { swe: ["x"] } }),
        entry({ heading: "C", hiddenIn: ["data"], bullets: {} }),
      ],
    };
    const visible = visibleEntries(section, "swe");
    expect(visible.map((e) => e.heading)).toEqual(["B", "C"]);
  });

  it("includes entries with no hiddenIn at all", () => {
    const section = {
      id: "s",
      title: "Work Experience",
      kind: "experience" as SectionKind,
      entries: [entry({ heading: "A", bullets: {} })],
    };
    expect(visibleEntries(section, "base").map((e) => e.heading)).toEqual(["A"]);
  });
});

describe("variantsOf", () => {
  it("always lists base first, then the other keys sorted", () => {
    const p: ProfileV2 = {
      version: 2,
      header: { name: "N", contact_line: "" },
      skills: {},
      sections: [
        {
          id: "s",
          title: "Work Experience",
          kind: "experience",
          entries: [
            entry({ heading: "A", bullets: { data: [], base: [] } }),
            entry({ heading: "B", bullets: { swe: [], zoo: [] } }),
            entry({ heading: "C", bullets: { data: [] } }),
          ],
        },
      ],
    };
    expect(variantsOf(p)).toEqual(["base", "data", "swe", "zoo"]);
  });
});

describe("outlineLines", () => {
  it("counts lines and skips empty projects/community sections", () => {
    const p: ProfileV2 = {
      version: 2,
      header: { name: "N", contact_line: "C" },
      skills: { languages: ["Python"], tools: ["Git"], certifications: [] },
      sections: [
        {
          id: "sec-education",
          title: "Education",
          kind: "education",
          entries: [
            {
              id: "e-edu",
              heading: "MIT",
              date: "2026",
              degrees: [{ degree: "B.S. CS", grad_date: "2026" }],
              bullets: {},
            },
          ],
        },
        {
          id: "sec-experience",
          title: "Work Experience",
          kind: "experience",
          entries: [
            { id: "e-work", heading: "Acme", date: "2025", bullets: { base: ["b1", "b2"] } },
          ],
        },
        { id: "sec-projects", title: "Programming Projects", kind: "projects", entries: [] },
        { id: "sec-community", title: "Community", kind: "community", entries: [] },
        { id: "sec-skills", title: "Skills", kind: "skills", entries: [] },
      ],
    };

    const result = outlineLines(p, "base");
    const total = result.reduce((n, s) => n + s.lines.length, 0);

    // header(3) + education(title+heading+degree=3) + experience(title+heading+2
    // bullets=4) + skills(title+2 groups=3) = 13. Empty projects and community
    // sections are skipped entirely.
    expect(total).toBe(13);
    expect(result.map((s) => s.section)).toEqual([
      "header",
      "education",
      "experience",
      "skills",
    ]);
  });
});

describe("blankEntry and blankProfile", () => {
  it("produce valid shapes", () => {
    const edu = blankEntry("education");
    expect(edu.id.startsWith("education-")).toBe(true);
    expect(edu.heading).toBe("");
    expect(edu.date).toBe("");
    expect(edu.bullets).toEqual({});
    expect(edu.degrees).toEqual([]);

    const work = blankEntry("experience");
    expect(work.degrees).toBeUndefined();

    const p = blankProfile();
    expect(p.version).toBe(2);
    expect(p.header).toEqual({ name: "", contact_line: "" });
    expect(p.skills).toEqual({});
    expect(p.sections.map((s) => s.id)).toEqual([
      "sec-education",
      "sec-experience",
      "sec-projects",
      "sec-community",
      "sec-skills",
    ]);
    expect(p.sections.map((s) => s.entries.length)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe("profileCounts and isProfileEmpty (import review scale)", () => {
  const filled: ProfileV2 = {
    version: 2,
    header: { name: "Alex Example", contact_line: "alex@example.com" },
    skills: { languages: ["C"] },
    sections: [
      {
        id: "s-work",
        title: "Work Experience",
        kind: "experience",
        entries: [
          entry({
            id: "e-a",
            heading: "Acme",
            // Variant bullets count too: they are exactly the hand-written
            // work an import would destroy.
            bullets: { base: ["a", "b"], swe: ["c"] },
          }),
          entry({ id: "e-b", heading: "Beta", bullets: { base: ["d"] } }),
        ],
      },
      { id: "s-skills", title: "Skills", kind: "skills", entries: [] },
    ],
  };

  it("counts sections, entries, and bullets across every variant", () => {
    expect(profileCounts(filled)).toEqual({ sections: 2, entries: 2, bullets: 4 });
  });

  it("treats the blank scaffold as empty despite its five sections", () => {
    expect(isProfileEmpty(blankProfile())).toBe(true);
  });

  it("a profile with any entry, skill, or header text is not empty", () => {
    expect(isProfileEmpty(filled)).toBe(false);
    const headerOnly = { ...blankProfile(), header: { name: "Alex", contact_line: "" } };
    expect(isProfileEmpty(headerOnly)).toBe(false);
    const skillsOnly = { ...blankProfile(), skills: { tools: ["Docker"] } };
    expect(isProfileEmpty(skillsOnly)).toBe(false);
  });
});
