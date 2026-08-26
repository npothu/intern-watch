// The full-bank resume export: one variant of the stored profile rendered
// whole, with nothing selected, rewritten, or fitted.
//
// This is the profile editor's "download resume" - the tailored build in
// resume_node.ts is the per-match one. It is a pure module (no ./_generated,
// no "use node") so it unit-tests without a backend, but Packer.toBuffer
// yields a Node Buffer, so it is only ever CALLED from the Node action
// (resume_node.exportProfile) - never from the isolate runtime.

import { Packer } from "docx";
import { toV2, type ProfileV2 } from "./profile_schema";
import {
  composeResumeDoc,
  fullResumeContent,
  fullResumeFilename,
} from "./resume_renderers/docx";
import { renderFullResumePdf } from "./resume_renderers/pdf";

export type ExportFormat = "pdf" | "docx";

export const EXPORT_CONTENT_TYPE: Record<ExportFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export type ExportedResume = {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
};

/** Reject a profile that is not a JSON object before it reaches a renderer;
 *  the message is shown to the user, so it names the fix. */
export function parseExportProfile(data: string): ProfileV2 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error("The profile is not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The profile is not a resume profile.");
  }
  return toV2(parsed);
}

export async function exportResume(
  profileArg: ProfileV2,
  variant: string,
  format: ExportFormat,
): Promise<ExportedResume> {
  const profile = toV2(profileArg);
  const filename = fullResumeFilename(profile, variant, format);
  const contentType = EXPORT_CONTENT_TYPE[format];
  if (format === "pdf") {
    return { filename, contentType, bytes: await renderFullResumePdf(profile, variant) };
  }
  const doc = composeResumeDoc(profile, fullResumeContent(profile, variant), variant);
  const buf = await Packer.toBuffer(doc);
  return { filename, contentType, bytes: new Uint8Array(buf) };
}
