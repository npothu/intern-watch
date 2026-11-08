// Posting liveness: is the job behind a match URL still open?
//
// Pure classifier + an injected fetcher, so the cron (liveness_probe.ts) and
// the tests share one decision table. Three verdicts:
//   open    - the posting is up (or at least nothing says it is gone)
//   closed  - a specific, ATS-level "gone" signal
//   unknown - anything else: bot walls, 403/429/5xx, timeouts, a URL shape we
//             can't map. Unknown NEVER closes anything; the probe just tries
//             again later.
//
// Every ATS API "gone" signal is confirmed against the posting page before it
// counts, because the APIs only list PUBLISHED postings: a Lever posting that
// is unlisted but still takes applications 404s on api.lever.co while its
// page renders with an Apply button (observed). Workday and Oracle CX are the
// exceptions - their pages are JS shells that answer 200 for anything, so the
// API is the only signal there, and their signals are explicit (CXS 404 or
// posted/canApply false; Oracle's ById finder returning zero items).
//
// URL -> API mapping reuses jd_acquire.atsApiUrl so the two stay in step.
// Oracle CX lives here for now; once jd_acquire grows an Oracle adapter, fold
// oracleTarget into it.

import { atsApiUrl, stripJdHtml } from "./jd_acquire";

export type LivenessState = "open" | "closed" | "unknown";
export type Verdict = { state: LivenessState; reason: string };

/** What a fetch returned, after redirects. */
export type HttpResult = {
  status: number;
  /** URL after redirects (resp.url); equal to the request URL when none. */
  finalUrl: string;
  body: string;
  /** The body hit the size cap, so a missing substring proves nothing. */
  truncated?: boolean;
};
/** May throw on network errors / timeouts; those become `unknown`. */
export type Fetcher = (url: string) => Promise<HttpResult>;

export type ProbePlan = {
  kind:
    | "greenhouse"
    | "lever"
    | "ashby"
    | "smartrecruiters"
    | "workday"
    | "workable"
    | "oracle"
    | "avature"
    | "page";
  /** The posting page itself (the URL the user would click). */
  page: string;
  /** Public JSON endpoint, when the ATS has one. */
  api?: string;
  /** Ashby: the posting id to look for in the board JSON. */
  id?: string;
};

// -- URL -> plan -------------------------------------------------------------

/**
 * Oracle Recruiting Cloud (CandidateExperience) posting -> the public REST
 * finder the career site itself calls. Returns null for other URLs.
 *   https://<pod>.fa.<dc>.oraclecloud.com/hcmUI/CandidateExperience/<lang>/sites/<site>/job/<id>
 *   .../sites/<site>/requisitions/preview/<id>
 */
export function oracleTarget(u: URL): string | null {
  const host = u.hostname.toLowerCase();
  if (!host.endsWith(".oraclecloud.com")) return null;
  const m = u.pathname.match(
    /\/hcmUI\/CandidateExperience\/[^/]+\/sites\/([^/]+)\/(?:job|requisitions\/preview)\/(\d+)/i,
  );
  if (!m) return null;
  const finder = `ById;Id=%22${m[2]}%22,siteNumber=${encodeURIComponent(m[1])}`;
  return `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?onlyData=true&finder=${finder}`;
}

function isAvature(u: URL): boolean {
  return (
    u.hostname.toLowerCase().endsWith(".avature.net") ||
    /\/JobDetail(?:\/|$)/i.test(u.pathname)
  );
}

/**
 * Decide how to probe a URL. Null for anything that isn't http(s) - those
 * can't be checked and are left alone.
 */
