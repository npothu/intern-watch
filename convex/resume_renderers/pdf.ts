// The standalone build bundles PDFKit's Node shims and standard font metrics.
// Convex discovers this module from a Node action through a pure renderer
// boundary, so importing the regular entrypoint makes its default bundler try
// to resolve Node built-ins before it applies the action runtime setting.
import PDFDocument from "pdfkit/js/pdfkit.standalone.js";
import { PDFDocument as ParsedPdf } from "pdf-lib";
import { bulletsFor, toV2, visibleEntries } from "../profile_schema";
import type { Entry, ProfileV2, Section, SkillItem } from "../profile_schema";
import type { TailoredContent } from "./docx";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 36;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const CONTENT_HEIGHT = PAGE_HEIGHT - MARGIN * 2;
const SAFE_HEIGHT = CONTENT_HEIGHT * 0.98;

const FONT_REGULAR = "Times-Roman";
const FONT_BOLD = "Times-Bold";
const FONT_ITALIC = "Times-Italic";
const FONT_BOLD_ITALIC = "Times-BoldItalic";

const SIZE_NAME = 10;
const SIZE_CONTACT = 10;
const SIZE_SECTION = 13;
const SIZE_EDUCATION = 10;
const SIZE_BODY = 11;

const BULLET_X = MARGIN + 18;
const BULLET_TEXT_X = MARGIN + 36;
const BULLET_WIDTH = PAGE_WIDTH - MARGIN - BULLET_TEXT_X;
const SECTION_GAP = SIZE_BODY * 1.12;

export type PdfFitNote = {
  kind: "condense" | "drop" | "trim";
  message: string;
};

export type PdfBuildResult = {
  bytes: Uint8Array;
  pages: number;
  heightPt: number;
  safeHeightPt: number;
  profile: ProfileV2;
  content: TailoredContent;
  notes: PdfFitNote[];
};

export type PdfFitOptions = {
  scores: Record<string, number>;
  minimumProjects?: number;
};

type LayoutMode = "measure" | "draw";

