// Pure .docx composition for the Convex-native resume builder.
//
// This module has no imports from ./_generated and no "use node" - it only
// turns a resume profile (users/<user>_resume.json shape, stored in the
// `profiles` table) plus the tailored project content into a `docx` Document.
// Keeping it pure makes it directly unit-testable (sections/order) without a
// Convex backend.
//
// ---------------------------------------------------------------------------
// Python parity: this is a port of src/resume/render.py, replicating its
// layout as closely as the `docx` npm library allows. The source spec
// (src/resume/spec.py) is the single source of truth for sizes:
//
//   FONT "Times New Roman"; page US Letter 12240x15840 twips with 720-twip
//   (0.5") margins; sizes 10/10/13/10/11 pt (name/contact/section/edu/body);
//   bullet "●\t" with hanging indent 360 twips and left indent 720 twips;
//   dated lines use ONE right tab stop at 10800 twips (the right text edge);
//   section headers are bold bottom-bordered paragraphs (w:sz 6, single).
//
// The composition is kept as a two-layer pure pipeline so it is testable:
// `resumeOutline` (ordered rendered text, including section headers) feeds the
// same RenderNode structure that `composeResumeDoc` maps to a real Document.
//
// Divergences from Python (all minor - documented so a future port can tighten
// them):
//
//  1. Section-header bottom border uses space:1 (the docx lib's minimum)
//     exactly like python-docx; color falls back to the default black instead
//     of "auto" - visually identical, different attribute.
//  2. The python build_plan reorders skills by JD weight and picks a bullet
//     variant per project; the Convex-native builder keeps the bank's prose
//     order and base variants and tailors only via the LLM rewrite pass.
//  3. Normal-style inheritance: python sets the document "Normal" style; here
//     every run/paragraph sets its font/spacing explicitly so the result does
//     not depend on a default style block.
//  4. Unicode bullets copy the literal "●" (U+25CF) as python does, since the
//     docx lib renders run text verbatim.
// ---------------------------------------------------------------------------

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Paragraph,
  Tab,
  TabStopType,
  TextRun,
} from "docx";
import { bulletsFor, toV2, visibleEntries } from "./profile_schema";
import type {
  Entry,
  HeadingRun,
  ProfileV2,
  Section,
  SkillItem,
} from "./profile_schema";
// Re-exported for callers that used to get these types from here. A re-export
// alone does not bind the name locally, so HeadingRun is imported above too -
// datedLineSpec takes it as a parameter type.
export type { HeadingRun, SkillItem } from "./profile_schema";

const FONT = "Times New Roman";

// Point sizes -> half-points for the docx run `size` option.
const HALF = 2;
const SZ_NAME = 10 * HALF;
const SZ_CONTACT = 10 * HALF;
const SZ_SECTION = 13 * HALF;
const SZ_EDU = 10 * HALF;
const SZ_BODY = 11 * HALF;

const LINK_COLOR = "1155CC";

// Twips (1/20 pt): right tab at the right text edge, bullet hanging indent.
const RIGHT_TAB_TW = 10800; // content width = page 12240 - 2*720 margin
const BULLET_INDENT_TW = 720;
const BULLET_HANG_TW = 360;
const BULLET_CHAR = "●"; // ●

// Section header bottom border, eighths of a point.
const SECTION_BORDER_SZ8 = 6;

// Single line spacing: 240/240 auto is Word's "single".
const LINE_SINGLE = 240;

/**
 * The tailored (variable) part of a build: the projects selected to surface,
 * each with the bullets that will render (post-LLM rewrite / base variant).
 */
export type TailoredContent = {
  projects: { name: string; tech: string; date: string; bullets: string[] }[];
};

// --- intermediate render nodes -------------------------------------------------
// A RenderNode is one paragraph's full spec; composeResumeDoc maps these to
// docx Paragraphs and resumeOutline flattens them to visible text.

type RunSpec = {
  text: string;
  bold?: boolean;
  italics?: boolean;
  color?: string;
  link?: string; // when set, the run is an external hyperlink
  size: number; // half-points
};

