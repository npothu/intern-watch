"use server";

import { resolveTrackerUser } from "@/lib/user";
import {
  requestIngest as convexRequestIngest,
  getIngestStatus as convexGetIngestStatus,
  type IngestRow,
} from "@/lib/convex";

export type AddUrlResult =
  | { ok: true; ingestId: string; short: string; status: string }
  | { ok: false; error: string };

function validateUrlInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return "Please paste a URL.";
  if (trimmed.length > 2048) return "URL is too long.";
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return "Invalid URL — include https://";
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return "Only http and https URLs are allowed.";
  const host = u.hostname.toLowerCase();
  if (!host || !host.includes(".")) return "URL must have a valid host.";
  if (host === "localhost" || host.endsWith(".localhost")) return "Localhost URLs are not allowed.";
  if (/^127\./.test(host) || host === "0.0.0.0" || host === "[::1]" || host === "::1") return "Private addresses are not allowed.";
  if (/^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return "Private addresses are not allowed.";
  const m172 = host.match(/^172\.(\d+)\./);
  if (m172) {
    const n = parseInt(m172[1], 10);
    if (n >= 16 && n <= 31) return "Private addresses are not allowed.";
  }
  return null;
}

export async function addJobUrl(url: string): Promise<AddUrlResult> {
  const err = validateUrlInput(url);
  if (err) return { ok: false, error: err };
  const user = await resolveTrackerUser();
  if (!user) return { ok: false, error: "This account isn't provisioned — no tracker user to write to." };
  try {
    const res = await convexRequestIngest(user, url.trim());
    if (!res || typeof res.ingestId !== "string") {
      return { ok: false, error: "Couldn't start ingest — unexpected response." };
    }
    return { ok: true, ingestId: res.ingestId, short: res.short, status: res.status };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Surface rate-limit and validation errors directly
    if (/rate limited|private|localhost|invalid url|bad secret/i.test(msg)) {
      return { ok: false, error: msg };
    }
    return { ok: false, error: msg || "Failed to start ingest." };
  }
}

export async function getIngestStatusAction(ingestId: string): Promise<IngestRow | null> {
  if (!ingestId || typeof ingestId !== "string") return null;
  const user = await resolveTrackerUser();
  if (!user) return null;
  try {
    return await convexGetIngestStatus(user, ingestId);
  } catch {
    return null;
  }
}
