import "server-only";
import type { ProfileV2, SectionKind } from "../../convex/profile_schema";

/**
 * Server-only Convex client.
 *
 * Replicates the Python ConvexStore protocol (src/store.py, ConvexStore._post):
 * POST {path: "tracker:<fn>", args: {..., secret}, format: "json"} to
 * {CONVEX_URL}/api/query|mutation, and read back the `value` of a body whose
 * `status` is "success".
 *
 * CONVEX_URL / CONVEX_SECRET are read from the server env and are never
 * exposed to the client.
 */

const CONVEX_URL = process.env.CONVEX_URL?.replace(/\/+$/, "") ?? "";
const CONVEX_SECRET = process.env.CONVEX_SECRET ?? "";

export class ConvexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConvexError";
  }
}

type ConvexStatus = { status?: string; value?: unknown; errorMessage?: string };

async function post(
  kind: "query" | "mutation" | "action",
  fn: string,
  args: Record<string, unknown>,
  module: string = "tracker"
): Promise<unknown> {
  if (!CONVEX_URL) {
    throw new ConvexError("CONVEX_URL is not set (see web/.env.example)");
  }
  if (!CONVEX_SECRET) {
    throw new ConvexError("CONVEX_SECRET is not set (see web/.env.example)");
  }
  let resp: Response;
  try {
    resp = await fetch(`${CONVEX_URL}/api/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Same shape as src/store.py ConvexStore._post.
      body: JSON.stringify({
        path: `${module}:${fn}`,
        args: { ...args, secret: CONVEX_SECRET },
        format: "json",
      }),
      cache: "no-store",
    });
  } catch (err) {
    throw new ConvexError(
      `convex ${kind} ${fn} request failed: ${(err as Error).message}`
    );
  }
  let data: ConvexStatus;
  try {
    data = (await resp.json()) as ConvexStatus;
  } catch {
    throw new ConvexError(
      `convex ${kind} ${fn} returned non-JSON (HTTP ${resp.status})`
    );
  }
  if (!resp.ok || data.status !== "success") {
    throw new ConvexError(
      `convex ${kind} ${fn} error (HTTP ${resp.status}): ${
        data.errorMessage ?? "unknown"
      }`
    );
  }
  return data.value;
}

/** A match row, shaped like the Convex `getMatches` snapshot items. */
export type MatchItem = {
  key: string;
  short?: string;
  company: string;
  title: string;
  location: string;
  term: string;
  added: string;
  tag: string;
  salary: string;
  url: string;
  resume?: string;
  applied?: boolean;
  saved?: boolean;
  dismissed?: boolean;
};

/** One toggle in a batched `setTicks` mutation. Field names must match the
 * deployed convex/tracker.ts TICK_FIELDS exactly ("bad field" thrown else). */
export type TickWrite = {
  short: string;
  field: "applied" | "saved" | "dismissed";
  value: boolean;
};

export type TickRow = {
  short: string;
  applied?: boolean;
  dismissed?: boolean;
  saved?: boolean;
};

export type LedgerRecord = { [key: string]: unknown; status: string };

/** The build report resume_node.performBuild stores on the resumes row. */
export type ResumeReport = {
  builtAt: number;
  usedLlm: boolean;
  llmError?: string;
  jdSource: "manual" | "fetched" | "stub";
  jdChars: number;
  instructions?: string;
  /** The user-forced bullet variant for this build (undefined = JD auto-pick). */
  variant?: string;
  scores: Record<string, number>;
  notes: string[];
  format?: "pdf";
  pageCount?: 1;
  fit?: {
    heightPt: number;
    safeHeightPt: number;
    adjustments: string[];
  };
  projects: {
    name: string;
    variant?: string;
    before: string[];
    after: string[];
    llmRewritten: boolean;
    overridden: boolean;
  }[];
  outline: string[];
};

export type ResumeMeta = {
  url: string;
  filename: string;
  format: "pdf" | "docx";
  docxUrl: string | null;
  docxFilename: string | null;
  updatedAt?: number;
  report: ResumeReport | null;
  prevUrl: string | null;
  prevFilename: string | null;
  prevFormat: "pdf" | "docx" | null;
  prevDocxUrl: string | null;
  prevDocxFilename: string | null;
};

export type ResumeUrls = Record<string, ResumeMeta>;

export type TrackerUserData = {
  matches: MatchItem[];
  ticks: TickRow[];
  ledger: Record<string, LedgerRecord>;
  resumes: ResumeUrls;
};

/** All of a user's match rows (the dashboard surface). */
export async function getMatches(user: string): Promise<MatchItem[]> {
  const value = await post("query", "getMatches", { user });
  return (value as MatchItem[] | null) ?? [];
}

/** The user's applied/saved/hidden tick rows. */
export async function getTicks(user: string): Promise<TickRow[]> {
  const value = await post("query", "getTicks", { user });
  return (value as TickRow[] | null) ?? [];
}

/** Persist a batch of tick writes in one mutation. Returns any short keys
 * the store reports (empty for the Convex driver). */
export async function setTicks(
  user: string,
  writes: TickWrite[]
): Promise<string[]> {
  if (!writes.length) return [];
  const value = await post("mutation", "setTicks", { user, writes });
  return (value as string[] | null) ?? [];
}

/** The user's applications ledger, keyed by short key. */
export async function getLedger(
  user: string
): Promise<Record<string, LedgerRecord>> {
  const value = await post("query", "getLedger", { user });
  return (value as Record<string, LedgerRecord> | null) ?? {};
}

/** Record (or create) an application status in the ledger. */
export async function recordStatus(
  user: string,
  short: string,
  status: string,
  note: string = ""
): Promise<void> {
  await post("mutation", "recordStatus", { user, short, status, note });
}

/** Map of short key -> built resume metadata for the user.
 *
 * The Convex query returns an ARRAY of {short, url, filename, ...} rows; the
 * old cast-to-Record here silently produced a map with no usable keys, so
 * server-rendered resume links could never light up. Folded explicitly now. */
export async function getResumeUrls(user: string): Promise<ResumeUrls> {
  const value = await post("query", "getResumeUrls", { user });
  const out: ResumeUrls = {};
  if (Array.isArray(value)) {
    for (const row of value as Array<Record<string, unknown>>) {
      const short = typeof row.short === "string" ? row.short : "";
      const url = typeof row.url === "string" ? row.url : "";
      if (!short || !url) continue;
      let report: ResumeReport | null = null;
      if (typeof row.report === "string") {
        try {
          report = JSON.parse(row.report) as ResumeReport;
        } catch {
          report = null;
        }
      } else if (row.report && typeof row.report === "object") {
        // Compatibility with reports written before opaque JSON storage.
        report = row.report as ResumeReport;
      }
      out[short] = {
        url,
        filename: typeof row.filename === "string" ? row.filename : "resume.docx",
        format: row.format === "pdf" ? "pdf" : "docx",
        docxUrl: typeof row.docxUrl === "string" ? row.docxUrl : null,
        docxFilename:
          typeof row.docxFilename === "string" ? row.docxFilename : null,
        updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : undefined,
        report,
        prevUrl: typeof row.prevUrl === "string" ? row.prevUrl : null,
        prevFilename:
          typeof row.prevFilename === "string" ? row.prevFilename : null,
        prevFormat:
          row.prevFormat === "pdf" || row.prevFormat === "docx"
            ? row.prevFormat
            : null,
        prevDocxUrl:
          typeof row.prevDocxUrl === "string" ? row.prevDocxUrl : null,
        prevDocxFilename:
          typeof row.prevDocxFilename === "string" ? row.prevDocxFilename : null,
      };
    }
  }
  return out;
}

/** Swap the current and previous resume builds back (keep-N=2 restore). */
export async function restoreResume(
  user: string,
  short: string
): Promise<{ ok: boolean; error?: string }> {
  const value = await post("mutation", "restoreResume", { user, short });
  const res = value as { ok?: boolean; error?: string } | null;
  return res && typeof res.ok === "boolean"
    ? { ok: res.ok, error: res.error }
    : { ok: true };
}

/** Delete a built resume for one match via `resume:deleteResume`. The
 * mutation removes both kept storage artifacts and the resumeBuilds marker.
 * Returns the same {ok, reason} shape the mutation returns. */
export async function deleteResume(
  user: string,
  short: string
): Promise<{ ok: boolean; reason?: string }> {
  const value = await post("mutation", "deleteResume", { user, short }, "resume");
  const res = value as { ok?: boolean; reason?: string } | null;
  // Default to FAILURE on an unrecognised response, not success: reporting a
  // delete that may not have happened would leave the user believing an
  // artifact is gone while it is still in storage.
  if (!res || typeof res.ok !== "boolean") {
    return { ok: false, reason: "unexpected_response" };
  }
  return { ok: res.ok, reason: res.reason };
}

/** Convenience: the full per-user bundle the pages need. */
export async function getTrackerUserData(user: string): Promise<TrackerUserData> {
  const [matches, ticks, ledger, resumes] = await Promise.all([
    getMatches(user),
    getTicks(user),
    getLedger(user),
    getResumeUrls(user),
  ]);
  return { matches, ticks, ledger, resumes };
}

/** The response of the `resume:requestBuild` mutation: {ok:true} on accept,
 * or {ok:false, error} when the profile/matches are missing. */
export type ResumeBuildResponse = { ok: boolean; error?: string };

/** Optional rebuild refinements forwarded to resume:requestBuild. */
export type ResumeBuildOpts = {
  jdText?: string;
  instructions?: string;
  overrides?: { name: string; bullets: string[] }[];
  variant?: string;
};

/** Kick off an on-demand resume build for one match inside Convex. */
export async function requestResumeBuild(
  user: string,
  short: string,
  opts: ResumeBuildOpts = {}
): Promise<ResumeBuildResponse> {
  const value = await post(
    "mutation",
    "requestBuild",
    { user, short, ...opts },
    "resume"
  );
  const res = value as ResumeBuildResponse | null;
  return res && typeof res.ok === "boolean" ? res : { ok: true };
}

/** The live build status for one match, per `resume:getBuildStatus`: while the
 * scheduled action is running -> "building"; after a failure -> the error; once
 * the build row is deleted (success) or never requested -> null. */
export type BuildStatus =
  | "building"
  | { status: "failed"; error: string }
  | null;

/** Poll a single match's resume-build status. */
export async function fetchBuildStatus(
  user: string,
  short: string
): Promise<BuildStatus> {
  const value = await post("query", "getBuildStatus", { user, short }, "resume");
  return value as BuildStatus;
}

/** Manual ingest: request a URL ingest. */
export type IngestResponse =
  | { ingestId: string; status: "fetching"; short: string }
  | { ingestId: string; status: "already_exists"; short: string };

export async function requestIngest(user: string, url: string): Promise<IngestResponse> {
  const value = await post("mutation", "requestIngest", { user, url }, "ingest");
  return value as IngestResponse;
}

export type IngestRow = {
  _id: string;
  user: string;
  short: string;
  url: string;
  canonicalUrl?: string;
  status: string;
  error?: string;
  dedupKey?: string;
  createdAt: number;
  updatedAt: number;
};

export async function getIngestStatus(user: string, ingestId: string): Promise<IngestRow | null> {
  const value = await post("query", "getIngestStatus", { user, ingestId }, "ingest");
  return value as IngestRow | null;
}

// -- inbox (mail) ------------------------------------------------------------

/** One candidate an inbox action offers for resolution. */
export type InboxCandidate = {
  short: string;
  company: string;
  title: string;
  score: number;
};

/** A pending inbox action row, shaped like the `mail:getActions` items. */
export type InboxAction = {
  id: string;
  gmailMessageId: string;
  threadId: string;
  accountEmail: string;
  from: string;
  subject: string;
  receivedAt: string;
  signal: string;
  evidence: string;
  source: string;
  candidates: InboxCandidate[];
  createdAt: string;
};

/** The per-account health half of `mail:getActions`. */
export type MailHealth = {
  email: string;
  lastPushAt: number | null;
  lastSyncAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  watchExpiration: number | null;
  historyId: string | null;
};

export type InboxState = { actions: InboxAction[]; health: MailHealth | null };

/** All pending inbox actions plus the linked account health. */
export async function getInboxActions(user: string): Promise<InboxState> {
  const value = await post("query", "getActions", { user }, "mail");
  return (value as InboxState | null) ?? { actions: [], health: null };
}

export type ResolveInboxActionArgs = {
  id: string;
  short?: string;
  status?: string;
  dismiss?: boolean;
};

/** Resolve (or dismiss) one pending inbox action. */
export async function resolveInboxAction(
  user: string,
  args: ResolveInboxActionArgs
): Promise<void> {
  await post("mutation", "resolveAction", { user, ...args }, "mail");
}

// -- profile (resume) --------------------------------------------------------

/** The `resume:getProfile` query result: profile JSON as an opaque string. */
export type ProfileData = { data: string | null };

/** Read the user's resume profile JSON (null when never saved). */
export async function getProfile(user: string): Promise<ProfileData> {
  const value = await post("query", "getProfile", { user }, "resume");
  return (value as ProfileData | null) ?? { data: null };
}

/** Persist the user's resume profile JSON (a serialized string, validated
 * server-side by the mutation). */
export async function putProfile(user: string, data: string): Promise<void> {
  await post("mutation", "putProfile", { user, data }, "resume");
}

export type ResumeImportPreview = {
  profile: ProfileV2;
  mappings: {
    lineId: string;
    targetPaths: string[];
    segmentMappings?: { segmentId: string; targetPaths: string[] }[];
  }[];
  /** Optional so previews persisted before semantic validation remain reviewable. */
  semanticWarnings?: string[];
  /** Optional so older persisted previews remain reviewable. */
  partialMappedLines?: { id: string; text: string; droppedText: string }[];
  unmappedLines: { id: string; text: string }[];
  sections: {
    id: string;
    title: string;
    kind: SectionKind;
    count: number;
  }[];
};

export async function getResumeImportUploadUrl(user: string): Promise<string> {
  const value = await post(
    "mutation",
    "generateProfileImportUploadUrl",
    { user },
    "resume"
  );
  if (typeof value !== "string" || !value) {
    throw new ConvexError("Convex did not return a resume upload URL.");
  }
  return value;
}

/** Claim an uploaded resume for import. The claim records the storage id
 * server-side under this user and schedules the mapping action; from here on
 * the pipeline never accepts a storage id from a client again. */
export async function claimResumeImportUpload(
  user: string,
  upload: { storageId: string; filename: string; contentType: string }
): Promise<void> {
  await post("mutation", "claimProfileImportUpload", { user, ...upload }, "resume");
}

export type ResumeImportStatus =
  | { status: "mapping"; filename: string }
  | { status: "ready"; filename: string; preview: ResumeImportPreview }
  | { status: "failed"; filename: string; error: string }
  | null;

/** Poll the scheduled import's status. `preview` travels as a JSON string
 * (profile JSON can carry user-authored keys) and is parsed here, server-side,
 * before it reaches the browser. */
export async function getResumeImportStatus(
  user: string
): Promise<ResumeImportStatus> {
  const value = await post("query", "getProfileImportStatus", { user }, "resume");
  if (!value || typeof value !== "object") return null;
  const row = value as {
    status: string;
    filename: string;
    preview: string | null;
    error: string | null;
  };
  if (row.status === "ready" && row.preview) {
    return {
      status: "ready",
      filename: row.filename,
      preview: JSON.parse(row.preview) as ResumeImportPreview,
    };
  }
  if (row.status === "failed" || row.status === "ready") {
    // A "ready" row with no preview is a server bug; surface it as a failure
    // rather than polling forever.
    return {
      status: "failed",
      filename: row.filename,
      error: row.error ?? "Couldn't import this resume.",
    };
  }
  return { status: "mapping", filename: row.filename };
}

/** Discard the user's pending import (blob and record). Takes no storage id -
 * the server only ever deletes the blob recorded on this user's claim. */
export async function discardResumeImportUpload(user: string): Promise<void> {
  await post("mutation", "discardProfileImportUpload", { user }, "resume");
}

/** Replace the stored profile with a confirmed import. The mutation snapshots
 * the current profile into profileBackups before overwriting it. */
export async function importProfile(user: string, data: string): Promise<void> {
  await post("mutation", "applyProfileImport", { user, data }, "resume");
}

// -- tracker deadlines -------------------------------------------------------

/** Set (or clear) a match's due date. */
export async function setDueAt(
  user: string,
  short: string,
  dueAt: string | null
): Promise<void> {
  await post("mutation", "setDueAt", { user, short, dueAt }, "tracker");
}

/** Set (or clear) a match's snooze. */
export async function setSnooze(
  user: string,
  short: string,
  snoozedUntil: string | null
): Promise<void> {
  await post("mutation", "setSnooze", { user, short, snoozedUntil }, "tracker");
}

/** The per-account health half of `tracker:getHealth`. */
export type TrackerHealthMail = {
  email: string;
  lastPushAt: number | null;
  lastSyncAt: number | null;
  lastError: string | null;
  watchExpiration: number | null;
};

/** The `tracker:getHealth` query payload. */
export type TrackerHealth = {
  watcherPushedAt: number | null;
  mail: TrackerHealthMail | null;
  pendingInbox: number;
  stuckBuilds: number;
};

/** Read the tracker/mail pipeline health for the user. */
export async function getHealth(user: string): Promise<TrackerHealth | null> {
  const value = await post("query", "getHealth", { user }, "tracker");
  return value as TrackerHealth | null;
}


// -- credentials (connections) ------------------------------------------------

/** One stored provider credential row, per `credentials:listCredentials`.
 *  `status` is one of "ok" | "error" | "untested" and tells the Connections
 *  page which pill to draw; the secret itself is never returned. */
export type CredentialRow = {
  provider: string;
  hint?: string;
  label?: string;
  status: "ok" | "error" | "untested";
  lastCheckedAt?: number;
  lastError?: string;
  updatedAt?: number;
};

/** All of the user's provider credentials, keyed by provider name. */
export async function listCredentials(user: string): Promise<CredentialRow[]> {
  const value = await post("query", "listCredentials", { user }, "credentials");
  return (value as CredentialRow[] | null) ?? [];
}

/** Save (or replace) one provider's secret fields. */
export async function putCredential(
  user: string,
  provider: string,
  fields: Record<string, string>
): Promise<void> {
  await post(
    "action",
    "putCredential",
    { user, provider, fields },
    "credentials"
  );
}

/** Ping the provider with the saved credential. Returns ok + a human detail. */
export async function testCredential(
  user: string,
  provider: string
): Promise<{ ok: boolean; detail: string }> {
  const value = await post(
    "action",
    "testCredential",
    { user, provider },
    "credentials"
  );
  return value as { ok: boolean; detail: string };
}

/** Delete one provider's stored credential. */
export async function deleteCredential(
  user: string,
  provider: string
): Promise<void> {
  await post(
    "mutation",
    "deleteCredential",
    { user, provider },
    "credentials"
  );
}

/** What the consent flow needs, read from the deployment that holds it rather
 *  than from this server's env. */
export type OAuthConfig = {
  clientId: string | null;
  missing: string[];
};

export async function getOAuthConfig(): Promise<OAuthConfig> {
  const value = await post("query", "getOAuthConfig", {}, "mail");
  return value as OAuthConfig;
}

/** Record a started OAuth flow so the callback can spend it exactly once. */
export async function registerOAuthNonce(
  nonce: string,
  user: string,
  expiresAt: number
): Promise<void> {
  await post("mutation", "registerOAuthNonce", { nonce, user, expiresAt }, "mail");
}

/** The user's connected mailbox, from the table the OAuth flow actually writes. */
export async function getMailAccount(
  user: string
): Promise<{ email: string; lastError: string | null; lastSyncAt: number | null } | null> {
  const value = await post("query", "getMailAccount", { user }, "mail");
  return value as {
    email: string;
    lastError: string | null;
    lastSyncAt: number | null;
  } | null;
}

/** Whether mail-sync is configured on this deployment. It is opt-in: a
 *  deployment that never sets it up should say so, not show a dead feature. */
export type MailSyncStatus = { enabled: boolean; missing: string[] };

export async function getMailSyncStatus(): Promise<MailSyncStatus> {
  const value = await post("query", "getMailSyncStatus", {}, "mail");
  return value as MailSyncStatus;
}

/** The user's resume-model preference plus today's shared-key usage. Contains
 *  no secret - the optional API key behind a choice lives in `credentials`. */
export type ResumeLlm = {
  /** null means "whatever the operator provides" - the default for everyone. */
  provider: string | null;
  model: string | null;
  defaultProvider: string;
  defaultModel: string;
  dailyCap: number;
  usedToday: number;
  /** Whether the deployment has a shared key at all. False means the quota is
   *  meaningless and tailoring needs the user's own key. */
  sharedAvailable: boolean;
};

export async function getResumeLlm(user: string): Promise<ResumeLlm> {
  const value = await post("query", "getResumeLlm", { user }, "settings");
  return value as ResumeLlm;
}

/** Save the resume-model preference. An empty provider resets to the default. */
export async function setResumeLlm(
  user: string,
  provider: string | null,
  model: string | null
): Promise<void> {
  await post(
    "mutation",
    "setResumeLlm",
    { user, provider: provider ?? undefined, model: model ?? undefined },
    "settings"
  );
}
