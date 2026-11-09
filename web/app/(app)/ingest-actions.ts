"use server";

import { resolveTrackerUser } from "@/lib/user";
import {
  requestIngest as convexRequestIngest,
  getIngestStatus as convexGetIngestStatus,
  type IngestGap,
  type IngestRow,
} from "@/lib/convex";
import { withBackedShort } from "@/lib/ingest-short";

// `short` only once a match backs it (lib/ingest-short.ts): an ingest that is
// still fetching, or failed, has no match to point at.
export type AddUrlResult =
  | ({ ok: true; ingestId: string; short?: string; status: string } & IngestGap)
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

export async function addJobUrl(url: string, foundVia?: string): Promise<AddUrlResult> {
  const err = validateUrlInput(url);
  if (err) return { ok: false, error: err };
  const user = await resolveTrackerUser();
  if (!user) return { ok: false, error: "This account isn't provisioned — no tracker user to write to." };
  try {
    const via = foundVia?.trim(); // normalized server-side
    const res = await convexRequestIngest(user, url.trim(), via ? { foundVia: via } : {});
    if (!res || typeof res.ingestId !== "string") {
      return { ok: false, error: "Couldn't start ingest — unexpected response." };
    }
    // The gap facts ride on the fetching response, so the dialog can say
    // "isn't watched" before polling - even if the fetch later fails.
    const gap: IngestGap = res.status === "fetching"
      ? { ats: res.ats, atsBoard: res.atsBoard, boardWatched: res.boardWatched, atsSupported: res.atsSupported }
      : {};
    return { ok: true, ...withBackedShort({ ingestId: res.ingestId, short: res.short, status: res.status }), ...gap };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Surface rate-limit and validation errors directly
    if (/rate limited|private|localhost|invalid url|bad secret/i.test(msg)) {
      return { ok: false, error: msg };
    }
    return { ok: false, error: msg || "Failed to start ingest." };
  }
}

export async function getIngestStatusAction(
  ingestId: string,
): Promise<(Omit<IngestRow, "short"> & { short?: string }) | null> {
  if (!ingestId || typeof ingestId !== "string") return null;
  const user = await resolveTrackerUser();
  if (!user) return null;
  try {
    const row = await convexGetIngestStatus(user, ingestId);
    return row ? withBackedShort(row) : null;
  } catch {
    return null;
  }
}
