// The standalone build bundles PDFKit's Node shims and standard font metrics.
// Convex discovers this module from a Node action through a pure renderer
// boundary, so importing the regular entrypoint makes its default bundler try
// to resolve Node built-ins before it applies the action runtime setting.
import PDFDocument from "pdfkit/js/pdfkit.standalone.js";
import { PDFDocument as ParsedPdf } from "pdf-lib";
import { bulletsFor, toV2, visibleEntries } from "../profile_schema";
import type { Entry, ProfileV2, Section, SkillItem } from "../profile_schema";
import { filenameStem, fullResumeContent, type TailoredContent } from "./docx";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 36;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const CONTENT_HEIGHT = PAGE_HEIGHT - MARGIN * 2;
const PAGE_BOTTOM = PAGE_HEIGHT - MARGIN;
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

/**
 * Where the layout draws (or pretends to). The same layout code serves two
 * callers with opposite ideas about the page bottom:
 *
 *  - The one-page tailored build (`buildResumePdf`) measures content as if the
 *    page were infinitely tall and compares that height to SAFE_HEIGHT, then
 *    draws only once the fitter has made it fit. `paginate` is false: nothing
 *    ever moves, so the measured height is the pure content height.
 *  - The full-bank export (`renderFullResumePdf`) wants every entry on as many
 *    pages as it takes. `paginate` is true: a block that would cross the
 *    bottom margin starts a new page instead.
 */
type Canvas = {
  doc: PDFKit.PDFDocument;
  mode: LayoutMode;
  paginate: boolean;
};

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

function addPage(doc: PDFKit.PDFDocument): void {
  doc.addPage({
    size: [PAGE_WIDTH, PAGE_HEIGHT],
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
  });
}

/**
 * The y a block of `height` starting at `y` actually lands on: `y` itself, or
 * the top of a fresh page when pagination is on and the block would cross the
 * bottom margin. A block taller than a whole page stays where it is rather
 * than looping forever - PDFKit then wraps its tail onto the next page.
 *
 * Every block goes through here BEFORE it is drawn, so PDFKit's own overflow
 * pagination never fires mid-block: a block is only ever drawn where it fits.
 */
