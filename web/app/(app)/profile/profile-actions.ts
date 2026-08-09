"use server";

import { resolveTrackerUser } from "@/lib/user";
import {
  discardResumeImportUpload,
  getResumeImportUploadUrl,
  getProfile,
  mapResumeImport,
  putProfile,
  type ResumeImportPreview,
} from "@/lib/convex";
import { toV2 } from "../../../../convex/profile_schema";

/**
 * Profile-page server actions. The profile is a resume "bank" JSON stored as
 * an opaque string (the Convex putProfile mutation validates it server-side).
 * The user is re-resolved server-side on every call.
 */

const MAX_PROFILE_BYTES = 256 * 1024; // 256KB
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

function importContentType(filename: string): string {
  const lower = filename.trim().toLowerCase();
  if (lower.endsWith(".pdf")) {
    throw new Error("PDF import is not supported yet. Upload a DOCX, TXT, or Markdown file.");
  }
  if (lower.endsWith(".docx")) {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "text/markdown";
  throw new Error("Upload a DOCX, TXT, or Markdown file.");
}

export type FetchProfileResult =
  | { ok: true; data?: string }
  | { ok: false; error: string };

/** Read the user's saved resume profile JSON. */
export async function fetchProfile(): Promise<FetchProfileResult> {
  const user = await resolveTrackerUser();
  if (!user) {
    return {
      ok: false,
      error: "Not signed in, or this account isn't provisioned.",
    };
  }
  try {
    const { data } = await getProfile(user);
    return { ok: true, data: data ?? undefined };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Couldn't load the profile." };
  }
}

export type SaveProfileResult = { ok: true } | { ok: false; error: string };

export type BeginResumeImportResult =
  | { ok: true; uploadUrl: string; contentType: string }
  | { ok: false; error: string };

export type FinishResumeImportResult =
  | { ok: true; preview: ResumeImportPreview; filename: string }
  | { ok: false; error: string };

export async function beginResumeImport(
  filename: string,
  size: number
): Promise<BeginResumeImportResult> {
  if (typeof filename !== "string" || !filename.trim()) {
    return { ok: false, error: "Choose a DOCX, TXT, or Markdown resume." };
  }
  if (!Number.isSafeInteger(size) || size <= 0) {
    return { ok: false, error: "The selected resume is empty." };
  }
  if (size > MAX_IMPORT_BYTES) {
    return { ok: false, error: "Resume files must be 5 MB or smaller." };
  }
  let contentType: string;
  try {
    contentType = importContentType(filename);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  const user = await resolveTrackerUser();
  if (!user) {
    return {
      ok: false,
      error: "Not signed in, or this account isn't provisioned.",
    };
  }

  try {
    return {
      ok: true,
      uploadUrl: await getResumeImportUploadUrl(user),
      contentType,
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error && error.message
          ? error.message
          : "Couldn't prepare this resume import.",
    };
  }
}

export async function finishResumeImport(
  storageId: string,
  filename: string,
  contentType: string
): Promise<FinishResumeImportResult> {
  if (!storageId || !filename || !contentType) {
    return { ok: false, error: "The resume upload was incomplete. Upload it again." };
  }
  const user = await resolveTrackerUser();
  if (!user) {
    return {
      ok: false,
      error: "Not signed in, or this account isn't provisioned.",
    };
  }
  try {
    const preview = await mapResumeImport(user, {
      storageId,
      filename,
      contentType,
    });
    return { ok: true, preview, filename };
  } catch (error) {
    await discardResumeImportUpload(user, storageId).catch(() => undefined);
    return {
      ok: false,
      error:
        error instanceof Error && error.message
          ? error.message
          : "Couldn't import this resume.",
    };
  }
}

/** Save the user's resume profile JSON (must parse and stay under 256KB). */
export async function saveProfile(data: string): Promise<SaveProfileResult> {
  if (typeof data !== "string") {
    return { ok: false, error: "Profile data must be a string." };
  }
  if (new Blob([data]).size > MAX_PROFILE_BYTES) {
    return { ok: false, error: "Profile is too large (max 256KB)." };
  }
  try {
    JSON.parse(data);
  } catch {
    return { ok: false, error: "Profile data must be valid JSON." };
  }
  const user = await resolveTrackerUser();
  if (!user) {
    return {
      ok: false,
      error: "Not signed in, or this account isn't provisioned.",
    };
  }
  try {
    await putProfile(user, data);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Couldn't save the profile." };
  }
}

/**
 * Upgrade the stored profile JSON to v2 if it is still v1, then save it back.
 *
 * Server actions only ever run on the server and are never bundled to the
 * browser, so this file can import convex/profile_schema.ts (which has zero
 * imports of its own) directly - unlike the client bundle, which must use the
 * mirror types/helpers in lib/profile.ts. A missing or already-v2 profile is a
 * no-op success.
 */
export async function upgradeProfile(): Promise<SaveProfileResult> {
  const user = await resolveTrackerUser();
  if (!user) {
    return {
      ok: false,
      error: "Not signed in, or this account isn't provisioned.",
    };
  }
  try {
    const { data } = await getProfile(user);
    if (data) {
      const parsed: unknown = JSON.parse(data);
      const v2 = toV2(parsed);
      await putProfile(user, JSON.stringify(v2, null, 2));
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Couldn't upgrade the profile." };
  }
}
