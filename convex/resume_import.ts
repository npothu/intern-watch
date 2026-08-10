import JSZip from "jszip";
import type {
  Degree,
  Entry,
  Extra,
  HeadingRun,
  ProfileV2,
  Section,
  SectionKind,
  SkillItem,
} from "./profile_schema";

export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_XML_BYTES = 2 * 1024 * 1024;
export const MAX_MODEL_INPUT_CHARS = 120_000;
export const MAX_EXTRACTION_PAYLOAD_CHARS = 80_000;

export type ResumeImportFormat = "docx" | "txt" | "md";

export type ExtractedRun = {
  text: string;
  bold: boolean;
  italics: boolean;
  url?: string;
};

export type ExtractedLine = {
  id: string;
  text: string;
  runs: ExtractedRun[];
  bold: boolean;
  italics: boolean;
  hasTab: boolean;
  rightTab: boolean;
  borderBottom: boolean;
  bullet: boolean;
  indentLeft?: number;
  hanging?: number;
};

export type ExtractedResume = {
  format: ResumeImportFormat;
  filename: string;
  lines: ExtractedLine[];
};

export type ImportLineMapping = {
  lineId: string;
  targetPaths: string[];
};

export type ImportSectionSummary = {
  id: string;
  title: string;
  kind: SectionKind;
  count: number;
};

export type ValidatedImport = {
  profile: ProfileV2;
  mappings: ImportLineMapping[];
  fullyMappedLines: { id: string; text: string }[];
  partialMappedLines: { id: string; text: string; droppedText: string }[];
  unmappedLines: { id: string; text: string }[];
  sections: ImportSectionSummary[];
};

export type ProfileValidationResult =
  | { ok: true; profile: ProfileV2 }
  | { ok: false; errors: string[] };

export type ModelOutputValidationResult =
  | { ok: true; value: ValidatedImport }
  | { ok: false; errors: string[] };

const SECTION_KINDS = new Set<SectionKind>([
  "education",
  "experience",
  "projects",
  "community",
  "skills",
  "custom",
]);

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  quot: '"',
};

function decodeXml(text: string): string {
  return text.replace(/&#(x[0-9a-f]+|\d+);|&([a-z]+);/gi, (whole, numeric, named) => {
    if (numeric) {
      const radix = numeric[0].toLowerCase() === "x" ? 16 : 10;
      const value = Number.parseInt(radix === 16 ? numeric.slice(1) : numeric, radix);
      if (
        !Number.isInteger(value) ||
        value < 0 ||
        value > 0x10ffff ||
        (value >= 0xd800 && value <= 0xdfff)
      ) {
        throw new Error("Invalid XML numeric entity.");
      }
      return String.fromCodePoint(value);
    }
    return XML_ENTITIES[String(named).toLowerCase()] ?? whole;
  });
}

function lineId(index: number): string {
  return `line-${String(index + 1).padStart(4, "0")}`;
}

export function resumeImportFormat(
  filename: string,
  contentType: string,
): ResumeImportFormat {
  const lower = filename.trim().toLowerCase();
  const mime = contentType.trim().toLowerCase().split(";", 1)[0];
  if (lower.endsWith(".pdf") || mime === "application/pdf") {
    throw new Error("PDF import is not supported yet. Upload a DOCX, TXT, or Markdown file.");
  }
  const extensionFormat: ResumeImportFormat | undefined = lower.endsWith(".docx")
    ? "docx"
    : lower.endsWith(".md") || lower.endsWith(".markdown")
      ? "md"
      : lower.endsWith(".txt")
        ? "txt"
        : undefined;
  const mimeFormat: ResumeImportFormat | undefined =
    mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ? "docx"
      : mime === "text/markdown" || mime === "text/x-markdown"
        ? "md"
        : mime === "text/plain"
          ? "txt"
          : undefined;
  if (extensionFormat && mimeFormat && extensionFormat !== mimeFormat) {
    throw new Error("The resume file extension does not match its content type.");
  }
  if (extensionFormat && !mimeFormat && mime && mime !== "application/octet-stream") {
    throw new Error("The resume content type is not supported. Upload a DOCX, TXT, or Markdown file.");
  }
  if (extensionFormat) return extensionFormat;
  if (mimeFormat) return mimeFormat;
  throw new Error("Upload a DOCX, TXT, or Markdown file.");
}