type ParaSpec = {
  runs: RunSpec[];
  align?: "center";
  rightTab?: boolean;
  hanging?: { left: number; hanging: number; tabAt: number };
  borderBottom?: boolean;
  afterPt?: number;
};

function paraSpec(runs: RunSpec[], opts: Partial<ParaSpec> = {}): ParaSpec {
  return { runs, afterPt: 0, ...opts };
}

function run(text: string, size: number, opts: Partial<RunSpec> = {}): RunSpec {
  return { text, size, ...opts };
}

function sectionHeaderSpec(text: string): ParaSpec {
  return paraSpec([run(text, SZ_SECTION, { bold: true })], {
    borderBottom: true,
    afterPt: 2, // SECTION_SPACE_AFTER_PT
  });
}

function datedLineSpec(runs: HeadingRun[], date: string, size: number): ParaSpec {
  const specs: RunSpec[] = runs.map((r) =>
    run(r.text, size, { bold: r.bold, italics: r.italics }),
  );
  specs.push(run(`\t${date}`, size));
  return paraSpec(specs, { rightTab: true });
}

function bulletSpec(text: string): ParaSpec {
  return paraSpec([run(`${BULLET_CHAR}\t${text}`, SZ_BODY)], {
    hanging: { left: BULLET_INDENT_TW, hanging: BULLET_HANG_TW, tabAt: BULLET_INDENT_TW },
  });
}

function separatorSpec(): ParaSpec {
  return paraSpec([run("", SZ_BODY)]);
}

function plainSpec(text: string, size: number, opts: Partial<RunSpec> = {}): ParaSpec {
  return paraSpec([run(text, size, opts)]);
}

function skillNamed(item: SkillItem): string {
  return typeof item === "string" ? item : item.name;
}

// --- education line composition -----------------------------------------------
// v1 stored education as PRE-DECORATED strings, because the user typed them:
// institution was "Georgia Institute of Technology | Atlanta, GA", grad_date was
// "Expected Graduation May 2027", threads was "Concentrations: Systems & AI".
// The v2 editor collects the same information as separate structured fields, so
// the decoration has to be applied HERE instead.
//
// Every helper below is idempotent: it adds the decoration only when it is not
// already present, so a migrated v1 profile (whose strings still carry it)
// renders byte-identically instead of turning into "Graduation Expected
// Graduation May 2027". Do not "simplify" these to unconditional concatenation.

/** "Georgia Institute of Technology" + "Atlanta, GA" -> "... | Atlanta, GA". */
function institutionLine(heading: string, location?: string): string {
  const h = heading.trim();
  const loc = (location ?? "").trim();
  if (!loc || h.includes(loc)) return h;
  return h ? `${h} | ${loc}` : loc;
}

/** "May 2027" -> "Graduation May 2027". */
function graduationLine(date?: string): string {
  const d = (date ?? "").trim();
  if (!d) return "";
  return /graduat/i.test(d) ? d : `Graduation ${d}`;
}

/** "Systems & AI" -> "Concentrations: Systems & AI". */
function concentrationLine(text?: string): string {
  const t = (text ?? "").trim();
  if (!t) return "";
  return /^concentrations?\s*:/i.test(t) ? t : `Concentrations: ${t}`;
}

/**
 * The degree's own italic line, with the GPA folded onto its tail:
 * "B.S Computer Science" + "3.7/4.0" -> "B.S Computer Science - GPA 3.7/4.0".
 * A GPA already written into the degree text wins (v1 profiles did exactly
 * that), and a bare "GPA " prefix on the gpa field is not doubled.
 */
function degreeLine(degree: string, gpa?: string): string {
  const d = degree.trim();
  const g = (gpa ?? "").trim().replace(/^gpa\s*:?\s*/i, "");
  if (!g || /\bgpa\b/i.test(d)) return d;
  return d ? `${d} - GPA ${g}` : `GPA ${g}`;
}

// --- per-section renderers ----------------------------------------------------
// renderSection dispatches on section.kind and pushes the same nodes the v1
// renderer produced. The generic `renderedCount > 0` separator rule down in
// buildRenderNodes reproduces v1's "no separator before Education, one before
// every other populated section" behavior as long as Education is the first
// populated section, which it always is in a migrated v1 profile.

