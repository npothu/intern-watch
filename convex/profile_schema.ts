/**
 * The resume profile (bank) shape, version 2.
 *
 * WHY v2 EXISTS
 * -------------
 * v1 could not express a second school. `education` was a single object with
 * one `graduate_degree` escape hatch, and every other group was a
 * `Record<name, X>` whose only ordering was JS object key order - which a user
 * cannot drag. v2 makes both of those data:
 *
 *   - a Section is a list of Entries, and its position in `sections` is the
 *     rendered order,
 *   - one Entry can hold many Degrees, so B.S. + M.S. at the same institution
 *     stays a single dated school heading, while a transfer school is simply a
 *     second Entry.
 *
 * Every section - education, experience, projects, community, research,
 * anything the user invents - is the same Entry shape with different labels.
 * That is what keeps the editor one component instead of six.
 *
 * RENDER PARITY IS THE CONTRACT
 * -----------------------------
 * `migrateProfile` must produce a v2 profile that `resumeOutline` renders
 * byte-for-byte identically to what the v1 renderer produced for the same
 * input. resume.test.ts pins that. Read the per-field notes on `Degree` and
 * `Entry` before changing anything here - several fields exist specifically to
 * reproduce a v1 rendering quirk.
 */

/** A resume variant key: "base", "swe", "data", ... "base" always exists. */
export type Variant = string;

export type HeadingRun = { text: string; bold?: boolean; italics?: boolean };

/** A skill line entry. The object form groups keywords under a named heading. */
export type SkillGroup = { name: string; keywords?: string[] };
export type SkillItem = string | SkillGroup;

/**
 * One degree at one institution.
 *
 * Render note: the FIRST degree of an education entry renders as plain italic
 * lines (degree, then concentration, then gpa) with no date column, because
 * its date already sits on the institution heading line. Every SUBSEQUENT
 * degree renders as a dated italic line. That asymmetry is v1's behaviour for
 * `degree`/`threads`/`gpa` vs `graduate_degree`, and it is deliberate: it is
 * what makes a single-degree resume look unchanged after migration.
 */
export type Degree = {
  degree: string;
  /** v1 called this `threads`. Its own italic line under the degree. */
  concentration?: string;
  grad_date: string;
  gpa?: string;
};

/** A free line hung off an entry: study abroad, honors, a certification note. */
export type Extra = { text: string; date?: string; italics?: boolean };

/**
 * The universal entry. Education, work, projects, community and any custom
 * section are all lists of these; a section's `kind` decides which optional
 * fields the renderer reads.
 */
export type Entry = {
  /** Stable across reorders and referenced by `hiddenIn`. Never reuse. */
  id: string;
  /** Institution / company / project / organization. Bold, left. */
  heading: string;
  /** Role or subtitle. Italic, on its own line under the heading. */
  subheading?: string;
  /** Right-aligned on the heading line (work location in v1). */
  location?: string;
  /** Right-aligned on the subheading line, or the heading line if no subheading. */
  date: string;
  /** Variants that skip this entry entirely. Absent means shown everywhere. */
  hiddenIn?: Variant[];
  /** Projects: the italic "| React, TypeScript" run after the heading. */
  tech?: string[];
  /** Projects: selection hints consumed by resume_select.ts. */
  tags?: string[];
  /** Education only. */
  degrees?: Degree[];
  /** Extra dated lines (study abroad, honors). */
  extras?: Extra[];
  /**
   * Community only: a rich heading built from styled runs, overriding
   * `heading` when present. v1's `community[].heading_runs`.
   */
  headingRuns?: HeadingRun[];
  /** Variant -> bullet lines. Missing variant falls back to "base". */
  bullets: Record<Variant, string[]>;
};

export type SectionKind =
  | "education"
  | "experience"
  | "projects"
  | "community"
  | "skills"
  | "custom";

/**
 * `skills` is the one kind with no entries - it renders the top-level `skills`
 * blob. It still lives in `sections` so its position is user-orderable like
 * everything else.
 */
export type Section = {
  id: string;
  /** The rendered section header text, e.g. "Work Experience". */
  title: string;
  kind: SectionKind;
  entries: Entry[];
};

export type ProfileV2 = {
  version: 2;
  header: {
    name: string;
    contact_line: string;
    citizen_prefix?: string;
    links?: { text: string; url: string }[];
  };
  /** Variants the user has created, in creation order. "base" is implicit and
   *  is never stored here. Bullet keys can still introduce a variant (an older
   *  profile predates this field), so variantsOf unions the two. */
  variants?: string[];
  /**
   * The skills blob. It is NOT a Section's entries: the `skills` section kind
   * carries no entries and renders this instead, which is what lets the user
   * reorder where Skills appears without moving the data. Keep this field -
   * deleting it silently drops the whole Skills section from every rendered
   * resume and breaks migrateProfile.
   */
  skills: {
    coursework?: SkillItem[];
    languages?: SkillItem[];
    tools?: SkillItem[];
    certifications?: string[];
  };
  sections: Section[];
};

// --- v1, kept only so the migration can read it ------------------------------

export type WorkEntryV1 = {
  location?: string;
  role: string;
  date: string;
  bullets: Record<string, string[]>;
};
export type ProjectV1 = {
  tech?: string[];
  date: string;
  tags?: string[];
  bullets: Record<string, string[]>;
};
export type CommunityEntryV1 = {
  heading_runs?: HeadingRun[];
  date: string;
  bullets: Record<string, string[]>;
};
export type ProfileV1 = {
  header: ProfileV2["header"];
  education: {
    institution: string;
    grad_date: string;
    degree?: string;
    threads?: string;
    gpa?: string;
    graduate_degree?: { degree: string; grad_date: string };
    study_abroad?: { text: string; date: string };
  };
  skills?: ProfileV2["skills"];
  work_experience?: Record<string, WorkEntryV1>;
  projects?: Record<string, ProjectV1>;
  community?: Record<string, CommunityEntryV1>;
};

