import "server-only";

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
  kind: "query" | "mutation",
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

export type ResumeUrls = Record<string, string>;

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

/** Map of short key -> built resume URL for the user. */
export async function getResumeUrls(user: string): Promise<ResumeUrls> {
  const value = await post("query", "getResumeUrls", { user });
  return (value as ResumeUrls | null) ?? {};
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

/** Kick off an on-demand resume build for one match inside Convex. */
export async function requestResumeBuild(
  user: string,
  short: string
): Promise<ResumeBuildResponse> {
  const value = await post("mutation", "requestBuild", { user, short }, "resume");
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
