import { NextResponse } from "next/server";
import { resolveTrackerUser } from "@/lib/user";
import { exportProfileFile, type ResumeExportFormat } from "@/lib/convex";

/**
 * Download the signed-in user's full resume - one variant of the profile
 * rendered whole, no fitting - as a PDF or DOCX.
 *
 * A route handler rather than a server action because the response IS the
 * file: the browser gets real bytes with a Content-Disposition, which the
 * download helper turns into a native save. The profile comes from the
 * request body (the editor's current draft, so the file matches the screen
 * even mid-autosave); the same size and shape gates as saveProfile apply, and
 * the user is re-resolved server-side so an unprovisioned session gets
 * nothing but a 401.
 */

export const dynamic = "force-dynamic";

const MAX_PROFILE_BYTES = 256 * 1024; // saveProfile's cap
const MAX_VARIANT_CHARS = 40;

type ExportBody = { profile: string; variant: string; format: ResumeExportFormat };

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

function parseBody(raw: unknown): ExportBody | string {
  if (!raw || typeof raw !== "object") return "Send the profile to export.";
  const { profile, variant, format } = raw as Record<string, unknown>;
  if (typeof profile !== "string" || !profile.trim()) {
    return "Send the profile to export.";
  }
  if (new Blob([profile]).size > MAX_PROFILE_BYTES) {
    return "Profile is too large (max 256KB).";
  }
  try {
    JSON.parse(profile);
  } catch {
    return "Profile data must be valid JSON.";
  }
  if (format !== "pdf" && format !== "docx") return "Choose PDF or DOCX.";
  const name = typeof variant === "string" ? variant.trim().slice(0, MAX_VARIANT_CHARS) : "";
  return { profile, variant: name || "base", format };
}

/** RFC 6266 filename, with the ASCII fallback for the quoted form. Names come
 *  from fullResumeFilename (letters, digits, `_`, `.`), so both forms are the
 *  same string in practice; the encoded one is what a non-ASCII name needs. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function POST(req: Request) {
  const user = await resolveTrackerUser();
  if (!user) return fail(401, "Not signed in, or this account isn't provisioned.");

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail(400, "Send the profile to export.");
  }
  const body = parseBody(raw);
  if (typeof body === "string") return fail(400, body);

  let file;
  try {
    file = await exportProfileFile(body.profile, body.variant, body.format);
  } catch (err) {
    console.error("resume export failed", err);
    return fail(502, "Couldn't render the resume. Try again.");
  }

  const bytes = Buffer.from(file.base64, "base64");
  return new NextResponse(bytes, {
    status: 200,
    headers: {
      "Content-Type": file.contentType,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": contentDisposition(file.filename),
      "Cache-Control": "no-store",
    },
  });
}