function plainTextLines(text: string): ExtractedLine[] {
  return text.split(/\r?\n/).map((value, index) => ({
    id: lineId(index),
    text: value,
    runs: value ? [{ text: value, bold: false, italics: false }] : [],
    bold: false,
    italics: false,
    hasTab: value.includes("\t"),
    rightTab: false,
    borderBottom: false,
    bullet: /^\s*(?:[-*+]\s+|●\s*)/.test(value),
  }));
}

function propertyEnabled(xml: string, tag: "b" | "i"): boolean {
  const match = xml.match(new RegExp(`<w:${tag}\\b([^>]*)/?>`, "i"));
  if (!match) return false;
  return !/w:val\s*=\s*["'](?:0|false|off|no)["']/i.test(match[1]);
}

function numericAttribute(xml: string, name: string): number | undefined {
  const match = xml.match(new RegExp(`\\bw:${name}\\s*=\\s*["'](\\d+)["']`, "i"));
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

function extractRun(runXml: string, url?: string): ExtractedRun {
  const properties = runXml.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/i)?.[0] ?? "";
  const parts: string[] = [];
  const contentPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/?\s*>|<w:br\b[^>]*\/?\s*>/gi;
  for (const match of runXml.matchAll(contentPattern)) {
    if (match[1] !== undefined) parts.push(decodeXml(match[1]));
    else if (/^<w:tab/i.test(match[0])) parts.push("\t");
    else parts.push("\n");
  }
  return {
    text: parts.join(""),
    bold: propertyEnabled(properties, "b"),
    italics: propertyEnabled(properties, "i"),
    ...(url ? { url } : {}),
  };
}

function relationshipAttribute(xml: string, name: string): string | undefined {
  const pattern = new RegExp("\\b" + name + "\\s*=\\s*[\"']([^\"']+)[\"']", "i");
  const match = xml.match(pattern);
  return match ? decodeXml(match[1]) : undefined;
}

export function extractHyperlinkRelationships(xml: string): Map<string, string> {
  const relationships = new Map<string, string>();
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/?\s*>/gi)) {
    const relationship = match[0];
    const type = relationshipAttribute(relationship, "Type");
    const targetMode = relationshipAttribute(relationship, "TargetMode");
    const id = relationshipAttribute(relationship, "Id");
    const target = relationshipAttribute(relationship, "Target");
    if (type?.endsWith("/hyperlink") && targetMode === "External" && id && target) {
      relationships.set(id, target);
    }
  }
  return relationships;
}

function paragraphRuns(
  paragraph: string,
  hyperlinks: ReadonlyMap<string, string>,
): ExtractedRun[] {
  const runs: ExtractedRun[] = [];
  const nodes = paragraph.matchAll(
    /<w:hyperlink\b[\s\S]*?<\/w:hyperlink>|<w:r\b[\s\S]*?<\/w:r>/gi,
  );
  for (const match of nodes) {
    const node = match[0];
    if (/^<w:hyperlink\b/i.test(node)) {
      const relationshipId = relationshipAttribute(node, "r:id");
      const url = relationshipId ? hyperlinks.get(relationshipId) : undefined;
      for (const run of node.matchAll(/<w:r\b[\s\S]*?<\/w:r>/gi)) {
        runs.push(extractRun(run[0], url));
      }
    } else {
      runs.push(extractRun(node));
    }
  }
  return runs.filter((run) => run.text.length > 0);
}