function skillName(item: SkillItem): string {
  return typeof item === "string" ? item : item.name;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function fontFor(opts: { bold?: boolean; italic?: boolean }): string {
  if (opts.bold && opts.italic) return FONT_BOLD_ITALIC;
  if (opts.bold) return FONT_BOLD;
  if (opts.italic) return FONT_ITALIC;
  return FONT_REGULAR;
}

function lineHeight(size: number): number {
  return size * 1.15;
}

function textHeight(
  doc: PDFKit.PDFDocument,
  text: string,
  width: number,
  size: number,
  opts: { bold?: boolean; italic?: boolean } = {},
): number {
  doc.font(fontFor(opts)).fontSize(size);
  return doc.heightOfString(text || " ", { width, lineGap: 0 });
}

function renderText(
  doc: PDFKit.PDFDocument,
  mode: LayoutMode,
  text: string,
  x: number,
  y: number,
  width: number,
  size: number,
  opts: {
    bold?: boolean;
    italic?: boolean;
    align?: "left" | "center" | "right";
    color?: string;
    link?: string;
  } = {},
): number {
  const height = textHeight(doc, text, width, size, opts);
  if (mode === "draw") {
    doc
      .font(fontFor(opts))
      .fontSize(size)
      .fillColor(opts.color ?? "#111111")
      .text(text, x, y, {
        width,
        lineGap: 0,
        align: opts.align ?? "left",
        link: opts.link,
        underline: Boolean(opts.link),
      });
  }
  return height;
}

function datedLine(
  doc: PDFKit.PDFDocument,
  mode: LayoutMode,
  left: string,
  right: string,
  y: number,
  size: number,
  opts: { bold?: boolean; italic?: boolean } = {},
): number {
  doc.font(fontFor(opts)).fontSize(size);
  const rightWidth = right ? Math.min(doc.widthOfString(right) + 4, CONTENT_WIDTH * 0.4) : 0;
  const leftWidth = CONTENT_WIDTH - rightWidth - (right ? 12 : 0);
  const leftHeight = textHeight(doc, left, leftWidth, size, opts);
  const rightHeight = right
    ? textHeight(doc, right, rightWidth, size, {})
    : lineHeight(size);
  if (mode === "draw") {
    renderText(doc, mode, left, MARGIN, y, leftWidth, size, opts);
    if (right) {
      renderText(
        doc,
        mode,
        right,
        PAGE_WIDTH - MARGIN - rightWidth,
        y,
        rightWidth,
        size,
        { align: "right" },
      );
    }
  }
  return Math.max(leftHeight, rightHeight);
}

function bullet(
  doc: PDFKit.PDFDocument,
  mode: LayoutMode,
  text: string,
  y: number,
): number {
  const height = textHeight(doc, text, BULLET_WIDTH, SIZE_BODY);
  if (mode === "draw") {
    renderText(doc, mode, "•", BULLET_X, y, 12, SIZE_BODY);
    renderText(doc, mode, text, BULLET_TEXT_X, y, BULLET_WIDTH, SIZE_BODY);
  }
  return height;
}

function sectionHeader(
  doc: PDFKit.PDFDocument,
  mode: LayoutMode,
  title: string,
  y: number,
): number {
  const height = textHeight(doc, title, CONTENT_WIDTH, SIZE_SECTION, { bold: true });
  if (mode === "draw") {
    renderText(doc, mode, title, MARGIN, y, CONTENT_WIDTH, SIZE_SECTION, { bold: true });
    doc
      .moveTo(MARGIN, y + height + 0.5)
      .lineTo(PAGE_WIDTH - MARGIN, y + height + 0.5)
      .lineWidth(0.75)
      .strokeColor("#111111")
      .stroke();
  }
  return height + 2;
}

function degreeText(degree: string, gpa?: string): string {
  const cleanGpa = (gpa ?? "").trim().replace(/^gpa\s*:?\s*/i, "");
  if (!cleanGpa || /\bgpa\b/i.test(degree)) return degree;
  return `${degree} - GPA ${cleanGpa}`;
}

function graduationText(value?: string): string {
  const clean = (value ?? "").trim();
  if (!clean) return "";
  return /graduat/i.test(clean) ? clean : `Graduation ${clean}`;
}

function institutionText(entry: Entry): string {
  const location = (entry.location ?? "").trim();
  if (!location || entry.heading.includes(location)) return entry.heading;
  return `${entry.heading} | ${location}`;
}

function renderEducation(
  doc: PDFKit.PDFDocument,
  mode: LayoutMode,
  profile: ProfileV2,
  section: Section,
  yStart: number,
): number {
  let y = yStart;
  const entries = visibleEntries(section, "base");
  entries.forEach((entry, index) => {
    const degrees = entry.degrees ?? [];
    y += datedLine(
      doc,
      mode,
      institutionText(entry),
      graduationText(degrees[0]?.grad_date || entry.date),
      y,
      SIZE_EDUCATION,
      { bold: true },
    );
    degrees.forEach((degree, degreeIndex) => {
      const text = degreeText(degree.degree, degree.gpa);
      if (degreeIndex === 0) {
        if (text) {
          y += renderText(doc, mode, text, MARGIN, y, CONTENT_WIDTH, SIZE_EDUCATION, {
            italic: true,
          });
        }
      } else if (text || degree.grad_date) {
        y += datedLine(
          doc,
          mode,
          text,
          graduationText(degree.grad_date),
          y,
          SIZE_EDUCATION,
          { italic: true },
        );
      }
      if (degree.concentration) {
        const concentration = /^concentrations?\s*:/i.test(degree.concentration)
          ? degree.concentration
          : `Concentrations: ${degree.concentration}`;
        y += renderText(
          doc,
          mode,
          concentration,
          MARGIN,
          y,
          CONTENT_WIDTH,
          SIZE_EDUCATION,
          { italic: true },
        );
      }
    });
    for (const extra of entry.extras ?? []) {
      y += datedLine(
        doc,
        mode,
        extra.text,
        extra.date ?? "",
        y,
        SIZE_EDUCATION,
        { italic: extra.italics ?? true },
      );
    }
    for (const text of bulletsFor(entry, "base")) y += bullet(doc, mode, text, y);
    if (index < entries.length - 1) y += lineHeight(SIZE_BODY);
  });
  const coursework = (profile.skills.coursework ?? []).map(skillName).join(", ");
  if (coursework) {
    y += renderText(
      doc,
      mode,
      `Coursework: ${coursework}`,
      MARGIN,
      y,
      CONTENT_WIDTH,
      SIZE_EDUCATION,
    );
  }
  return y - yStart;
}

function renderEntries(
  doc: PDFKit.PDFDocument,
  mode: LayoutMode,
  section: Section,
  yStart: number,
): number {
  let y = yStart;
  const entries = visibleEntries(section, "base");
  entries.forEach((entry, index) => {
    if (section.kind === "community") {
      const heading = (entry.headingRuns ?? [{ text: entry.heading }])
        .map((run) => run.text)
        .join("");
      y += datedLine(doc, mode, heading, entry.date, y, SIZE_BODY, { bold: true });
    } else {
      y += datedLine(
        doc,
        mode,
        entry.heading,
        entry.location ?? "",
        y,
        SIZE_BODY,
        { bold: true },
      );
      if (entry.subheading) {
        y += datedLine(doc, mode, entry.subheading, entry.date, y, SIZE_BODY, {
          italic: true,
        });
      }
    }
    for (const text of bulletsFor(entry, "base")) y += bullet(doc, mode, text, y);
    if (index < entries.length - 1) y += lineHeight(SIZE_BODY);
  });
  return y - yStart;
}

function renderProjects(
  doc: PDFKit.PDFDocument,
  mode: LayoutMode,
  projects: TailoredContent["projects"],
  yStart: number,
): number {
  let y = yStart;
  projects.forEach((project, index) => {
    doc.font(FONT_BOLD).fontSize(SIZE_BODY);
    const dateWidth = Math.min(doc.widthOfString(project.date) + 4, CONTENT_WIDTH * 0.4);
    const leftWidth = CONTENT_WIDTH - dateWidth - 12;
    const heading = `${project.name} | `;
    // PDFKit may wrap the final glyph when a width exactly equals its metrics.
    // Keep a small tolerance so a trailing separator cannot orphan itself.
    const headingWidth = doc.widthOfString(heading) + 2;
    doc.font(FONT_ITALIC).fontSize(SIZE_BODY);
    const techHeight = textHeight(
      doc,
      project.tech,
      Math.max(1, leftWidth - headingWidth),
      SIZE_BODY,
      { italic: true },
    );
    const headingHeight = textHeight(doc, heading, headingWidth, SIZE_BODY, { bold: true });
    const dateHeight = textHeight(doc, project.date, dateWidth, SIZE_BODY);
    const rowHeight = Math.max(headingHeight, techHeight, dateHeight);
    if (mode === "draw") {
      renderText(doc, mode, heading, MARGIN, y, headingWidth, SIZE_BODY, {
        bold: true,
      });
      renderText(
        doc,
        mode,
        project.tech,
        MARGIN + headingWidth,
        y,
        Math.max(1, leftWidth - headingWidth),
        SIZE_BODY,
        { italic: true },
      );
      renderText(
        doc,
        mode,
        project.date,
        PAGE_WIDTH - MARGIN - dateWidth,
        y,
        dateWidth,
        SIZE_BODY,
        { align: "right" },
      );
    }
    y += rowHeight;
    for (const text of project.bullets) y += bullet(doc, mode, text, y);
    if (index < projects.length - 1) y += lineHeight(SIZE_BODY);
  });
  return y - yStart;
}

function renderSkills(
  doc: PDFKit.PDFDocument,
  mode: LayoutMode,
  profile: ProfileV2,
  yStart: number,
): number {
  let y = yStart;
  const rows: [string, string][] = [
    ["Languages", (profile.skills.languages ?? []).map(skillName).join(", ")],
    ["Systems & Tools", (profile.skills.tools ?? []).map(skillName).join(", ")],
    ["Certifications", (profile.skills.certifications ?? []).join(", ")],
  ];
  for (const [label, value] of rows) {
    if (!value) continue;
    y += renderText(
      doc,
      mode,
      `${label}: ${value}`,
      MARGIN,
      y,
      CONTENT_WIDTH,
      SIZE_EDUCATION,
    );
  }
  return y - yStart;
}

function sectionHasContent(
  profile: ProfileV2,
  section: Section,
  content: TailoredContent,
): boolean {
  if (section.kind === "projects") return content.projects.length > 0;
  if (section.kind === "skills") {
    return Boolean(
      profile.skills.languages?.length ||
        profile.skills.tools?.length ||
        profile.skills.certifications?.length,
    );
  }
  return visibleEntries(section, "base").length > 0;
}

function layout(
  doc: PDFKit.PDFDocument,
  mode: LayoutMode,
  profileArg: ProfileV2,
  content: TailoredContent,
): number {
  const profile = toV2(profileArg);
  let y = MARGIN;
  y += renderText(doc, mode, profile.header.name, MARGIN, y, CONTENT_WIDTH, SIZE_NAME, {
    bold: true,
    align: "center",
  });
  y += renderText(
    doc,
    mode,
    profile.header.contact_line,
    MARGIN,
    y,
    CONTENT_WIDTH,
    SIZE_CONTACT,
    { align: "center" },
  );
  const links = [
    (profile.header.citizen_prefix ?? "").replace(/[|\s]+$/, ""),
    ...(profile.header.links ?? []).map((link) => link.text),
  ]
    .filter(Boolean)
    .join(" | ");
  y += renderText(doc, mode, links, MARGIN, y, CONTENT_WIDTH, SIZE_CONTACT, {
    align: "center",
  });
  if (mode === "draw" && profile.header.links?.length) {
    const headerLink = profile.header.links[0];
    const linkWidth = doc.font(FONT_REGULAR).fontSize(SIZE_CONTACT).widthOfString(headerLink.text);
    doc.link((PAGE_WIDTH - linkWidth) / 2, y - lineHeight(SIZE_CONTACT), linkWidth, lineHeight(SIZE_CONTACT), headerLink.url);
  }

  let renderedSections = 0;
  for (const section of profile.sections) {
    if (!sectionHasContent(profile, section, content)) continue;
    if (renderedSections > 0) y += SECTION_GAP;
    y += sectionHeader(doc, mode, section.title, y);
    if (section.kind === "education") {
      y += renderEducation(doc, mode, profile, section, y);
    } else if (section.kind === "projects") {
      y += renderProjects(doc, mode, content.projects, y);
    } else if (section.kind === "skills") {
      y += renderSkills(doc, mode, profile, y);
    } else {
      y += renderEntries(doc, mode, section, y);
    }
    renderedSections += 1;
  }
  return y - MARGIN;
}

function createPdfDocument(): PDFKit.PDFDocument {
  return new PDFDocument({
    autoFirstPage: false,
    bufferPages: true,
    compress: true,
    info: {
      Title: "Tailored Resume",
      Creator: "intern-watch",
      Producer: "PDFKit",
    },
  });
}

export function measureResumePdf(profile: ProfileV2, content: TailoredContent): number {
  const doc = createPdfDocument();
  doc.addPage({ size: [PAGE_WIDTH, PAGE_HEIGHT], margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } });
  const height = layout(doc, "measure", profile, content);
  doc.end();
  return height;
}