function sectionHasContent(
  profile: ProfileV2,
  section: Section,
  content: TailoredContent,
  variant: string,
): boolean {
  switch (section.kind) {
    case "skills":
      return (
        (profile.skills.languages ?? []).length > 0 ||
        (profile.skills.tools ?? []).length > 0 ||
        (profile.skills.certifications ?? []).length > 0
      );
    case "projects":
      return content.projects.length > 0;
    default:
      return visibleEntries(section, variant).length > 0;
  }
}

// Render one section's entries. `visible` is already filtered/ordered by the
// caller (education/experience/custom/community) or is content.projects.
function renderSection(
  section: Section,
  profile: ProfileV2,
  content: TailoredContent,
  variant: string,
): ParaSpec[] {
  const nodes: ParaSpec[] = [];
  switch (section.kind) {
    case "education": {
      const visible = visibleEntries(section, variant);
      visible.forEach((entry, ei) => {
        const degrees = entry.degrees ?? [];
        // The heading line carries the institution, its location, and the FIRST
        // degree's graduation date in the right-hand column. `entry.date` is the
        // migrated-v1 fallback for profiles written before degrees[] existed.
        nodes.push(
          datedLineSpec(
            [{ text: institutionLine(entry.heading, entry.location), bold: true }],
            graduationLine(degrees[0]?.grad_date || entry.date),
            SZ_EDU,
          ),
        );
        degrees.forEach((d, di) => {
          const text = degreeLine(d.degree, d.gpa);
          // Degree 1 renders undated - its date is already on the heading line
          // above it. Every later degree carries its own graduation date.
          if (di === 0) {
            if (text) nodes.push(plainSpec(text, SZ_EDU, { italics: true }));
          } else if (text || d.grad_date) {
            nodes.push(
              datedLineSpec(
                [{ text, italics: true }],
                graduationLine(d.grad_date),
                SZ_EDU,
              ),
            );
          }
          const conc = concentrationLine(d.concentration);
          if (conc) nodes.push(plainSpec(conc, SZ_EDU, { italics: true }));
        });
        for (const x of entry.extras ?? []) {
          nodes.push(
            datedLineSpec([{ text: x.text, italics: x.italics ?? true }], x.date ?? "", SZ_EDU),
          );
        }
        for (const b of bulletsFor(entry, variant)) nodes.push(bulletSpec(b));
        if (ei < visible.length - 1) nodes.push(separatorSpec());
      });
      // Once, after all education entries, and ONLY when there is coursework to
      // list - an empty list used to emit a bare "Coursework:" label with
      // nothing after it, which reads as a bug on the printed page.
      const coursework = (profile.skills.coursework ?? []).map(skillNamed).join(", ");
      if (coursework) {
        nodes.push(
          paraSpec([
            run("Coursework:", SZ_EDU, { bold: true }),
            run(` ${coursework}`, SZ_EDU),
          ]),
        );
      }
      break;
    }
    case "experience":
    case "custom": {
      const visible = visibleEntries(section, variant);
      visible.forEach((entry, ei) => {
        nodes.push(
          datedLineSpec([{ text: entry.heading, bold: true }], entry.location ?? "", SZ_BODY),
        );
        if (entry.subheading) {
          nodes.push(datedLineSpec([{ text: entry.subheading, italics: true }], entry.date, SZ_BODY));
        }
        for (const b of bulletsFor(entry, variant)) nodes.push(bulletSpec(b));
        if (ei < visible.length - 1) nodes.push(separatorSpec());
      });
      break;
    }
    case "projects": {
      content.projects.forEach((p, i) => {
        nodes.push(
          datedLineSpec(
            [
              { text: `${p.name} | `, bold: true },
              { text: p.tech, italics: true },
            ],
            p.date,
            SZ_BODY,
          ),
        );
        for (const b of p.bullets) nodes.push(bulletSpec(b));
        if (i < content.projects.length - 1) nodes.push(separatorSpec());
      });
      break;
    }
    case "community": {
      const visible = visibleEntries(section, variant);
      visible.forEach((entry, ei) => {
        const runs = entry.headingRuns ?? [{ text: entry.heading, bold: true }];
        nodes.push(datedLineSpec(runs, entry.date, SZ_BODY));
        for (const b of bulletsFor(entry, variant)) nodes.push(bulletSpec(b));
        if (ei < visible.length - 1) nodes.push(separatorSpec());
      });
      break;
    }
    case "skills": {
      const skills = profile.skills;
      const skillSpecs: [string, string][] = [
        ["Languages:", (skills.languages ?? []).map(skillNamed).join(", ")],
        ["Systems & Tools:", (skills.tools ?? []).map(skillNamed).join(", ")],
        ["Certifications:", (skills.certifications ?? []).join(", ")],
      ];
      for (const [label, value] of skillSpecs) {
        if (value) {
          nodes.push(paraSpec([run(label, SZ_EDU, { bold: true }), run(` ${value}`, SZ_EDU)]));
        }
      }
      break;
    }
  }
  return nodes;
}

