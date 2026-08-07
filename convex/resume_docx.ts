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
  TabStopType,
  TextRun,
} from "docx";

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

export type HeadingRun = { text: string; bold?: boolean; italics?: boolean };
export type SkillItem = string | { name: string; keywords?: string[] };
export type WorkEntry = {
  location?: string;
  role: string;
  date: string;
  bullets: Record<string, string[]>;
};
export type Project = {
  tech?: string[];
  date: string;
  tags?: string[];
  bullets: Record<string, string[]>;
};
export type CommunityEntry = {
  heading_runs?: HeadingRun[];
  date: string;
  bullets: Record<string, string[]>;
};

/** A user's resume profile (bank) JSON - the shape of users/<user>_resume.json. */
export type Profile = {
  header: {
    name: string;
    contact_line: string;
    citizen_prefix?: string;
    links?: { text: string; url: string }[];
  };
  education: {
    institution: string;
    grad_date: string;
    degree?: string;
    threads?: string;
    gpa?: string;
    graduate_degree?: { degree: string; grad_date: string };
    study_abroad?: { text: string; date: string };
  };
  skills?: {
    coursework?: SkillItem[];
    languages?: SkillItem[];
    tools?: SkillItem[];
    certifications?: string[];
  };
  work_experience?: Record<string, WorkEntry>;
  projects?: Record<string, Project>;
  community?: Record<string, CommunityEntry>;
};

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

// Build the full ordered paragraph list (render.py.render order).
function buildRenderNodes(profile: Profile, content: TailoredContent): ParaSpec[] {
  const nodes: ParaSpec[] = [];
  const edu = profile.education;

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

  // education
  nodes.push(sectionHeaderSpec("Education"));
  nodes.push(datedLineSpec([{ text: edu.institution, bold: true }], edu.grad_date, SZ_EDU));
  for (const line of [edu.degree, edu.threads, edu.gpa]) {
    if (line) nodes.push(plainSpec(line, SZ_EDU, { italics: true }));
  }
  if (edu.graduate_degree) {
    nodes.push(
      datedLineSpec(
        [{ text: edu.graduate_degree.degree, italics: true }],
        edu.graduate_degree.grad_date,
        SZ_EDU,
      ),
    );
  }
  if (edu.study_abroad) {
    nodes.push(
      datedLineSpec([{ text: edu.study_abroad.text, italics: true }], edu.study_abroad.date, SZ_EDU),
    );
  }
  const coursework = (profile.skills?.coursework ?? []).map(skillNamed).join(", ");
  nodes.push(
    paraSpec([
      run("Coursework:", SZ_EDU, { bold: true }),
      run(` ${coursework}`, SZ_EDU),
    ]),
  );

  // work experience
  const work = profile.work_experience ?? {};
  const workNames = Object.keys(work);
  if (workNames.length > 0) {
    nodes.push(separatorSpec());
    nodes.push(sectionHeaderSpec("Work Experience"));
    workNames.forEach((name, i) => {
      const w = work[name];
      nodes.push(datedLineSpec([{ text: name, bold: true }], w.location ?? "", SZ_BODY));
      nodes.push(datedLineSpec([{ text: w.role, italics: true }], w.date, SZ_BODY));
      for (const b of w.bullets.base ?? []) nodes.push(bulletSpec(b));
      if (i < workNames.length - 1) nodes.push(separatorSpec());
    });
  }

  // programming projects (tailored)
  nodes.push(separatorSpec());
  nodes.push(sectionHeaderSpec("Programming Projects"));
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

  // community
  const community = profile.community ?? {};
  const communityNames = Object.keys(community);
  nodes.push(separatorSpec());
  nodes.push(sectionHeaderSpec("Community"));
  communityNames.forEach((name, i) => {
    const c = community[name];
    nodes.push(datedLineSpec(c.heading_runs ?? [], c.date, SZ_BODY));
    for (const b of c.bullets.base ?? []) nodes.push(bulletSpec(b));
    if (i < communityNames.length - 1) nodes.push(separatorSpec());
  });

  // skills
  nodes.push(separatorSpec());
  nodes.push(sectionHeaderSpec("Skills"));
  const skillSpecs: [string, string][] = [
    ["Languages:", (profile.skills?.languages ?? []).map(skillNamed).join(", ")],
    ["Systems & Tools:", (profile.skills?.tools ?? []).map(skillNamed).join(", ")],
    ["Certifications:", (profile.skills?.certifications ?? []).join(", ")],
  ];
  for (const [label, value] of skillSpecs) {
    if (value) {
      nodes.push(paraSpec([run(label, SZ_EDU, { bold: true }), run(` ${value}`, SZ_EDU)]));
    }
  }

  return nodes;
}

// --- public pure functions --------------------------------------------------

/** `First_Last_Company.docx` - mirrors src/resume/build.py out_name(). */
export function resumeFilename(profile: Profile, company: string): string {
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
 */
export function resumeOutline(profile: Profile, content: TailoredContent): string[] {
  return buildRenderNodes(profile, content).map((n) => n.runs.map((r) => r.text).join(""));
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
    const props = {
      text: r.text,
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
 * Section order (header, Education, [Work Experience], Programming Projects,
 * Community, Skills) mirrors src/resume/render.py.render exactly.
 */
export function composeResumeDoc(profile: Profile, content: TailoredContent): Document {
  return new Document({
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 720, bottom: 720, left: 720, right: 720 },
          },
        },
        children: buildRenderNodes(profile, content).map(toParagraph),
      },
    ],
  });
}