export function extractDocxXml(
  xml: string,
  hyperlinks: ReadonlyMap<string, string> = new Map(),
): ExtractedLine[] {
  const paragraphs = [...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/gi)];
  return paragraphs.map((paragraphMatch, index) => {
    const paragraph = paragraphMatch[0];
    const properties = paragraph.match(/<w:pPr\b[\s\S]*?<\/w:pPr>/i)?.[0] ?? "";
    const runs = paragraphRuns(paragraph, hyperlinks);
    const visibleRuns = runs.filter((run) => run.text.replace(/[\t\n]/g, "").length > 0);
    const text = runs.map((run) => run.text).join("");
    const indent = properties.match(/<w:ind\b[^>]*\/?\s*>/i)?.[0] ?? "";
    const indentLeft = numericAttribute(indent, "left");
    const hanging = numericAttribute(indent, "hanging");
    return {
      id: lineId(index),
      text,
      runs,
      bold: visibleRuns.length > 0 && visibleRuns.every((run) => run.bold),
      italics: visibleRuns.length > 0 && visibleRuns.every((run) => run.italics),
      hasTab: text.includes("\t"),
      rightTab: /<w:tab\b[^>]*w:val\s*=\s*["']right["']/i.test(properties),
      borderBottom: /<w:pBdr\b[\s\S]*?<w:bottom\b/i.test(properties),
      bullet:
        /<w:numPr\b/i.test(properties) ||
        (hanging !== undefined && hanging > 0) ||
        /^\s*(?:[-*+]\s+|●\s*)/.test(text),
      indentLeft,
      hanging,
    };
  });
}

function declaredDocumentXmlSize(documentFile: JSZip.JSZipObject): number {
  // JSZip 3.10.1 has no supported public uncompressed-size field, so keep the
  // private access here as a single upgrade audit point for the pre-decompression guard.
  const declaredSize = (
    documentFile as unknown as { _data?: { uncompressedSize?: unknown } }
  )._data?.uncompressedSize;
  if (
    typeof declaredSize !== "number" ||
    !Number.isSafeInteger(declaredSize) ||
    declaredSize <= 0
  ) {
    throw new Error("This DOCX file is damaged or is not a valid Word document.");
  }
  return declaredSize;
}

export async function extractResume(
  bytes: Uint8Array,
  file: { filename: string; contentType: string },
): Promise<ExtractedResume> {
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new Error("Resume files must be 5 MB or smaller.");
  }
  if (new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-") {
    throw new Error("PDF import is not supported yet. Upload a DOCX, TXT, or Markdown file.");
  }
  const format = resumeImportFormat(file.filename, file.contentType);
  if (format !== "docx") {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("TXT and Markdown resumes must use UTF-8 text encoding.");
    }
    if (text.includes("\0")) {
      throw new Error("This text resume appears to contain binary data.");
    }
    return {
      format,
      filename: file.filename,
      lines: plainTextLines(text),
    };
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error("This DOCX file is damaged or is not a valid Word document.");
  }
  const documentFile = zip.file("word/document.xml");
  if (!documentFile) {
    throw new Error("This DOCX file does not contain word/document.xml.");
  }
  if (declaredDocumentXmlSize(documentFile) > MAX_DOCUMENT_XML_BYTES) {
    throw new Error("This DOCX contains too much document content to import safely.");
  }
  let xmlBytes: Uint8Array;
  try {
    xmlBytes = await documentFile.async("uint8array");
  } catch {
    throw new Error("This DOCX file is damaged or is not a valid Word document.");
  }
  if (xmlBytes.byteLength > MAX_DOCUMENT_XML_BYTES) {
    throw new Error("This DOCX contains too much document content to import safely.");
  }
  // Hyperlink targets live in a SEPARATE part: document.xml carries only an
  // r:id, and the URL it points at is in word/_rels/document.xml.rels. Without
  // reading it every link resolves to undefined, and since header links[].url
  // is a required non-empty string the model is then forced to either drop the
  // links or invent URLs - so a resume this app produced loses its real
  // LinkedIn and GitHub addresses on re-import.
  //
  // Absence is not an error: a resume with no links has no rels entry for one,
  // and a malformed rels part should cost the URLs, not the whole import.
  let hyperlinks = new Map<string, string>();
  const relsFile = zip.file("word/_rels/document.xml.rels");
  if (relsFile) {
    try {
      const relsBytes = await relsFile.async("uint8array");
      if (relsBytes.byteLength <= MAX_DOCUMENT_XML_BYTES) {
        hyperlinks = extractHyperlinkRelationships(
          new TextDecoder("utf-8", { fatal: true }).decode(relsBytes),
        );
      }
    } catch {
      // Keep the empty map and carry on.
    }
  }

  try {
    const xml = new TextDecoder("utf-8", { fatal: true }).decode(xmlBytes);
    return { format, filename: file.filename, lines: extractDocxXml(xml, hyperlinks) };
  } catch {
    throw new Error("This DOCX file is damaged or is not a valid Word document.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  errors: string[],
) {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) errors.push(`${path}.${key} is not part of ProfileV2`);
  }
}