// Build the full ordered paragraph list (render.py.render order).
function buildRenderNodes(
  profile: ProfileV2,
  content: TailoredContent,
  variant: string = "base",
): ParaSpec[] {
  const nodes: ParaSpec[] = [];

  // header
  nodes.push(paraSpec([run(profile.header.name, SZ_NAME, { bold: true })], { align: "center" }));
  nodes.push(paraSpec([run(profile.header.contact_line, SZ_CONTACT)], { align: "center" }));

  const linkRuns: RunSpec[] = [];
  if (profile.header.citizen_prefix) {
    linkRuns.push(run(profile.header.citizen_prefix, SZ_CONTACT));
  }
  (profile.header.links ?? []).forEach((l, i) => {
    if (i > 0) linkRuns.push(run(" | ", SZ_CONTACT));
    linkRuns.push(run(l.text, SZ_CONTACT, { color: LINK_COLOR, link: l.url }));
  });
  nodes.push(paraSpec(linkRuns, { align: "center" }));

  let renderedCount = 0;
  for (const section of profile.sections) {
    if (!sectionHasContent(profile, section, content, variant)) continue;
    if (renderedCount > 0) nodes.push(separatorSpec());
    nodes.push(sectionHeaderSpec(section.title));
    nodes.push(...renderSection(section, profile, content, variant));
    renderedCount++;
  }

  return nodes;
}

// --- public pure functions --------------------------------------------------

/** `First_Last_Company.docx` - mirrors src/resume/build.py out_name(). */
export function resumeFilename(profileArg: ProfileV2, company: string): string {
  const profile = toV2(profileArg);
  const tokens = profile.header.name.trim().split(/\s+/);
  const first = tokens[0] ?? "";
  const surname = tokens[tokens.length - 1] ?? "";
  const slug = company.replace(/[^A-Za-z0-9]+/g, "") || "Tailored";
  return `${first}_${surname}_${slug}.docx`;
}

/**
 * The ordered rendered text lines for a profile + tailored content - one
 * string per paragraph, section headers included. Same source of truth as
 * composeResumeDoc; used by tests to assert sections and their order.
 * Accepts a v1 shape too (migrated on the fly via toV2) so stale documents
 * still render.
 */
export function resumeOutline(
  profileArg: ProfileV2,
  content: TailoredContent,
  variant: string = "base",
): string[] {
  const p = toV2(profileArg);
  return buildRenderNodes(p, content, variant).map((n) => n.runs.map((r) => r.text).join(""));
}

/** Entries of the projects section (or [] if the profile has none). */
export function projectEntries(p: ProfileV2): Entry[] {
  const section = p.sections.find((s) => s.kind === "projects");
  return section ? section.entries : [];
}

