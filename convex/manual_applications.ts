import { v } from "convex/values";
import type { DatabaseWriter } from "./_generated/server";

import {
  assertManualRequestId,
  manualApplicationFingerprint,
  normalizeManualApplication,
  type ApplicationStatus,
  type ManualApplicationDraft,
} from "../shared/applications";
import { applyStatus } from "./ledger";
import { canonicalUrl, postingIdentity } from "./ingest_extract";
import { dedupInfoForUrl, sha1HexSync } from "./short_key";

export const manualApplicationDraftValidator = v.object({
  company: v.string(),
  title: v.optional(v.string()),
  location: v.optional(v.string()),
  url: v.optional(v.string()),
  note: v.optional(v.string()),
  status: v.optional(v.string()),
  appliedDate: v.optional(v.string()),
});

type ManualSnapshot = {
  key: string;
  source: "manual-application";
  manualRequestId: string;
  manualFingerprint: string;
  company: string;
  title?: string;
  location?: string;
  url?: string;
  added: string;
};

export type ManualApplicationResult = {
  short: string;
  status: ApplicationStatus;
  created: boolean;
};

function emailAndUserNote(note: string | undefined, emailNote: string): string {
  return note ? `${note}\n\n${emailNote}` : emailNote;
}

function urlIdentity(url: string): string {
  const fallback = dedupInfoForUrl(canonicalUrl(url), url);
  if (fallback.dedupKey.startsWith("jr:")) return fallback.dedupKey;
  return postingIdentity(url) ?? fallback.dedupKey;
}

export async function createManualApplicationInLedger(
  db: DatabaseWriter,
  {
    user,
    requestId,
    draft,
    emailNote,
  }: {
    user: string;
    requestId: string;
    draft: ManualApplicationDraft;
    emailNote?: string;
  },
): Promise<ManualApplicationResult> {
  assertManualRequestId(requestId);
  const normalized = normalizeManualApplication(draft);
  const fingerprint = manualApplicationFingerprint(normalized);
  const baseKey = `manual-application:${requestId.toLowerCase()}`;

  const applications = await db.query("applications")
    .withIndex("by_user", (q) => q.eq("user", user))
    .collect();
  const previousRequest = applications.find((application) => {
    const snapshot = (application.snapshot ?? {}) as Partial<ManualSnapshot>;
    return snapshot.manualRequestId === requestId.toLowerCase();
  });
  if (previousRequest) {
    const snapshot = (previousRequest.snapshot ?? {}) as Partial<ManualSnapshot>;
    if (snapshot.manualFingerprint !== fingerprint) {
      throw new Error("request id already used with different application details");
    }
    return {
      short: previousRequest.short,
      status: previousRequest.status as ApplicationStatus,
      created: false,
    };
  }
  const requestedUrlIdentity = normalized.url ? urlIdentity(normalized.url) : null;
  if (requestedUrlIdentity) {
    const duplicate = applications.find((application) => {
      const snapshot = (application.snapshot ?? {}) as Partial<ManualSnapshot>;
      return snapshot.url && urlIdentity(snapshot.url) === requestedUrlIdentity;
    });
    if (duplicate) {
      const snapshot = (duplicate.snapshot ?? {}) as Partial<ManualSnapshot>;
      if (snapshot.manualRequestId !== requestId.toLowerCase()) {
        throw new Error("an application with this job link already exists");
      }
    }
  }

  const matches = await db.query("matches")
    .withIndex("by_user", (q) => q.eq("user", user))
    .collect();
  const linkedMatch = requestedUrlIdentity
    ? matches.find((match) => {
      const itemUrl = typeof match.item?.url === "string" ? match.item.url : "";
      return itemUrl && urlIdentity(itemUrl) === requestedUrlIdentity;
    })
    : undefined;
  const urlKey = requestedUrlIdentity
    ? {
      dedupKey: requestedUrlIdentity,
      short: sha1HexSync(requestedUrlIdentity).slice(0, 12),
    }
    : null;
  const preferredKey = linkedMatch && typeof linkedMatch.item?.key === "string"
    ? linkedMatch.item.key
    : urlKey?.dedupKey ?? baseKey;
  const preferredShort = linkedMatch?.short ?? urlKey?.short;

  let short = "";
  for (let attempt = 0; attempt < 100; attempt++) {
    const identity = attempt === 0 ? preferredKey : `${baseKey}:${attempt}`;
    const candidate = attempt === 0 && preferredShort
      ? preferredShort
      : sha1HexSync(identity).slice(0, 12);
    const existing = applications.find((application) => application.short === candidate);
    if (!existing) {
      const occupiedMatch = matches.find((match) => match.short === candidate);
      const occupiedTick = await db.query("ticks")
        .withIndex("by_user_short", (q) => q.eq("user", user).eq("short", candidate))
        .first();
      const occupiedResume = await db.query("resumes")
        .withIndex("by_user_short", (q) => q.eq("user", user).eq("short", candidate))
        .first();
      const belongsToLinkedMatch = linkedMatch?.short === candidate;
      if ((!occupiedMatch && !occupiedTick && !occupiedResume) || belongsToLinkedMatch) {
        short = candidate;
        break;
      }
      continue;
    }
    const snapshot = (existing.snapshot ?? {}) as Partial<ManualSnapshot>;
    if (snapshot.manualRequestId === requestId.toLowerCase()) {
      if (snapshot.manualFingerprint !== fingerprint) {
        throw new Error("request id already used with different application details");
      }
      return {
        short: existing.short,
        status: existing.status as ApplicationStatus,
        created: false,
      };
    }
  }
  if (!short) throw new Error("could not allocate application key");

  const snapshot: ManualSnapshot = {
    key: preferredKey,
    source: "manual-application",
    manualRequestId: requestId.toLowerCase(),
    manualFingerprint: fingerprint,
    company: normalized.company,
    ...(normalized.title ? { title: normalized.title } : {}),
    ...(normalized.location ? { location: normalized.location } : {}),
    ...(normalized.url ? { url: normalized.url } : {}),
    added: normalized.appliedDate,
  };
  const appliedAt = `${normalized.appliedDate}T12:00:00.000Z`;

  await applyStatus(db, {
    user,
    short,
    status: "applied",
    snapshot,
    eventAt: appliedAt,
    ...(
      normalized.status === "applied" && !emailNote && normalized.note
        ? { note: normalized.note }
        : {}
    ),
  });

  if (normalized.status !== "applied") {
    await applyStatus(db, {
      user,
      short,
      status: normalized.status,
      ...(normalized.note || emailNote
        ? { note: emailNote ? emailAndUserNote(normalized.note, emailNote) : normalized.note }
        : {}),
    });
  } else if (emailNote) {
    await applyStatus(db, {
      user,
      short,
      status: "applied",
      note: emailAndUserNote(normalized.note, emailNote),
    });
  }

  return { short, status: normalized.status, created: true };
}