// --- ids ---------------------------------------------------------------------

/**
 * Deterministic, readable ids. Deterministic matters: the migration runs inside
 * a Convex mutation, and a Math.random id would make the same input produce a
 * different document on a retry.
 */
export function slugId(prefix: string, name: string, seq: number): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  return `${prefix}-${slug || "item"}-${seq}`;
}

// --- migration ---------------------------------------------------------------

/**
 * v2 is recognised by SHAPE as well as by the version tag.
 *
 * The tag alone is too fragile to be the only signal: `toV2` feeds anything
 * that fails this check to `migrateProfile`, which reads v1-only keys
 * (`education`, `work_experience`, ...). Handed a real v2 document with the
 * tag missing, that reads nothing but `undefined` and cheerfully returns an
 * EMPTY profile - silently destroying the resume instead of failing loudly.
 * A hand-authored document, a round trip through a tool that drops unknown
 * keys, or a test fixture is enough to lose the tag, so the presence of a
 * `sections` array counts too.
 */
export function isV2(p: unknown): p is ProfileV2 {
  if (!p || typeof p !== "object") return false;
  const o = p as { version?: unknown; sections?: unknown };
  return o.version === 2 || Array.isArray(o.sections);
}

/**
 * v1 -> v2. Section order here reproduces the order buildRenderNodes hard-coded
 * in v1: Education, Work Experience, Programming Projects, Community, Skills.
 *
 * A v1 profile with no work_experience still gets an (empty) Work Experience
 * section, because the user can now add to it. The renderer skips sections
 * whose visible entry list is empty, so an empty section changes no output.
 */
export function migrateProfile(v1: ProfileV1): ProfileV2 {
  const edu = v1.education ?? { institution: "", grad_date: "" };

  const degrees: Degree[] = [];
  if (edu.degree || edu.threads || edu.gpa) {
    degrees.push({
      degree: edu.degree ?? "",
      concentration: edu.threads,
      grad_date: edu.grad_date,
      gpa: edu.gpa,
    });
  }
  if (edu.graduate_degree) {
    degrees.push({
      degree: edu.graduate_degree.degree,
      grad_date: edu.graduate_degree.grad_date,
    });
  }

  const eduEntry: Entry = {
    id: slugId("edu", edu.institution, 0),
    heading: edu.institution,
    date: edu.grad_date,
    degrees,
    extras: edu.study_abroad
      ? [{ text: edu.study_abroad.text, date: edu.study_abroad.date, italics: true }]
      : undefined,
    bullets: {},
  };

  const work = v1.work_experience ?? {};
  const workEntries: Entry[] = Object.keys(work).map((name, i) => ({
    id: slugId("work", name, i),
    heading: name,
    subheading: work[name].role,
    location: work[name].location,
    date: work[name].date,
    bullets: work[name].bullets ?? {},
  }));

  const projects = v1.projects ?? {};
  const projectEntries: Entry[] = Object.keys(projects).map((name, i) => ({
    id: slugId("proj", name, i),
    heading: name,
    date: projects[name].date,
    tech: projects[name].tech,
    tags: projects[name].tags,
    bullets: projects[name].bullets ?? {},
  }));

  const community = v1.community ?? {};
  const communityEntries: Entry[] = Object.keys(community).map((name, i) => ({
    id: slugId("comm", name, i),
    heading: name,
    headingRuns: community[name].heading_runs,
    date: community[name].date,
    bullets: community[name].bullets ?? {},
  }));

  return {
    version: 2,
    header: v1.header,
    skills: v1.skills ?? {},
    sections: [
      { id: "sec-education", title: "Education", kind: "education", entries: [eduEntry] },
      { id: "sec-experience", title: "Work Experience", kind: "experience", entries: workEntries },
      { id: "sec-projects", title: "Programming Projects", kind: "projects", entries: projectEntries },
      { id: "sec-community", title: "Community", kind: "community", entries: communityEntries },
      { id: "sec-skills", title: "Skills", kind: "skills", entries: [] },
    ],
  };
}

/** Accepts either shape and always hands back v2. */
export function toV2(data: unknown): ProfileV2 {
  return isV2(data) ? data : migrateProfile(data as ProfileV1);
}

// --- variant helpers ---------------------------------------------------------

/** Bullets for a variant, falling back to "base". */
export function bulletsFor(entry: Entry, variant: Variant): string[] {
  return entry.bullets[variant] ?? entry.bullets.base ?? [];
}

/** Entries a variant should render, in order. */
export function visibleEntries(section: Section, variant: Variant): Entry[] {
  return section.entries.filter((e) => !(e.hiddenIn ?? []).includes(variant));
}

/** Every variant key that appears anywhere, "base" first. */
/** Every variant key that appears anywhere, "base" first. */
export function variantsOf(profile: ProfileV2): Variant[] {
  const out: Variant[] = ["base"];
  for (const v of profile.variants ?? []) if (v !== "base" && !out.includes(v)) out.push(v);
  for (const s of profile.sections)
    for (const e of s.entries)
      for (const k of Object.keys(e.bullets)) if (!out.includes(k)) out.push(k);
  return out;
}