function requireString(
  value: unknown,
  path: string,
  errors: string[],
  nonEmpty = false,
): value is string {
  if (typeof value !== "string") {
    errors.push(`${path} must be a string`);
    return false;
  }
  if (nonEmpty && !value.trim()) {
    errors.push(`${path} must not be empty`);
    return false;
  }
  return true;
}

function optionalString(value: unknown, path: string, errors: string[]) {
  if (value !== undefined) requireString(value, path, errors);
}

function stringArray(value: unknown, path: string, errors: string[]): value is string[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return false;
  }
  value.forEach((item, index) => requireString(item, `${path}[${index}]`, errors));
  return true;
}

function validateHeadingRun(value: unknown, path: string, errors: string[]): value is HeadingRun {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  unknownKeys(value, ["text", "bold", "italics"], path, errors);
  requireString(value.text, `${path}.text`, errors);
  if (value.bold !== undefined && typeof value.bold !== "boolean") {
    errors.push(`${path}.bold must be a boolean`);
  }
  if (value.italics !== undefined && typeof value.italics !== "boolean") {
    errors.push(`${path}.italics must be a boolean`);
  }
  return true;
}

function validateDegree(value: unknown, path: string, errors: string[]): value is Degree {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  unknownKeys(value, ["degree", "concentration", "grad_date", "gpa"], path, errors);
  requireString(value.degree, `${path}.degree`, errors);
  requireString(value.grad_date, `${path}.grad_date`, errors);
  optionalString(value.concentration, `${path}.concentration`, errors);
  optionalString(value.gpa, `${path}.gpa`, errors);
  return true;
}

function validateExtra(value: unknown, path: string, errors: string[]): value is Extra {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  unknownKeys(value, ["text", "date", "italics"], path, errors);
  requireString(value.text, `${path}.text`, errors, true);
  optionalString(value.date, `${path}.date`, errors);
  if (value.italics !== undefined && typeof value.italics !== "boolean") {
    errors.push(`${path}.italics must be a boolean`);
  }
  return true;
}