export function probePlan(rawUrl: string): ProbePlan | null {
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const page = u.toString();
  const host = u.hostname.toLowerCase();

  const oracle = oracleTarget(u);
  if (oracle) return { kind: "oracle", page, api: oracle };
  if (isAvature(u)) return { kind: "avature", page };

  // EU Greenhouse boards are served from a different API host than the one
  // atsApiUrl assumes; a wrong host would 404 for a live job. Page-only.
  if (host.includes(".eu.greenhouse.io")) return { kind: "page", page };

  // Workday apply/login sub-pages ("…/job/<loc>/<slug>/apply") are not part
  // of the posting path the CXS API knows; strip them or a live job 404s.
  let apiInput = page;
  if (/\.myworkdayjobs\.com$/.test(host)) {
    const v = new URL(page);
    v.pathname = v.pathname.replace(/\/(?:apply|login)(?:\/.*)?$/i, "");
    apiInput = v.toString();
  }
  const ats = atsApiUrl(apiInput);
  if (ats) {
    if (ats.kind.startsWith("ashby:")) {
      return { kind: "ashby", page, api: ats.api, id: ats.kind.slice("ashby:".length) };
    }
    const kind = ats.kind as ProbePlan["kind"];
    if (["greenhouse", "lever", "smartrecruiters", "workday", "workable"].includes(kind)) {
      return { kind, page, api: ats.api };
    }
  }
  return { kind: "page", page };
}

// -- page signals -------------------------------------------------------------