/**
 * Split a run's text on tab characters into proper OOXML `<w:tab/>` elements.
 *
 * A RunSpec carries "\t" inline because that is what `resumeOutline` flattens
 * (and what python-docx writes). Word honours a literal tab inside `<w:t>`, but
 * `<w:tab/>` is the canonical element - every other OOXML consumer, including
 * the in-app .docx preview, only recognises the element form and renders the
 * bare character as a fixed-width space, collapsing every right-aligned date
 * column onto its heading. Same bytes in Word, correct everywhere else.
 *
 * Applied ONLY to the right-tab dated lines (see toParagraph). Bullet
 * paragraphs keep their literal tab: they combine a tab with a hanging indent,
 * and docx-preview's tab-stop solver double-counts the paragraph's left margin
 * in that case, blowing the "● <tab> text" gap out to well over an inch. Word
 * renders both forms identically, so the narrower conversion is all upside.
 *
 * Returns undefined when there is no tab, so the plain `text` option is used.
 */
function runChildren(text: string): (string | Tab)[] | undefined {
  if (!text.includes("\t")) return undefined;
  const out: (string | Tab)[] = [];
  text.split("\t").forEach((part, i) => {
    if (i > 0) out.push(new Tab());
    if (part) out.push(part);
  });
  return out;
}

/** Map one RenderNode to a docx Paragraph. */
function toParagraph(node: ParaSpec): Paragraph {
  const spacing = {
    before: 0,
    after: Math.round((node.afterPt ?? 0) * 20),
    line: LINE_SINGLE,
  };
  const children: (TextRun | ExternalHyperlink)[] = node.runs.map((r) => {
    const font = { ascii: FONT, hAnsi: FONT, cs: FONT };
    const tabbed = node.rightTab ? runChildren(r.text) : undefined;
    const props = {
      ...(tabbed ? { children: tabbed } : { text: r.text }),
      bold: r.bold,
      italics: r.italics,
      color: r.color,
      underline: r.link ? {} : undefined,
      font,
      size: r.size,
    };
    if (r.link) {
      return new ExternalHyperlink({ link: r.link, children: [new TextRun(props)] });
    }
    return new TextRun(props);
  });
  // docx@9.7.1 declares AlignmentType/TabStopType/BorderStyle as `const`
  // objects, not TS enums, so they are values only - the type position needs
  // the union-of-values form, matching the docx package's own .d.ts usage.
  const paragraphOpts: {
    children: (TextRun | ExternalHyperlink)[];
    spacing: { before: number; after: number; line: number };
    alignment?: (typeof AlignmentType)[keyof typeof AlignmentType];
    tabStops?: { type: (typeof TabStopType)[keyof typeof TabStopType]; position: number }[];
    indent?: { left: number; hanging: number };
    border?: {
      bottom: {
        style: (typeof BorderStyle)[keyof typeof BorderStyle];
        size: number;
        space: number;
      };
    };
  } = { children, spacing };
  if (node.align === "center") paragraphOpts.alignment = AlignmentType.CENTER;
  if (node.rightTab) {
    paragraphOpts.tabStops = [{ type: TabStopType.RIGHT, position: RIGHT_TAB_TW }];
  }
  if (node.hanging) {
    paragraphOpts.indent = { left: node.hanging.left, hanging: node.hanging.hanging };
    paragraphOpts.tabStops = [{ type: TabStopType.LEFT, position: node.hanging.tabAt }];
  }
  if (node.borderBottom) {
    paragraphOpts.border = {
      bottom: { style: BorderStyle.SINGLE, size: SECTION_BORDER_SZ8, space: 1 },
    };
  }
  return new Paragraph(paragraphOpts as never);
}

/**
 * Compose the full .docx `Document` for a profile + tailored project content.
 * Section order follows profile.sections (Education, Work Experience,
 * Programming Projects, Community, Skills for a migrated v1 profile) mirroring
 * src/resume/render.py.render. Accepts a v1 shape too (migrated via toV2).
 */
export function composeResumeDoc(
  profileArg: ProfileV2,
  content: TailoredContent,
): Document {
  const p = toV2(profileArg);
  return new Document({
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 720, bottom: 720, left: 720, right: 720 },
          },
        },
        children: buildRenderNodes(p, content).map(toParagraph),
      },
    ],
  });
}