function place(c: Canvas, y: number, height: number): number {
  if (!c.paginate || y + height <= PAGE_BOTTOM || y <= MARGIN) return y;
  if (c.mode === "draw") addPage(c.doc);
  return MARGIN;
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

type TextOpts = {
  bold?: boolean;
  italic?: boolean;
  align?: "left" | "center" | "right";
  color?: string;
  link?: string;
};

/** Draw text at exactly (x, y) - no placement - and return its height. Used by
 *  the row primitives that place a whole row once, then draw its cells. */
function drawText(
  c: Canvas,
  text: string,
  x: number,
  y: number,
  width: number,
  size: number,
  opts: TextOpts = {},
): number {
  const height = textHeight(c.doc, text, width, size, opts);
  if (c.mode === "draw") {
    c.doc
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

/** Place and draw one block of text; returns the y below it. */
function renderText(
  c: Canvas,
  text: string,
  x: number,
  y: number,
  width: number,
  size: number,
  opts: TextOpts = {},
): number {
  const height = textHeight(c.doc, text, width, size, opts);
  const top = place(c, y, height);
  drawText(c, text, x, top, width, size, opts);
  return top + height;
}

function datedLine(
  c: Canvas,
  left: string,
  right: string,
  y: number,
  size: number,
  opts: { bold?: boolean; italic?: boolean } = {},
): number {
  const { doc } = c;
  doc.font(fontFor(opts)).fontSize(size);
  const rightWidth = right ? Math.min(doc.widthOfString(right) + 4, CONTENT_WIDTH * 0.4) : 0;
  const leftWidth = CONTENT_WIDTH - rightWidth - (right ? 12 : 0);
  const leftHeight = textHeight(doc, left, leftWidth, size, opts);
  const rightHeight = right
    ? textHeight(doc, right, rightWidth, size, {})
    : lineHeight(size);
  const rowHeight = Math.max(leftHeight, rightHeight);
  const top = place(c, y, rowHeight);
  if (c.mode === "draw") {
    drawText(c, left, MARGIN, top, leftWidth, size, opts);
    if (right) {
      drawText(c, right, PAGE_WIDTH - MARGIN - rightWidth, top, rightWidth, size, {
        align: "right",
      });
    }
  }
  return top + rowHeight;
}

function bullet(c: Canvas, text: string, y: number): number {
  const height = textHeight(c.doc, text, BULLET_WIDTH, SIZE_BODY);
  const top = place(c, y, height);
  if (c.mode === "draw") {
    drawText(c, "•", BULLET_X, top, 12, SIZE_BODY);
    drawText(c, text, BULLET_TEXT_X, top, BULLET_WIDTH, SIZE_BODY);
  }
  return top + height;
}

/**
 * Keep an entry's heading with the start of its body: if `lines` body lines
 * would not fit under `y`, move to the next page first. Approximate on purpose
 * (a line count, not measured text) - it only decides where a page may break,
 * and a no-op without pagination.
 */
function keepWithNext(c: Canvas, y: number, lines: number): number {
  return place(c, y, lineHeight(SIZE_BODY) * lines);
}

function sectionHeader(c: Canvas, title: string, y: number): number {
  const height = textHeight(c.doc, title, CONTENT_WIDTH, SIZE_SECTION, { bold: true });
  // Keep the header with at least one body line so a page never ends on a
  // heading whose content starts on the next one.
  const top = place(c, y, height + 2 + lineHeight(SIZE_BODY));
  if (c.mode === "draw") {
    drawText(c, title, MARGIN, top, CONTENT_WIDTH, SIZE_SECTION, { bold: true });
    c.doc
      .moveTo(MARGIN, top + height + 0.5)
      .lineTo(PAGE_WIDTH - MARGIN, top + height + 0.5)
      .lineWidth(0.75)
      .strokeColor("#111111")
      .stroke();
  }
  return top + height + 2;
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
  c: Canvas,
  profile: ProfileV2,
  section: Section,
  variant: string,
  yStart: number,
): number {
  let y = yStart;
  const entries = visibleEntries(section, variant);
  entries.forEach((entry, index) => {
    const degrees = entry.degrees ?? [];
    y = keepWithNext(c, y, 2);
    y = datedLine(
      c,
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
          y = renderText(c, text, MARGIN, y, CONTENT_WIDTH, SIZE_EDUCATION, {
            italic: true,
          });
        }
      } else if (text || degree.grad_date) {
        y = datedLine(c, text, graduationText(degree.grad_date), y, SIZE_EDUCATION, {
          italic: true,
        });
      }
      if (degree.concentration) {
        const concentration = /^concentrations?\s*:/i.test(degree.concentration)
          ? degree.concentration
          : `Concentrations: ${degree.concentration}`;
        y = renderText(c, concentration, MARGIN, y, CONTENT_WIDTH, SIZE_EDUCATION, {
          italic: true,
        });
      }
    });
    for (const extra of entry.extras ?? []) {
      y = datedLine(c, extra.text, extra.date ?? "", y, SIZE_EDUCATION, {
        italic: extra.italics ?? true,
      });
    }
    for (const text of bulletsFor(entry, variant)) y = bullet(c, text, y);
    if (index < entries.length - 1) y += lineHeight(SIZE_BODY);
  });
  const coursework = (profile.skills.coursework ?? []).map(skillName).join(", ");
  if (coursework) {
    y = renderText(c, `Coursework: ${coursework}`, MARGIN, y, CONTENT_WIDTH, SIZE_EDUCATION);
  }
  return y;
}

function renderEntries(c: Canvas, section: Section, variant: string, yStart: number): number {
  let y = yStart;
  const entries = visibleEntries(section, variant);
  entries.forEach((entry, index) => {
    y = keepWithNext(c, y, entry.subheading ? 3 : 2);
    if (section.kind === "community") {
      const heading = (entry.headingRuns ?? [{ text: entry.heading }])
        .map((run) => run.text)
        .join("");
      y = datedLine(c, heading, entry.date, y, SIZE_BODY, { bold: true });
    } else {
      y = datedLine(c, entry.heading, entry.location ?? "", y, SIZE_BODY, { bold: true });
      if (entry.subheading) {
        y = datedLine(c, entry.subheading, entry.date, y, SIZE_BODY, { italic: true });
      }
    }
    for (const text of bulletsFor(entry, variant)) y = bullet(c, text, y);
    if (index < entries.length - 1) y += lineHeight(SIZE_BODY);
  });
  return y;
}

