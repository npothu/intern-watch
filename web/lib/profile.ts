/**
 * The resume profile (bank) shape, version 2 - the web-bundle mirror of
 * convex/profile_schema.ts.
 *
 * WHY THIS MIRROR EXISTS
 * ----------------------
 * convex/profile_schema.ts defines the v2 shape with zero external imports and
 * is not wrapped in "server-only", but the browser bundle cannot import it:
 * Next.js would pull the whole convex module graph into client code, and any
 * future convex import added there would silently leak into the editor. So the
 * pure types and tiny pure helpers are restated here. The two files MUST stay
 * in sync - keep field names, optionality and comments verbatim. A change to
 * one is a change to the other.
 *
 * RENDER PARITY IS THE CONTRACT
 * -----------------------------
 * convex/migrateProfile must produce a v2 profile that resumeOutline renders
 * byte-for-byte identically to what the v1 renderer produced. The per-field
 * notes on `Degree` and `Entry` are carried over so the outline estimator
 * (outlineLines) can mirror those quirks. See convex/profile_schema.ts for the
 * full migration contract.
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
  skills: {
    coursework?: SkillItem[];
    languages?: SkillItem[];
    tools?: SkillItem[];
    certifications?: string[];
  };
  /** Variants the user has created, in creation order. "base" is implicit and
   *  is never stored here. Bullet keys can still introduce a variant (an older
   *  profile predates this field), so variantsOf unions the two. */
  variants?: string[];
  sections: Section[];
};

/**
 * A fresh entry id. Random device ids are fine here (unlike the deterministic
 * slugId convex uses during migration): this runs client-side for brand-new
 * entries, never inside a migration that must be reproducible.
 */
export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/** A blank entry for a section kind. Education gets an empty degrees list. */
export function blankEntry(kind: SectionKind): Entry {
  return {
    id: newId(kind),
    heading: "",
    date: "",
    bullets: {},
    ...(kind === "education" ? { degrees: [] } : {}),
  };
}

/**
 * The section kinds the "+ Add section" control offers. Skills is intentionally
 * absent: there is exactly one skills section and it always exists, so it is
 * not something a user adds.
 */
export const SECTION_KINDS: { kind: SectionKind; label: string; defaultTitle: string }[] = [
  { kind: "education", label: "Education", defaultTitle: "Education" },
  { kind: "experience", label: "Work Experience", defaultTitle: "Work Experience" },
  { kind: "projects", label: "Projects", defaultTitle: "Programming Projects" },
  { kind: "community", label: "Community", defaultTitle: "Community" },
  { kind: "custom", label: "Custom", defaultTitle: "Custom" },
];

/**
 * A fresh, empty v2 profile for a brand-new user, with the same five default
 * sections (and ids) that convex/profile_schema.ts's migrateProfile produces.
 */
export function blankProfile(): ProfileV2 {
  return {
    version: 2,
    header: { name: "", contact_line: "" },
    skills: {},
    sections: [
      { id: "sec-education", title: "Education", kind: "education", entries: [] },
      { id: "sec-experience", title: "Work Experience", kind: "experience", entries: [] },
      { id: "sec-projects", title: "Programming Projects", kind: "projects", entries: [] },
      { id: "sec-community", title: "Community", kind: "community", entries: [] },
      { id: "sec-skills", title: "Skills", kind: "skills", entries: [] },
    ],
  };
}

/** Rendered-line budget for the live preview meter (one page of a resume). */
export const PAGE_LINE_BUDGET = 59;

export type OutlineEntry = { section: string; lines: string[] };

/**
 * Rendered-line estimate for the live preview meter.
 *
 * This deliberately mirrors the render order convex/resume_docx.ts uses closely
 * enough to COUNT lines. It is an ESTIMATE, not byte-accurate: each array entry
 * is one counted line, callers only read `.length` for the meter and use the
 * string only to vary a width class, so content just needs to be non-empty and
 * roughly proportional. It does not attempt to reproduce exact resume text.
 */
export function outlineLines(p: ProfileV2, variant: Variant): OutlineEntry[] {
  const sections: OutlineEntry[] = [];

  // Always three header lines first: name, contact line, links line.
  sections.push({ section: "header", lines: [p.header.name, p.header.contact_line, "links"] });

  for (const section of p.sections) {
    const visible = visibleEntries(section, variant);

    // The renderer skips empty non-skills sections entirely (no header line).
    if (visible.length === 0 && section.kind !== "skills") continue;

    const lines: string[] = [section.title];

    if (section.kind === "skills") {
      // One line per non-empty group among languages/tools/coursework/
      // certifications (skip the empty ones).
      const groups: { key: string; items: SkillItem[] | undefined }[] = [
        { key: "Languages", items: p.skills.languages },
        { key: "Tools", items: p.skills.tools },
        { key: "Coursework", items: p.skills.coursework },
        { key: "Certifications", items: p.skills.certifications },
      ];
      for (const group of groups) {
        if (group.items && group.items.length > 0) lines.push(group.key);
      }
    } else {
      for (const entry of visible) {
        lines.push(entry.heading || "x");
        if (entry.subheading) lines.push(entry.subheading);
        if (entry.degrees) {
          // Each degree is one line, plus a line per non-empty concentration
          // and per non-empty gpa (an approximation of the v1 first-degree
          // quirk - exact resume text is out of scope for an estimate).
          for (const degree of entry.degrees) {
            lines.push(degree.degree || "x");
            if (degree.concentration) lines.push(degree.concentration);
            if (degree.gpa) lines.push(degree.gpa);
          }
        }
        for (const extra of entry.extras ?? []) lines.push(extra.text || "x");
        for (const bullet of bulletsFor(entry, variant)) {
          lines.push(bullet || "x");
          // Long bullets wrap; count the extra rendered wrap lines.
          const wraps = Math.floor((bullet ?? "").length / 100);
          for (let i = 0; i < wraps; i++) lines.push("x");
        }
      }
    }

    sections.push({ section: section.kind, lines });
  }

  return sections;
}

// --- variant helpers (verbatim from convex/profile_schema.ts) ---------------

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
