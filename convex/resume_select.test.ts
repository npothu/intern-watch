import { describe, expect, test } from "vitest";
import { migrateProfile, type Entry } from "./profile_schema";
import {
  analyze,
  matches,
  pickVariant,
  scoreProject,
  searchable,
  selectProjects,
  MAX_PROJECTS,
  MIN_PROJECTS,
  W_TAG,
  W_TECH,
  W_TEXT,
} from "./resume_select";

// Pure tests for the project-selection port of src/resume/select.py (+ jd.py).
// These cover the deterministic surfaces - JD skill extraction, weighted
// overlap scoring, variant picking, and the cap/pad selection rule.

function proj(opts: Partial<Entry> & { bullets?: Record<string, string[]> } = {}): Entry {
  return {
    id: "proj-item-0",
    heading: "proj",
    date: "2026",
    bullets: { base: ["general project text"] },
    ...opts,
  };
}

// Build a v2 profile from the same v1 inputs the pre-migration helper took, so
// fixtures read the way they always did while the shape under test is v2.
function profile(projects: Record<string, Partial<Entry>>): ReturnType<typeof migrateProfile> {
  return migrateProfile({
    header: { name: "Alex Example", contact_line: "alex@example.com" },
    education: { institution: "Georgia Tech", grad_date: "May 2027" },
    projects: Object.fromEntries(
      Object.entries(projects).map(([name, e]) => [
        name,
        {
          tech: e.tech,
          date: e.date ?? "2026",
          tags: e.tags,
          bullets: e.bullets ?? { base: ["general project text"] },
        },
      ]),
    ),
  });
}

describe("matches / analyze (jd.py port)", () => {
  test("matches resolves canonical skills through their aliases", () => {
    expect(matches("python", "I built an API with Python.")).toBe(true);
    expect(matches("javascript", "wrote a node server")).toBe(true);
    expect(matches("javascript", "plain text")).toBe(false);
    expect(matches("java", "javascript everywhere")).toBe(false);
  });

  test("analyze extracts weighted skills and omits unmentioned ones", () => {
    const jd = analyze("We use Python and Docker.");
    expect(jd.weights.python).toBeGreaterThan(0);
    expect(jd.weights.docker).toBeGreaterThan(0);
    expect(jd.weights.react).toBeUndefined();
  });

  test("mentions inside a requirements block count double, capped", () => {
    const jd = analyze("Python Python Python. Python.\n\nRequirements:\nPython Python Python.");
    // plain capped at 3, req capped at 3 doubled
    expect(jd.weights.python).toBe(3 + 3 * 2);
  });
});

describe("score_project weighting (x3/x2/x1)", () => {
  test("a tag hit outranks a tech hit outranks prose, scaled by W factors", () => {
    const jd = analyze("Java");
    const tagOnly = proj({ tags: ["java"], tech: ["c"] });
    const techOnly = proj({ tags: ["c++"], tech: ["java"] });
    const proseOnly = proj({ tags: ["c#"], tech: ["c"], bullets: { base: ["used Java daily"] } });

    expect(scoreProject(tagOnly, jd)).toBe(1 * W_TAG);
    expect(scoreProject(techOnly, jd)).toBe(1 * W_TECH);
    expect(scoreProject(proseOnly, jd)).toBe(1 * W_TEXT);
    expect(scoreProject(tagOnly, jd)).toBeGreaterThan(scoreProject(techOnly, jd));
    expect(scoreProject(techOnly, jd)).toBeGreaterThan(scoreProject(proseOnly, jd));
  });

  test("a project with no JD overlap scores zero and searchable flattens all variants", () => {
    const p = proj({ tech: ["react"], bullets: { base: ["b1"], alt: ["b2"] } });
    expect(scoreProject(p, analyze("redis"))).toBe(0);
    expect(searchable(p).text).toBe("b1 b2");
    expect(searchable(p).tech).toBe("react");
  });
});

describe("pick_variant", () => {
  test("picks the variant whose text matches the most JD weight", () => {
    const p = proj({
      bullets: { base: ["nothing relevant"], tailored: ["I love Python and Docker"] },
    });
    expect(pickVariant(p, analyze("Python"))).toBe("tailored");
  });

  test("ties resolve to base", () => {
    const p = proj({ bullets: { base: ["Python"], other: ["Python"] } });
    expect(pickVariant(p, analyze("Python"))).toBe("base");
  });
});