function shortestBullets(entry: Entry): { variant: string; bullets: string[] } {
  const variants = Object.entries(entry.bullets);
  if (!variants.length) return { variant: "base", bullets: [] };
  const [variant, bullets] = variants.reduce((best, candidate) => {
    const bestLength = best[1].reduce((sum, text) => sum + text.length, 0);
    const candidateLength = candidate[1].reduce((sum, text) => sum + text.length, 0);
    return candidateLength < bestLength ? candidate : best;
  });
  return { variant, bullets: [...bullets] };
}

function findSection(profile: ProfileV2, kind: Section["kind"]): Section | undefined {
  return profile.sections.find((section) => section.kind === kind);
}

export function fitResumePdf(
  profileArg: ProfileV2,
  contentArg: TailoredContent,
  options: PdfFitOptions,
): { profile: ProfileV2; content: TailoredContent; heightPt: number; notes: PdfFitNote[] } {
  const profile = clone(toV2(profileArg));
  const content = clone(contentArg);
  const notes: PdfFitNote[] = [];
  const minProjects = options.minimumProjects ?? 4;
  const height = () => measureResumePdf(profile, content);
  let measured = height();
  if (measured <= SAFE_HEIGHT) return { profile, content, heightPt: measured, notes };

  const community = findSection(profile, "community");
  for (const entry of community?.entries ?? []) {
    const shortest = shortestBullets(entry);
    const current = bulletsFor(entry, "base");
    if (shortest.bullets.join("\n") === current.join("\n")) continue;
    entry.bullets.base = shortest.bullets;
    notes.push({ kind: "condense", message: `Condensed ${entry.heading} to ${shortest.variant}` });
    measured = height();
    if (measured <= SAFE_HEIGHT) return { profile, content, heightPt: measured, notes };
  }

  while ((community?.entries.length ?? 0) > 1) {
    const dropped = community!.entries.pop()!;
    notes.push({ kind: "drop", message: `Dropped community entry ${dropped.heading}` });
    measured = height();
    if (measured <= SAFE_HEIGHT) return { profile, content, heightPt: measured, notes };
  }

  while (content.projects.length > minProjects) {
    const dropped = [...content.projects].sort(
      (a, b) => (options.scores[a.name] ?? 0) - (options.scores[b.name] ?? 0),
    )[0];
    content.projects = content.projects.filter((project) => project.name !== dropped.name);
    notes.push({ kind: "drop", message: `Dropped project ${dropped.name}` });
    measured = height();
    if (measured <= SAFE_HEIGHT) return { profile, content, heightPt: measured, notes };
  }

  while (measured > SAFE_HEIGHT) {
    const communityCandidate = [...(community?.entries ?? [])]
      .reverse()
      .find((entry) => entry.bullets.base.length > 1);
    if (communityCandidate) {
      communityCandidate.bullets.base.pop();
      notes.push({ kind: "trim", message: `Trimmed a bullet from ${communityCandidate.heading}` });
      measured = height();
      continue;
    }
    const projectCandidate = [...content.projects]
      .sort((a, b) => (options.scores[a.name] ?? 0) - (options.scores[b.name] ?? 0))
      .find((project) => project.bullets.length > 1);
    if (!projectCandidate) break;
    projectCandidate.bullets.pop();
    notes.push({ kind: "trim", message: `Trimmed a bullet from ${projectCandidate.name}` });
    measured = height();
  }
  return { profile, content, heightPt: measured, notes };
}