// Phrases career sites render for a dead posting. Kept specific (subject +
// "no longer"/"filled"/"expired") so ordinary JD prose doesn't trip them.
const CLOSED_TEXT_RES: RegExp[] = [
  /\b(?:job|position|posting|role|opening|requisition|vacancy)(?: posting)? (?:is|has been) no longer (?:available|open|active|accepting)/i,
  /\bno longer accepting applications\b/i,
  /\b(?:job|position|posting|role|requisition) has been (?:filled|closed|removed)\b/i,
  /\b(?:job|position|posting|requisition|job posting) has expired\b/i,
  /\b(?:this|the) (?:job|position|posting|requisition) is (?:closed|no longer open)\b/i,
  /\bthe (?:job|page|position) you are looking for (?:is no longer|no longer exists|has been removed|doesn't exist|does not exist)/i,
];

/** A known "position closed/filled" phrase in the page's visible text. */
export function closedText(html: string): string | null {
  // Only the first chunk: the banner sits near the top, and stripping a
  // multi-MB SPA bundle is wasted work.
  const text = stripJdHtml(html.slice(0, 300_000));
  for (const re of CLOSED_TEXT_RES) {
    const m = text.match(re);
    if (m) return m[0].toLowerCase();
  }
  return null;
}

function hasErrorFlag(finalUrl: string, requested: string): boolean {
  try {
    const f = new URL(finalUrl).searchParams.get("error");
    const r = new URL(requested).searchParams.get("error");
    return f === "true" && r !== "true";
  } catch {
    return false;
  }
}

/**
 * Generic page verdict. 404/410, a Greenhouse-style `?error=true` redirect,
 * or a closed phrase is closed. A plain 200 is open. Everything else (202
 * bot walls, 403, 429, 5xx) is unknown.
 */
export function classifyPage(plan: ProbePlan, res: HttpResult): Verdict {
  if (res.status === 404 || res.status === 410) {
    return { state: "closed", reason: `page-${res.status}` };
  }
  if (res.status >= 200 && res.status < 400 && hasErrorFlag(res.finalUrl, plan.page)) {
    return { state: "closed", reason: "redirect-error" };
  }
  if (plan.kind === "avature" && res.status === 200) {
    // A dead Avature JobDetail redirects to the search page.
    let path = "";
    try {
      path = new URL(res.finalUrl).pathname;
    } catch {
      /* keep "" */
    }
    // Only the search page counts; a login/consent/locale hop is not a close.
    if (/SearchJobs|\/search(?:\/|$)/i.test(path)) {
      return { state: "closed", reason: "redirect-search" };
    }
  }
  if (res.status !== 200) return { state: "unknown", reason: `page-http-${res.status}` };
  if (!res.body.trim()) return { state: "unknown", reason: "page-empty" };
  const phrase = closedText(res.body);
  if (phrase) return { state: "closed", reason: `page-text:${phrase.slice(0, 60)}` };
  return { state: "open", reason: "page-200" };
}

/**
 * Did the page confirm an API "gone" signal? Same as classifyPage, plus one
 * Greenhouse-specific shape: a dead board posting redirects off the posting
 * path (to the board root or the employer's careers site).
 */
function confirmGone(plan: ProbePlan, res: HttpResult): Verdict {
  const v = classifyPage(plan, res);
  if (v.state === "closed") return v;
  if (plan.kind === "greenhouse" && res.status === 200) {
    try {
      const f = new URL(res.finalUrl);
      const onPosting =
        (f.hostname.toLowerCase().endsWith("greenhouse.io") && /\/jobs\/\d+/.test(f.pathname)) ||
        // Boards that forward to the employer's own site keep the job id.
        f.searchParams.has("gh_jid");
      if (!onPosting) return { state: "closed", reason: "redirect-off-posting" };
    } catch {
      /* fall through */
    }
  }
  // The API says gone but the page still renders the posting: unlisted, not
  // closed (Lever does this). Keep it open; the page is what the user uses.
  if (v.state === "open") return { state: "open", reason: "api-gone-page-200" };
  return v;
}

// -- API signals ---------------------------------------------------------------

type ApiSignal = "open" | "gone" | "unknown";

function parseJson(res: HttpResult): unknown {
  if (res.truncated) return undefined;
  try {
    return JSON.parse(res.body);
  } catch {
    return undefined;
  }
}

/** Read one ATS API response. "gone" still needs page confirmation (except
 * Workday / Oracle, see the header). */
export function apiSignal(plan: ProbePlan, res: HttpResult): { signal: ApiSignal; reason: string } {
  if (res.status === 404 || res.status === 410) {
    return { signal: "gone", reason: `api-${res.status}` };
  }
  if (res.status !== 200) return { signal: "unknown", reason: `api-http-${res.status}` };

  if (plan.kind === "ashby") {
    const id = (plan.id ?? "").toLowerCase();
    if (id && res.body.toLowerCase().includes(id)) return { signal: "open", reason: "ashby-listed" };
    const p = parseJson(res) as { jobs?: unknown } | undefined;
    if (p && Array.isArray(p.jobs)) return { signal: "gone", reason: "ashby-not-listed" };
    return { signal: "unknown", reason: "ashby-unreadable" };
  }

  const p = parseJson(res) as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") return { signal: "unknown", reason: "api-bad-json" };

  if (plan.kind === "oracle") {
    if (!Array.isArray(p.items)) return { signal: "unknown", reason: "oracle-no-items" };
    return p.items.length
      ? { signal: "open", reason: "oracle-found" }
      : { signal: "gone", reason: "oracle-empty" };
  }
  if (plan.kind === "workday") {
    const info = p.jobPostingInfo as { posted?: unknown; canApply?: unknown } | undefined;
    if (!info || typeof info !== "object") return { signal: "unknown", reason: "workday-no-info" };
    if (info.posted === false || info.canApply === false) {
      return { signal: "gone", reason: "workday-not-posted" };
    }
    return { signal: "open", reason: "workday-posted" };
  }
  if (plan.kind === "smartrecruiters" && p.active === false) {
    return { signal: "gone", reason: "smartrecruiters-inactive" };
  }
  return { signal: "open", reason: `${plan.kind}-200` };
}

// -- orchestrator ---------------------------------------------------------------

/** Kinds whose API "gone" is final without a page check (JS-shell pages). */
const API_IS_FINAL = new Set<ProbePlan["kind"]>(["workday", "oracle"]);

/**
 * Probe one posting URL. At most two requests (API, then the page to confirm
 * a gone signal, or the page alone for non-ATS URLs). Never throws.
 */
export async function checkLiveness(url: string, fetcher: Fetcher): Promise<Verdict> {
  const plan = probePlan(url);
  if (!plan) return { state: "unknown", reason: "unprobeable-url" };

  const page = async (): Promise<HttpResult | null> => {
    try {
      return await fetcher(plan.page);
    } catch {
      return null;
    }
  };

  if (!plan.api) {
    const res = await page();
    return res ? classifyPage(plan, res) : { state: "unknown", reason: "page-fetch-failed" };
  }

  let api: HttpResult;
  try {
    api = await fetcher(plan.api);
  } catch {
    return { state: "unknown", reason: "api-fetch-failed" };
  }
  const sig = apiSignal(plan, api);
  if (sig.signal === "open") return { state: "open", reason: sig.reason };
  if (sig.signal === "unknown") return { state: "unknown", reason: sig.reason };
  if (API_IS_FINAL.has(plan.kind)) return { state: "closed", reason: sig.reason };

  const res = await page();
  if (!res) return { state: "unknown", reason: `${sig.reason}+page-fetch-failed` };
  const v = confirmGone(plan, res);
  return { state: v.state, reason: `${sig.reason}+${v.reason}` };
}

// -- streak bookkeeping (pure; the mutation applies it) ---------------------------

/** Verdicts in a row needed before a row is marked closed (anti-flap). */
export const CLOSED_CONFIRMATIONS = 2;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** When to look at a row again, by outcome. */
/**
 * Minimum time between two COUNTED closed verdicts. Enforced in nextLiveness
 * itself, not just by scheduling: a duplicate or early verdict (a re-run, an
 * overlapping probe, a manual `npx convex run`) records but does not count,
 * so a few-hour outage or bot block can never produce the confirmations.
 */
export const CLOSED_CONFIRM_GAP_MS = 1 * DAY;

export const RECHECK_MS = {
  open: 3 * DAY,
  /** One closed verdict so far: confirm once the gap has passed. */
  closedPending: CLOSED_CONFIRM_GAP_MS,
  /** Marked closed: keep checking slowly in case it reopens. */
  closed: 7 * DAY,
  unknown: 1 * DAY,
  /** Applied / hidden / not probeable: just rotate it to the back. */
  skipped: 7 * DAY,
} as const;

export type LivenessRecord = {
  /** The URL the verdicts below are about; a changed URL starts over. */
  url: string;
  lastVerdict: LivenessState;
  reason: string;
  checkedAt: number;
  closedStreak: number;
  /** When the latest closed verdict that counted toward the streak landed. */
  closedCountedAt?: number;
  /** Set once the streak reaches CLOSED_CONFIRMATIONS: the row is closed. */
  closedAt?: number;
};

/**
 * Fold one verdict into a row's record. Open clears the streak (and an
 * earlier closed mark - postings do get reposted). Unknown breaks a pending
 * streak (the closed verdicts must be consecutive) but never lifts an
 * existing closed mark - only an open verdict does that. A closed verdict
 * counts only if CLOSED_CONFIRM_GAP_MS has passed since the last counted one;
 * an earlier one is recorded (lastVerdict/checkedAt) without counting.
 */
export function nextLiveness(
  prev: LivenessRecord | undefined,
  url: string,
  verdict: Verdict,
  now: number,
): { record: LivenessRecord; dueAt: number } {
  const base: LivenessRecord =
    prev && prev.url === url ? prev : { url, lastVerdict: "unknown", reason: "", checkedAt: 0, closedStreak: 0 };
  const record: LivenessRecord = {
    ...base,
    url,
    lastVerdict: verdict.state,
    reason: verdict.reason.slice(0, 200),
    checkedAt: now,
  };
  if (verdict.state === "open") {
    record.closedStreak = 0;
    delete record.closedAt;
    delete record.closedCountedAt;
    return { record, dueAt: now + RECHECK_MS.open };
  }
  if (verdict.state === "unknown") {
    if (!record.closedAt) {
      record.closedStreak = 0;
      delete record.closedCountedAt;
    }
    return { record, dueAt: now + (record.closedAt ? RECHECK_MS.closed : RECHECK_MS.unknown) };
  }
  if (record.closedAt) return { record, dueAt: now + RECHECK_MS.closed };
  // A pending streak with no counted time (written before the field existed)
  // dates from its last check.
  const lastCounted = base.closedStreak > 0 ? (base.closedCountedAt ?? base.checkedAt) : undefined;
  if (lastCounted !== undefined && now - lastCounted < CLOSED_CONFIRM_GAP_MS) {
    // Too early to count: keep the streak, come back when the gap is up.
    return { record, dueAt: lastCounted + CLOSED_CONFIRM_GAP_MS };
  }
  record.closedStreak = base.closedStreak + 1;
  record.closedCountedAt = now;
  if (record.closedStreak >= CLOSED_CONFIRMATIONS) {
    record.closedAt = now;
    return { record, dueAt: now + RECHECK_MS.closed };
  }
  return { record, dueAt: now + RECHECK_MS.closedPending };
}

/** Is this stored record a closed mark for the row's CURRENT url? */
export function isClosed(rec: LivenessRecord | undefined, currentUrl: unknown): boolean {
  return Boolean(rec?.closedAt) && typeof currentUrl === "string" && rec?.url === currentUrl;
}