function validateEntry(value: unknown, path: string, errors: string[]): value is Entry {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  unknownKeys(
    value,
    [
      "id",
      "heading",
      "subheading",
      "location",
      "date",
      "hiddenIn",
      "tech",
      "tags",
      "degrees",
      "extras",
      "headingRuns",
      "bullets",
    ],
    path,
    errors,
  );
  requireString(value.id, `${path}.id`, errors, true);
  requireString(value.heading, `${path}.heading`, errors);
  requireString(value.date, `${path}.date`, errors);
  optionalString(value.subheading, `${path}.subheading`, errors);
  optionalString(value.location, `${path}.location`, errors);
  if (value.hiddenIn !== undefined) stringArray(value.hiddenIn, `${path}.hiddenIn`, errors);
  if (value.tech !== undefined) stringArray(value.tech, `${path}.tech`, errors);
  if (value.tags !== undefined) stringArray(value.tags, `${path}.tags`, errors);
  if (value.degrees !== undefined) {
    if (!Array.isArray(value.degrees)) errors.push(`${path}.degrees must be an array`);
    else value.degrees.forEach((item, index) => validateDegree(item, `${path}.degrees[${index}]`, errors));
  }
  if (value.extras !== undefined) {
    if (!Array.isArray(value.extras)) errors.push(`${path}.extras must be an array`);
    else value.extras.forEach((item, index) => validateExtra(item, `${path}.extras[${index}]`, errors));
  }
  if (value.headingRuns !== undefined) {
    if (!Array.isArray(value.headingRuns)) errors.push(`${path}.headingRuns must be an array`);
    else value.headingRuns.forEach((item, index) => validateHeadingRun(item, `${path}.headingRuns[${index}]`, errors));
  }
  if (!isRecord(value.bullets)) {
    errors.push(`${path}.bullets must be an object`);
  } else {
    for (const [variant, bullets] of Object.entries(value.bullets)) {
      if (!variant.trim()) errors.push(`${path}.bullets has an empty variant name`);
      stringArray(bullets, `${path}.bullets.${variant}`, errors);
    }
  }
  return true;
}

function validateSkillItem(value: unknown, path: string, errors: string[]): value is SkillItem {
  if (typeof value === "string") return true;
  if (!isRecord(value)) {
    errors.push(`${path} must be a string or skill group`);
    return false;
  }
  unknownKeys(value, ["name", "keywords"], path, errors);
  requireString(value.name, `${path}.name`, errors, true);
  if (value.keywords !== undefined) stringArray(value.keywords, `${path}.keywords`, errors);
  return true;
}

function validateSection(value: unknown, path: string, errors: string[]): value is Section {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  unknownKeys(value, ["id", "title", "kind", "entries"], path, errors);
  requireString(value.id, `${path}.id`, errors, true);
  requireString(value.title, `${path}.title`, errors, true);
  if (typeof value.kind !== "string" || !SECTION_KINDS.has(value.kind as SectionKind)) {
    errors.push(`${path}.kind must be a ProfileV2 section kind`);
  }
  if (!Array.isArray(value.entries)) {
    errors.push(`${path}.entries must be an array`);
  } else {
    value.entries.forEach((entry, index) => validateEntry(entry, `${path}.entries[${index}]`, errors));
    if (value.kind === "skills" && value.entries.length > 0) {
      errors.push(`${path}.entries must be empty for a skills section`);
    }
  }
  return true;
}