async function renderBytes(profile: ProfileV2, content: TailoredContent): Promise<Uint8Array> {
  const doc = createPdfDocument();
  const chunks: Uint8Array[] = [];
  doc.on("data", (chunk: Uint8Array) => chunks.push(chunk));
  const finished = new Promise<Uint8Array>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.addPage({
    size: [PAGE_WIDTH, PAGE_HEIGHT],
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
  });
  layout(doc, "draw", profile, content);
  doc.end();
  return await finished;
}

export async function validateResumePdf(bytes: Uint8Array): Promise<{ pages: number }> {
  const pdf = await ParsedPdf.load(bytes);
  const pages = pdf.getPageCount();
  if (pages !== 1) throw new Error(`PDF validation failed: expected one page, got ${pages}`);
  const [page] = pdf.getPages();
  const { width, height } = page.getSize();
  if (Math.abs(width - PAGE_WIDTH) > 0.1 || Math.abs(height - PAGE_HEIGHT) > 0.1) {
    throw new Error(`PDF validation failed: expected US Letter, got ${width}x${height}pt`);
  }
  return { pages };
}

export async function buildResumePdf(
  profile: ProfileV2,
  content: TailoredContent,
  options: PdfFitOptions,
): Promise<PdfBuildResult> {
  const fitted = fitResumePdf(profile, content, options);
  if (fitted.heightPt > SAFE_HEIGHT) {
    throw new Error(
      `Resume cannot fit one page without removing required content (${fitted.heightPt.toFixed(1)}pt > ${SAFE_HEIGHT.toFixed(1)}pt)`,
    );
  }
  const bytes = await renderBytes(fitted.profile, fitted.content);
  const validation = await validateResumePdf(bytes);
  return {
    bytes,
    pages: validation.pages,
    heightPt: fitted.heightPt,
    safeHeightPt: SAFE_HEIGHT,
    profile: fitted.profile,
    content: fitted.content,
    notes: fitted.notes,
  };
}

export function pdfFilename(profileArg: ProfileV2, company: string): string {
  const profile = toV2(profileArg);
  const names = profile.header.name.trim().split(/\s+/);
  const companySlug = company.replace(/[^A-Za-z0-9]+/g, "") || "Tailored";
  return `${names[0] ?? ""}_${names[names.length - 1] ?? ""}_${companySlug}.pdf`;
}