function renderProjects(
  c: Canvas,
  projects: TailoredContent["projects"],
  yStart: number,
): number {
  const { doc } = c;
  let y = yStart;
  projects.forEach((project, index) => {
    doc.font(FONT_BOLD).fontSize(SIZE_BODY);
    const dateWidth = Math.min(doc.widthOfString(project.date) + 4, CONTENT_WIDTH * 0.4);
    const leftWidth = CONTENT_WIDTH - dateWidth - 12;
    const nameWidth = doc.widthOfString(project.name);
    doc.font(FONT_REGULAR).fontSize(SIZE_BODY);
    const separator = " | ";
    const separatorWidth = doc.widthOfString(separator);
    const techX = MARGIN + nameWidth + separatorWidth;
    const techWidth = Math.max(1, leftWidth - nameWidth - separatorWidth);
    doc.font(FONT_ITALIC).fontSize(SIZE_BODY);
    const techHeight = textHeight(doc, project.tech, techWidth, SIZE_BODY, { italic: true });
    const headingHeight = lineHeight(SIZE_BODY);
    const dateHeight = textHeight(doc, project.date, dateWidth, SIZE_BODY);
    const rowHeight = Math.max(headingHeight, techHeight, dateHeight);
    const top = place(c, y, rowHeight + (project.bullets.length ? lineHeight(SIZE_BODY) : 0));
    if (c.mode === "draw") {
      // Draw the name and separator without a width constraint. PDFKit only
      // line-wraps constrained text, so the separator cannot become its own
      // line. Only the technology run is allowed to wrap.
      doc.font(FONT_BOLD).fontSize(SIZE_BODY).fillColor("#111111").text(project.name, MARGIN, top, {
        lineBreak: false,
      });
      doc.font(FONT_REGULAR).fontSize(SIZE_BODY).text(separator, MARGIN + nameWidth, top, {
        lineBreak: false,
      });
      drawText(c, project.tech, techX, top, techWidth, SIZE_BODY, { italic: true });
      drawText(c, project.date, PAGE_WIDTH - MARGIN - dateWidth, top, dateWidth, SIZE_BODY, {
        align: "right",
      });
    }
    y = top + rowHeight;
    for (const text of project.bullets) y = bullet(c, text, y);
    if (index < projects.length - 1) y += lineHeight(SIZE_BODY);
  });
  return y;
}

function renderSkills(c: Canvas, profile: ProfileV2, yStart: number): number {
  let y = yStart;
  const rows: [string, string][] = [
    ["Languages", (profile.skills.languages ?? []).map(skillName).join(", ")],
    ["Systems & Tools", (profile.skills.tools ?? []).map(skillName).join(", ")],
    ["Certifications", (profile.skills.certifications ?? []).join(", ")],
  ];
  for (const [label, value] of rows) {
    if (!value) continue;
    y = renderText(c, `${label}: ${value}`, MARGIN, y, CONTENT_WIDTH, SIZE_EDUCATION);
  }
  return y;
}

function sectionHasContent(
  profile: ProfileV2,
  section: Section,
  content: TailoredContent,
  variant: string,
): boolean {
  if (section.kind === "projects") return content.projects.length > 0;
  if (section.kind === "skills") {
    return Boolean(
      profile.skills.languages?.length ||
        profile.skills.tools?.length ||
        profile.skills.certifications?.length,
    );
  }
  return visibleEntries(section, variant).length > 0;
}

/**
 * Lay the whole resume out from the top margin down and return the y below
 * the last block. Without pagination that is MARGIN + the content height
 * (what the fitter measures); with it, a y on whichever page the layout
 * ended on.
 *
 * `variant` picks the bullets and hidden entries for every non-project
 * section; projects arrive pre-selected in `content` (the tailored build
 * chooses per project, the full export via fullResumeContent).
 */