export function validateProfileV2(value: unknown): ProfileValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["profile must be an object"] };
  unknownKeys(value, ["version", "header", "variants", "skills", "sections"], "profile", errors);
  if (value.version !== 2) errors.push("profile.version must be 2");

  if (!isRecord(value.header)) {
    errors.push("profile.header must be an object");
  } else {
    unknownKeys(value.header, ["name", "contact_line", "citizen_prefix", "links"], "profile.header", errors);
    requireString(value.header.name, "profile.header.name", errors);
    requireString(value.header.contact_line, "profile.header.contact_line", errors);
    optionalString(value.header.citizen_prefix, "profile.header.citizen_prefix", errors);
    if (value.header.links !== undefined) {
      if (!Array.isArray(value.header.links)) errors.push("profile.header.links must be an array");
      else {
        value.header.links.forEach((link, index) => {
          const path = `profile.header.links[${index}]`;
          if (!isRecord(link)) errors.push(`${path} must be an object`);
          else {
            unknownKeys(link, ["text", "url"], path, errors);
            requireString(link.text, `${path}.text`, errors, true);
            requireString(link.url, `${path}.url`, errors, true);
          }
        });
      }
    }
  }

  if (value.variants !== undefined) stringArray(value.variants, "profile.variants", errors);
  if (!isRecord(value.skills)) {
    errors.push("profile.skills must be an object");
  } else {
    unknownKeys(value.skills, ["coursework", "languages", "tools", "certifications"], "profile.skills", errors);
    for (const key of ["coursework", "languages", "tools"] as const) {
      const items = value.skills[key];
      if (items !== undefined) {
        if (!Array.isArray(items)) errors.push(`profile.skills.${key} must be an array`);
        else items.forEach((item, index) => validateSkillItem(item, `profile.skills.${key}[${index}]`, errors));
      }
    }
    if (value.skills.certifications !== undefined) {
      stringArray(value.skills.certifications, "profile.skills.certifications", errors);
    }
  }

  if (!Array.isArray(value.sections)) {
    errors.push("profile.sections must be an array");
  } else {
    value.sections.forEach((section, index) => validateSection(section, `profile.sections[${index}]`, errors));
    const sectionIds = value.sections
      .filter(isRecord)
      .map((section) => section.id)
      .filter((id): id is string => typeof id === "string");
    if (new Set(sectionIds).size !== sectionIds.length) errors.push("profile section IDs must be unique");
    const entryIds = value.sections
      .filter(isRecord)
      .flatMap((section) => (Array.isArray(section.entries) ? section.entries : []))
      .filter(isRecord)
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === "string");
    if (new Set(entryIds).size !== entryIds.length) errors.push("profile entry IDs must be unique");
  }

  return errors.length ? { ok: false, errors } : { ok: true, profile: value as ProfileV2 };
}

function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  try {
    return JSON.parse(unfenced);
  } catch (error) {
    throw new Error(`model response is not valid JSON: ${(error as Error).message}`);
  }
}

function resolvePointer(root: unknown, pointer: string): unknown {
  if (!pointer.startsWith("/")) return undefined;
  let current = root;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(key)) return undefined;
      current = current[Number(key)];
    } else if (isRecord(current)) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (isRecord(value)) return Object.values(value).flatMap(stringLeaves);
  return [];
}

type ContentToken = { normalized: string; source: string };

function contentTokens(value: string): ContentToken[] {
  return [...value.matchAll(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu)].map((match) => ({
    normalized: match[0].normalize("NFKC").toLocaleLowerCase(),
    source: match[0],
  }));
}

function mappingCoverage(
  line: ExtractedLine,
  targets: string[],
): { matched: number; droppedTokens: string[] } {
  const targetCounts = new Map<string, number>();
  for (const token of contentTokens(targets.join(" "))) {
    targetCounts.set(token.normalized, (targetCounts.get(token.normalized) ?? 0) + 1);
  }
  let matched = 0;
  const droppedTokens: string[] = [];
  for (const token of contentTokens(line.text)) {
    const remaining = targetCounts.get(token.normalized) ?? 0;
    if (remaining > 0) {
      matched += 1;
      targetCounts.set(token.normalized, remaining - 1);
    } else {
      droppedTokens.push(token.source);
    }
  }
  return { matched, droppedTokens };
}

function validJsonPointer(pointer: string): boolean {
  return pointer.startsWith("/") && !/~(?![01])/u.test(pointer);
}

function sectionCount(profile: ProfileV2, section: Section): number {
  if (section.kind !== "skills") return section.entries.length;
  return Object.values(profile.skills).reduce((count, items) => count + (items?.length ?? 0), 0);
}