describe("select_projects ordering / cap / pad", () => {
  test("scores are reported for every project, including unpicked ones", () => {
    const r = selectProjects(profile({ A: proj(), B: proj() }), "Redis");
    expect(Object.keys(r.scores).sort()).toEqual(["A", "B"]);
  });

  test("orders by score desc, then bank order, and caps at MAX_PROJECTS", () => {
    const projects: Record<string, Entry> = {
      R1: proj({ tags: ["redis"] }),
      D1: proj({ tags: ["docker"] }),
      A1: proj({ tags: ["aws"] }),
      G1: proj({ tags: ["gcp"] }),
      Z1: proj({ tags: ["azure"] }),
      L1: proj({ tags: ["linux"] }),
      T1: proj({ tags: ["git"] }),
      X1: proj({ tags: ["react"] }),
    };
    const jdText = "Redis Docker AWS GCP Azure Linux Git React";
    const r = selectProjects(profile(projects), jdText);
    expect(r.selected).toHaveLength(MAX_PROJECTS);
    // all tie on score=3 -> deterministic bank order, first MAX_PROJECTS
    expect(r.selected.map(([n]) => n)).toEqual(Object.keys(projects).slice(0, MAX_PROJECTS));
  });

  test("pads to MIN_PROJECTS with remaining projects in bank order when few score above zero", () => {
    // Only "P2" (unique redis tag) matches the JD; the rest score zero.
    const projects: Record<string, Entry> = {
      P1: proj({ tags: ["react"] }),
      P2: proj({ tags: ["redis"] }),
      P3: proj({ tags: ["docker"] }),
      P4: proj({ tags: ["aws"] }),
      P5: proj({ tags: ["gcp"] }),
    };
    const r = selectProjects(profile(projects), "Redis");
    expect(r.selected.map(([n]) => n)).toEqual(["P2", "P1", "P3", "P4", "P5"]);
  });

  test("empty JD falls back to bank order, first MAX_PROJECTS", () => {
    const projects: Record<string, Entry> = {};
    for (let i = 1; i <= 8; i++) projects[`P${i}`] = proj({ tags: ["react"] });
    const r = selectProjects(profile(projects), "");
    expect(r.selected.map(([n]) => n)).toEqual(
      Object.keys(projects).slice(0, MAX_PROJECTS),
    );
    expect(r.selected.map(([n]) => r.scores[n]).every((s) => s === 0)).toBe(true);
  });

  test("is deterministic across repeated calls", () => {
    const projects: Record<string, Entry> = {
      A: proj({ tags: ["redis"] }),
      B: proj({ tags: ["docker"] }),
      C: proj({ tags: ["aws"] }),
    };
    const a = selectProjects(profile(projects), "Redis AWS");
    const b = selectProjects(profile(projects), "Redis AWS");
    expect(b.selected).toEqual(a.selected);
  });
});

describe("generic-skill downweight and priority prior", () => {
  test("a GENERIC_SKILLS tag hit contributes half of a role-defining hit", () => {
    const jd = analyze(
      "Requirements:\nRESTful service experience.\n\nRequirements:\nkernel development experience.",
    );
    // identical weights for both skills, one generic and one not
    expect(jd.weights["rest apis"]).toBe(jd.weights["kernel"]);
    const generic = proj({ tags: ["rest apis"] });
    const defining = proj({ tags: ["kernel"] });
    expect(scoreProject(generic, jd)).toBe(scoreProject(defining, jd) / 2);
  });

  test("priority scales the score and re-ranks selection", () => {
    const jd = analyze("Requirements:\nmachine learning, pytorch");
    const strongTags = { tags: ["machine learning", "pytorch"] };
    const a = proj({ ...strongTags });
    const b = proj({ ...strongTags, priority: 0.5 });
    expect(scoreProject(b, jd)).toBe(scoreProject(a, jd) * 0.5);
    expect(scoreProject(proj({ ...strongTags, priority: 1 }), jd)).toBe(
      scoreProject(a, jd),
    );
  });

  test("absent priority means 1.0 (backward compatible)", () => {
    const jd = analyze("python");
    const e = proj({ tags: ["python"] });
    expect(scoreProject(e, jd)).toBe(scoreProject({ ...e, priority: 1 }, jd));
  });
});
