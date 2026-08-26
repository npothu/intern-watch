import { describe, expect, test } from "vitest";
import {
  cleanCitizenPrefix,
  migrateProfile,
  normalizeProfile,
  splitHeadingLocation,
  toV2,
  type Entry,
  type ProfileV1,
  type ProfileV2,
} from "./profile_schema";

const entry = (heading: string, location?: string): Entry => ({
  id: "x",
  heading,
  date: "",
  location,
  bullets: {},
});

describe("cleanCitizenPrefix", () => {
  test("drops the separator legacy values carried, in either position", () => {
    expect(cleanCitizenPrefix("US Citizen | ")).toBe("US Citizen");
    expect(cleanCitizenPrefix("US Citizen ||")).toBe("US Citizen");
    expect(cleanCitizenPrefix("| US Citizen")).toBe("US Citizen");
    expect(cleanCitizenPrefix("  US Citizen  ")).toBe("US Citizen");
  });
  test("keeps an inner pipe and returns undefined for nothing", () => {
    expect(cleanCitizenPrefix("US Citizen | Green Card")).toBe("US Citizen | Green Card");
    expect(cleanCitizenPrefix(" | ")).toBeUndefined();
    expect(cleanCitizenPrefix(undefined)).toBeUndefined();
  });
});

describe("splitHeadingLocation", () => {
  test("moves the trailing column of a piped heading into location", () => {
    expect(splitHeadingLocation(entry("Georgia Institute of Technology | Atlanta, GA"))).toEqual(
      entry("Georgia Institute of Technology", "Atlanta, GA"),
    );
  });
  test("splits at the last pipe only", () => {
    expect(splitHeadingLocation(entry("A | B | Remote"))).toEqual(entry("A | B", "Remote"));
  });
  test("leaves an entry alone when it already has a location or the pipe is dangling", () => {
    const located = entry("Acme | Atlanta, GA", "Atlanta, GA");
    expect(splitHeadingLocation(located)).toBe(located);
    const dangling = entry("Acme |");
    expect(splitHeadingLocation(dangling)).toBe(dangling);
    const plain = entry("Acme");
    expect(splitHeadingLocation(plain)).toBe(plain);
  });
});

const v1: ProfileV1 = {
  header: {
    name: "Alex Example",
    contact_line: "Atlanta, GA | alex@example.com",
    citizen_prefix: "US Citizen | ",
    links: [{ text: "github.com/alex", url: "https://github.com/alex" }],
  },
  education: {
    institution: "Georgia Institute of Technology | Atlanta, GA",
    grad_date: "May 2027",
    degree: "B.S. Computer Science",
  },
  work_experience: {
    "Acme | Remote": { role: "Intern", date: "2026", bullets: { base: ["Did things."] } },
  },
  projects: {
    "Pipes | Filters": { tech: ["Go"], date: "2025", bullets: { base: ["Piped."] } },
  },
};

describe("normalizeProfile / toV2", () => {
  test("a migrated v1 profile comes out with a clean prefix and a split institution", () => {
    const p = toV2(v1);
    expect(p.header.citizen_prefix).toBe("US Citizen");
    const [edu, work, proj] = p.sections;
    expect(edu.entries[0]).toMatchObject({
      heading: "Georgia Institute of Technology",
      location: "Atlanta, GA",
    });
    // Only education splits: experience renders location in the date column
    // and community ignores it, so their headings are left exactly as typed.
    expect(work.entries[0]).toMatchObject({ heading: "Acme | Remote" });
    expect(work.entries[0].location).toBeUndefined();
    expect(proj.entries[0].heading).toBe("Pipes | Filters");
    expect(proj.entries[0].location).toBeUndefined();
  });

  test("a stored v2 profile is normalised on read too, without being mutated", () => {
    const stored: ProfileV2 = migrateProfile(v1);
    const before = JSON.stringify(stored);
    const p = toV2(stored);
    expect(JSON.stringify(stored)).toBe(before);
    expect(p.header.citizen_prefix).toBe("US Citizen");
    expect(p.sections[0].entries[0].location).toBe("Atlanta, GA");
  });

  test("is idempotent and drops an empty prefix rather than storing it", () => {
    const once = normalizeProfile(migrateProfile(v1));
    expect(normalizeProfile(once)).toEqual(once);
    const blank = normalizeProfile({ ...once, header: { ...once.header, citizen_prefix: " | " } });
    expect("citizen_prefix" in blank.header).toBe(false);
  });
});