export function validateModelOutput(
  text: string,
  extraction: ExtractedResume,
): ModelOutputValidationResult {
  let parsed: unknown;
  try {
    parsed = parseModelJson(text);
  } catch (error) {
    return { ok: false, errors: [(error as Error).message] };
  }
  if (!isRecord(parsed)) return { ok: false, errors: ["model response must be an object"] };
  const errors: string[] = [];
  unknownKeys(parsed, ["profile", "mappings"], "response", errors);
  const profileResult = validateProfileV2(parsed.profile);
  if (!profileResult.ok) errors.push(...profileResult.errors);

  const mappings: ImportLineMapping[] = [];
  const validLineIds = new Set(extraction.lines.map((line) => line.id));
  if (!Array.isArray(parsed.mappings)) {
    errors.push("response.mappings must be an array");
  } else {
    const seen = new Set<string>();
    parsed.mappings.forEach((mapping, index) => {
      const path = `response.mappings[${index}]`;
      if (!isRecord(mapping)) {
        errors.push(`${path} must be an object`);
        return;
      }
      unknownKeys(mapping, ["lineId", "targetPaths"], path, errors);
      if (!requireString(mapping.lineId, `${path}.lineId`, errors, true)) return;
      if (!validLineIds.has(mapping.lineId)) errors.push(`${path}.lineId does not exist in the extraction`);
      if (seen.has(mapping.lineId)) errors.push(`${path}.lineId is duplicated`);
      seen.add(mapping.lineId);
      if (!stringArray(mapping.targetPaths, `${path}.targetPaths`, errors)) return;
      if (mapping.targetPaths.length === 0) errors.push(`${path}.targetPaths must not be empty`);
      const uniqueTargets = new Set(mapping.targetPaths);
      if (uniqueTargets.size !== mapping.targetPaths.length) {
        errors.push(`${path}.targetPaths must not contain duplicates`);
      }
      mapping.targetPaths.forEach((pointer, pointerIndex) => {
        if (!pointer.trim()) {
          errors.push(`${path}.targetPaths[${pointerIndex}] must not be empty`);
        } else if (!validJsonPointer(pointer)) {
          errors.push(`${path}.targetPaths[${pointerIndex}] must be an RFC 6901 JSON pointer`);
        }
      });
      mappings.push({ lineId: mapping.lineId, targetPaths: mapping.targetPaths });
    });
  }

  if (profileResult.ok) {
    mappings.forEach((mapping, index) => {
      for (const pointer of mapping.targetPaths) {
        const value = resolvePointer(profileResult.profile, pointer);
        if (stringLeaves(value).every((item) => !item.trim())) {
          errors.push(`response.mappings[${index}] target ${pointer} does not resolve to profile content`);
        }
      }
    });
  }
  if (errors.length || !profileResult.ok) return { ok: false, errors };

  const mappingsById = new Map(mappings.map((mapping) => [mapping.lineId, mapping]));
  const fullyMappedLines: ValidatedImport["fullyMappedLines"] = [];
  const partialMappedLines: ValidatedImport["partialMappedLines"] = [];
  const unmappedLines: ValidatedImport["unmappedLines"] = [];
  for (const line of extraction.lines.filter((item) => item.text.trim())) {
    const mapping = mappingsById.get(line.id);
    if (!mapping) {
      unmappedLines.push({ id: line.id, text: line.text });
      continue;
    }
    const targets = mapping.targetPaths.flatMap((pointer) =>
      stringLeaves(resolvePointer(profileResult.profile, pointer)),
    );
    const coverage = mappingCoverage(line, targets);
    if (coverage.droppedTokens.length === 0) {
      fullyMappedLines.push({ id: line.id, text: line.text });
    } else if (coverage.matched === 0) {
      unmappedLines.push({ id: line.id, text: line.text });
    } else {
      partialMappedLines.push({
        id: line.id,
        text: line.text,
        droppedText: coverage.droppedTokens.join(" "),
      });
    }
  }

  return {
    ok: true,
    value: {
      profile: profileResult.profile,
      mappings,
      fullyMappedLines,
      partialMappedLines,
      unmappedLines,
      sections: profileResult.profile.sections.map((section) => ({
        id: section.id,
        title: section.title,
        kind: section.kind,
        count: sectionCount(profileResult.profile, section),
      })),
    },
  };
}