function layout(
  c: Canvas,
  profileArg: ProfileV2,
  content: TailoredContent,
  variant: string,
): number {
  const profile = toV2(profileArg);
  const { doc } = c;
  let y = MARGIN;
  y = renderText(c, profile.header.name, MARGIN, y, CONTENT_WIDTH, SIZE_NAME, {
    bold: true,
    align: "center",
  });
  y = renderText(c, profile.header.contact_line, MARGIN, y, CONTENT_WIDTH, SIZE_CONTACT, {
    align: "center",
  });
  const links = [
    profile.header.citizen_prefix ?? "",
    ...(profile.header.links ?? []).map((link) => link.text),
  ]
    .filter(Boolean)
    .join(" | ");
  y = renderText(c, links, MARGIN, y, CONTENT_WIDTH, SIZE_CONTACT, { align: "center" });
  if (c.mode === "draw" && profile.header.links?.length) {
    const headerLink = profile.header.links[0];
    const linkWidth = doc.font(FONT_REGULAR).fontSize(SIZE_CONTACT).widthOfString(headerLink.text);
    doc.link((PAGE_WIDTH - linkWidth) / 2, y - lineHeight(SIZE_CONTACT), linkWidth, lineHeight(SIZE_CONTACT), headerLink.url);
  }

  let renderedSections = 0;
  for (const section of profile.sections) {
    if (!sectionHasContent(profile, section, content, variant)) continue;
    if (renderedSections > 0) y += SECTION_GAP;
    y = sectionHeader(c, section.title, y);
    if (section.kind === "education") {
      y = renderEducation(c, profile, section, variant, y);
    } else if (section.kind === "projects") {
      y = renderProjects(c, content.projects, y);
    } else if (section.kind === "skills") {
      y = renderSkills(c, profile, y);
    } else {
      y = renderEntries(c, section, variant, y);
    }
    renderedSections += 1;
  }
  return y;
}

function createPdfDocument(title: string): PDFKit.PDFDocument {
  return new PDFDocument({
    autoFirstPage: false,
    bufferPages: true,
    compress: true,
    info: {
      Title: title,
      Creator: "intern-watch",
      Producer: "PDFKit",
    },
  });
}

export function measureResumePdf(profile: ProfileV2, content: TailoredContent): number {
  const doc = createPdfDocument("Tailored Resume");
  addPage(doc);
  const end = layout({ doc, mode: "measure", paginate: false }, profile, content, "base");
  doc.end();
  return end - MARGIN;
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

async function renderBytes(
  profile: ProfileV2,
  content: TailoredContent,
  opts: { title: string; variant: string; paginate: boolean },
): Promise<Uint8Array> {
  const doc = createPdfDocument(opts.title);
  const chunks: Uint8Array[] = [];
  doc.on("data", (chunk: Uint8Array) => chunks.push(chunk));
  const finished = new Promise<Uint8Array>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  addPage(doc);
  layout({ doc, mode: "draw", paginate: opts.paginate }, profile, content, opts.variant);
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
  const bytes = await renderBytes(fitted.profile, fitted.content, {
    title: "Tailored Resume",
    variant: "base",
    paginate: false,
  });
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

/**
 * The whole bank for one variant, as-is: every entry the variant shows, every
 * project, every bullet, on as many US Letter pages as that takes. No JD, no
 * LLM, no fitting - this is the "download my full resume" of the profile
 * editor, not a tailored build.
 */
export async function renderFullResumePdf(
  profileArg: ProfileV2,
  variant: string,
): Promise<Uint8Array> {
  const profile = toV2(profileArg);
  return await renderBytes(profile, fullResumeContent(profile, variant), {
    title: "Resume",
    variant,
    paginate: true,
  });
}

export function pdfFilename(profileArg: ProfileV2, company: string): string {
  const companySlug = company.replace(/[^A-Za-z0-9]+/g, "") || "Tailored";
  return `${filenameStem(profileArg)}_${companySlug}.pdf`;
}