export function buildImportPrompt(
  extraction: ExtractedResume,
  repair?: { errors: string[]; previousResponse: string },
): { system: string; user: string } {
  const payload = JSON.stringify(extraction);
  if (payload.length > MAX_EXTRACTION_PAYLOAD_CHARS) {
    throw new Error("This resume contains too much text to map safely. Shorten it and try again.");
  }
  const system = [
    "You map a deterministically extracted resume into the exact ProfileV2 JSON contract.",
    "Return JSON only with exactly two keys: profile and mappings.",
    "profile must have version 2, header, skills, and ordered sections.",
    "Every section has id, title, kind, and entries. Skills sections have no entries.",
    "Every entry has id, heading, date, and bullets. Put imported bullets under bullets.base.",
    "Education entries use degrees with degree and grad_date plus optional concentration and gpa.",
    "Use deterministic readable IDs derived from names and order. Do not invent resume content.",
    "mappings is an array of {lineId,targetPaths}. targetPaths are RFC 6901 JSON pointers into profile.",
    "Map a source line only to paths that contain its content. Omit genuinely unmapped lines from mappings.",
    "Preserve source order and use bold, italics, tabs, borders, bullets, and indentation as structural evidence.",
  ].join("\n");
  const base = `Structured extraction:\n${payload}`;
  let user = base;
  if (repair) {
    const errorText = repair.errors
      .slice(0, 30)
      .map((error) => `- ${error.slice(0, 500)}`)
      .join("\n");
    const repairPrefix = `${base}\n\nYour previous response failed validation. Correct it once.\nValidation errors:\n${errorText}\nPrevious response:\n`;
    const available = Math.max(1, MAX_MODEL_INPUT_CHARS - repairPrefix.length);
    user = `${repairPrefix}${repair.previousResponse.slice(0, Math.min(30_000, available))}`;
  }
  if (user.length > MAX_MODEL_INPUT_CHARS) {
    throw new Error("This resume contains too much text to repair safely. Shorten it and try again.");
  }
  return {
    system,
    user,
  };
}

export type ImportModelPrompt = { system: string; user: string };

// Meter model calls without ever letting the meter decide the outcome. Each
// call that actually returned text is charged - the repair call too, and calls
// whose output later fails validation - because the tokens are spent either
// way; charging anything less lets a resume the model cannot map burn calls
// forever while the cap counter never moves. A charge failure is logged and
// swallowed (the runBuild precedent): the allowance is bookkeeping, and
// bookkeeping must never turn already-paid-for work into an error.
export function meteredInvoke(
  invoke: (prompt: ImportModelPrompt) => Promise<string>,
  charge: () => Promise<unknown>,
): (prompt: ImportModelPrompt) => Promise<string> {
  return async (prompt) => {
    const text = await invoke(prompt);
    try {
      await charge();
    } catch (error) {
      console.warn("resume import allowance charge failed", error);
    }
    return text;
  };
}

export async function mapExtractionWithModel(
  extraction: ExtractedResume,
  invoke: (prompt: ImportModelPrompt) => Promise<string>,
): Promise<ValidatedImport> {
  if (!extraction.lines.some((line) => line.text.trim())) {
    throw new Error("This resume does not contain any text to import.");
  }
  const firstResponse = await invoke(buildImportPrompt(extraction));
  const firstValidation = validateModelOutput(firstResponse, extraction);
  if (firstValidation.ok) return firstValidation.value;

  const repairResponse = await invoke(
    buildImportPrompt(extraction, {
      errors: firstValidation.errors,
      previousResponse: firstResponse,
    }),
  );
  const repairValidation = validateModelOutput(repairResponse, extraction);
  if (repairValidation.ok) return repairValidation.value;
  throw new Error(
    `The model could not produce a valid resume import after one repair attempt: ${repairValidation.errors
      .slice(0, 8)
      .join("; ")}`,
  );
}
