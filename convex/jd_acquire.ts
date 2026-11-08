// Shared JD acquisition: turn a job URL into the full job-description text.
//
// Tier order (first hit wins), mirroring src/resume/jd_source.py — keep the
// two in lockstep when adding an ATS or changing thresholds:
//   1. ATS public JSON APIs (greenhouse / lever / ashby / smartrecruiters /
//      workday CXS / workable / oracle CX / eightfold / apple) resolved from
//      the URL shape — full-fidelity JD straight from the source, no
//      scraping. Each is the unauthenticated endpoint the employer's own
//      career page calls.
//   1b. Oracle CX behind a custom domain (careers.<employer>.com/en/sites/
//      <site>/job/<id>): the fetched page names its oraclecloud pod, which
//      then answers the same REST feed.
//   2. Embedded structured data on the fetched page (__NEXT_DATA__ / JSON-LD
//      "description" / Phenom's phApp.ddo), which carries the JD without
//      nav/footer chrome. iCIMS pages are fetched as their `?in_iframe=1`
//      variant (pageFetchUrl), the frame that carries the JSON-LD.
//   3. The stripped page body, gated by a plausibility check so JS debris
//      never masquerades as a JD.
// The LLM extraction tier (last resort) lives with the callers that have
// model plumbing (resume_node, ingest_node), not here: this module stays
// pure + fetch so both runtimes and the tests can share it.
//
// Consumed by resume_node (build-time fallback) and ingest_node (manual
// ingest) so a match's jobDescription exists in the DB the moment the row
// is created — the build should almost never need to acquire anything.

export const JD_MIN_CHARS = 200; // jd_source.py MIN_JD_CHARS
export const JD_MAX_CHARS = 20_000; // full JD; tailor excerpts separately

// -- text helpers -----------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, "&"); // last: unlocks double-escaped payloads
}

export function stripJdHtml(s: string): string {
  // Entities decode BEFORE tag stripping: Greenhouse's content API returns
  // entity-ESCAPED HTML, so stripping first would leave literal <p> tags in
  // the "plain" text (normalize.py strip_html order - keep in lockstep).
  let t = decodeEntities(s);
  if (/&(?:#\d+|#x[0-9a-f]+|[a-z]+);/i.test(t)) t = decodeEntities(t);
  return t
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    // SVG path data reads as coordinate soup once tags are stripped - drop
    // the whole element (seen on careers.roblox.com).
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    // A fetch cap can truncate the page mid-element: an unclosed script/
    // style/noscript/svg (or a tag cut mid-attribute) never matches the
    // paired/tag regexes, so its payload leaks into the text - observed as
    // a truncated Next.js flight stream (`self.__next_f.push`) dumping SVG
    // path strings into a stored JD. Any of these elements left unclosed
    // means truncation, so drop from there to end-of-text.
    .replace(/<(script|style|noscript|svg)\b[\s\S]*$/gi, " ")
    .replace(/<[^>]*$/, " ")
    .replace(/<(br|\/p|\/li|\/div|\/h[1-6]|\/ul|\/ol|\/tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const JD_MARKER_RE =
  /responsibilit|qualification|requirement|you will|we are looking|experience\s+(?:in|with)|degree/i;
const JS_TOKEN_RE = /=>|function\s*\(|\bvar\s|\bconst\s|window\.|self\.__|\{"|"\}|\\+"$/i;

/** jd_source.py _looks_like_jd: a JD marker keeps it; else token density rejects. */
export function looksLikeJd(text: string): boolean {
  if (JD_MARKER_RE.test(text)) return true;
  if (!text) return true;
  const tokens = text.match(new RegExp(JS_TOKEN_RE.source, "gi"))?.length ?? 0;
  return tokens / (text.length / 1000) < 2.0;
}

function ok(text: string | null | undefined): string | null {
  if (!text) return null;
  const t = text.replace(/[ \t]+/g, " ").trim().slice(0, JD_MAX_CHARS);
  return t.length >= JD_MIN_CHARS ? t : null;
}

// -- tier 1: ATS public APIs ------------------------------------------------

/** `company` when the host alone names the employer and the payload does not. */
export type AtsApi = { kind: string; api: string; company?: string };

/** Posting fields an ATS payload names outright. Ingest prefers these over
 * page scraping: a JS-rendered shell's <title> is often the employer name. */
export type JobMeta = { title?: string; company?: string; location?: string };

// <pod>.fa.<dc>.oraclecloud.com and fa-<x>-saasfaprod1.fa.ocs.oraclecloud.com
const ORACLE_HOST_RE = /^[a-z0-9-]+\.fa(?:\.[a-z0-9-]+)*\.oraclecloud\.com$/;
// [/hcmUI/CandidateExperience]/<lang>[/sites/<site>]/job/<id>
const ORACLE_PATH_RE =
  /^(\/hcmUI\/CandidateExperience)?\/[a-z]{2}(?:[-_][A-Za-z]{2})?\/(?:sites\/([A-Za-z0-9_]+)\/)?(?:requisitions\/preview|job)\/(\d+)(?:\/|$)/;

/** Oracle Recruiting Cloud's public requisition-detail feed. siteNumber is
 * optional (the feed answers without it); only the quotes are escaped -
 * the finder's `;` `,` `=` must stay literal. */
export function oracleApiUrl(host: string, site: string | undefined, id: string): string {
  const finder = `ById;Id=%22${id}%22${site ? `,siteNumber=${site}` : ""}`;
  return `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=${finder}`;
}

/** Oracle CX served from a custom domain (careers.<employer>.com/en/sites/
 * CX_1/job/<id>): the URL has the Oracle shape but not the pod host, which
 * the fetched page names. Null unless both are present. */
export function oracleApiFromPage(rawUrl: string, html: string): AtsApi | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const m = u.pathname.match(ORACLE_PATH_RE);
  if (!m || !m[2]) return null; // a custom domain always carries /sites/<site>/
  const pod = html.match(/\b([a-z0-9-]+\.fa(?:\.[a-z0-9-]+)*\.oraclecloud\.com)\b/i)?.[1]?.toLowerCase();
  if (!pod || !ORACLE_HOST_RE.test(pod)) return null;
  return { kind: "oracle", api: oracleApiUrl(pod, m[2], m[3]) };
}

/** The URL whose HTML carries the posting. iCIMS wraps the JD in an iframe;
 * the outer page is a ~0.5MB shell (past the fetch cap) without it, while
 * `?in_iframe=1` is the small frame with the JSON-LD JobPosting. */
export function pageFetchUrl(rawUrl: string): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const host = u.hostname.toLowerCase();
  if (host.endsWith(".icims.com") && /^\/jobs\/\d+(?:\/|$)/.test(u.pathname)
      && u.searchParams.get("in_iframe") !== "1") {
    u.searchParams.set("in_iframe", "1");
    return u.toString();
  }
  return rawUrl;
}

/**
 * Map a job-posting URL to the ATS's public JSON endpoint for that posting.
 * Pure string work — safe to unit test exhaustively. Returns null when the
 * URL doesn't look like a supported ATS posting.
 */
export function atsApiUrl(rawUrl: string): AtsApi | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "");

  // boards.greenhouse.io/<board>/jobs/<id> and job-boards.greenhouse.io/...
  if (host.endsWith("greenhouse.io")) {
    const m = path.match(/^\/([^/]+)\/jobs\/(\d+)/);
    if (m)
      return {
        kind: "greenhouse",
        api: `https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}`,
      };
  }
  // jobs.lever.co/<org>/<uuid>
  if (host.endsWith("lever.co")) {
    const m = path.match(/^\/([^/]+)\/([0-9a-f-]{36})/i);
    if (m)
      return { kind: "lever", api: `https://api.lever.co/v0/postings/${m[1]}/${m[2]}` };
  }
  // jobs.ashbyhq.com/<org>/<uuid> — no per-posting endpoint; fetch the board
  // and match the id in jdFromAtsPayload.
  if (host.endsWith("ashbyhq.com")) {
    const m = path.match(/^\/([^/]+)\/([0-9a-f-]{36})/i);
    if (m)
      return {
        kind: `ashby:${m[2].toLowerCase()}`,
        api: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(m[1])}?includeCompensation=false`,
      };
  }
  // jobs.smartrecruiters.com/<Company>/<numeric-id>-slug
  if (host.endsWith("smartrecruiters.com")) {
    const m = path.match(/^\/([^/]+)\/(\d+)/);
    if (m)
      return {
        kind: "smartrecruiters",
        api: `https://api.smartrecruiters.com/v1/companies/${m[1]}/postings/${m[2]}`,
      };
  }
  // <tenant>.wd<N>.myworkdayjobs.com[/<locale>]/<site>/job/<...path>
  if (/\.wd\d+\.myworkdayjobs\.com$/.test(host)) {
    const tenant = host.split(".")[0];
    const m = path.match(/^(?:\/[a-z]{2}(?:-[A-Za-z]{2})?)?\/([^/]+)\/job\/(.+)$/);
    if (m)
      return {
        kind: "workday",
        api: `https://${host}/wday/cxs/${tenant}/${m[1]}/job/${m[2]}`,
      };
  }
  // apply.workable.com/<org>/j/<SHORTCODE>
  if (host.endsWith("workable.com")) {
    const m = path.match(/^\/([^/]+)\/j\/([A-Za-z0-9]+)/);
    if (m)
      return {
        kind: "workable",
        api: `https://apply.workable.com/api/v1/accounts/${m[1]}/jobs/${m[2].toUpperCase()}`,
      };
  }
  // <pod>.fa.<dc>.oraclecloud.com/hcmUI/CandidateExperience/<lang>[/sites/<site>]/job/<id>
  if (ORACLE_HOST_RE.test(host)) {
    const m = path.match(ORACLE_PATH_RE);
    if (m && m[1]) return { kind: "oracle", api: oracleApiUrl(host, m[2], m[3]) };
  }
  // Eightfold: <org>.eightfold.ai/careers/job/<id> or /careers?pid=<id>, and
  // Microsoft's apply.careers.microsoft.com (robots.txt allows /api/apply).
  if (host.endsWith(".eightfold.ai") || host === "apply.careers.microsoft.com") {
    const id = path.match(/^\/careers\/job\/(\d+)/)?.[1]
      ?? (path === "/careers" ? u.searchParams.get("pid") : null);
    if (id && /^\d+$/.test(id))
      return {
        kind: "eightfold",
        api: `https://${host}/api/apply/v2/jobs/${id}`,
        ...(host === "apply.careers.microsoft.com" ? { company: "Microsoft" } : {}),
      };
  }
  // jobs.apple.com/<locale>/details/<id>[/<slug>]
  if (host === "jobs.apple.com") {
    const m = path.match(/^(?:\/[a-z]{2}-[a-z]{2})?\/details\/([A-Za-z0-9-]+)/i);
    if (m) return { kind: "apple", api: `https://jobs.apple.com/api/v1/jobDetails/${m[1]}` };
  }
  return null;
}

function str(x: unknown): string {
  return typeof x === "string" ? x.trim() : "";
}

function joinSections(parts: [string, unknown][]): string {
  return parts
    .map(([heading, body]) => {
      const text = stripJdHtml(str(body));
      return text ? (heading ? `${heading}\n${text}` : text) : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function oracleItem(p: Record<string, unknown>): Record<string, unknown> | null {
  const items = p.items as Record<string, unknown>[] | undefined;
  return Array.isArray(items) && items[0] && typeof items[0] === "object" ? items[0] : null;
}

function appleRes(p: Record<string, unknown>): Record<string, unknown> {
  return (p.res && typeof p.res === "object" ? p.res : p) as Record<string, unknown>;
}

/** Title / company / location named by an ATS payload (see JobMeta). */
export function metaFromAtsPayload(kind: string, payload: unknown): JobMeta | null {
  const p = payload as Record<string, unknown>;
  if (!p || typeof p !== "object") return null;
  let meta: JobMeta = {};
  if (kind === "oracle") {
    const it = oracleItem(p);
    if (!it) return null;
    meta = { title: str(it.Title), location: str(it.PrimaryLocation) };
  } else if (kind === "eightfold") {
    meta = { title: str(p.posting_name) || str(p.name), location: str(p.location) };
  } else if (kind === "apple") {
    const r = appleRes(p);
    const loc = (r.locations as { name?: string }[] | undefined)?.[0];
    meta = { title: str(r.postingTitle), company: "Apple", location: str(loc?.name) };
  } else if (kind === "greenhouse") {
    meta = {
      title: str(p.title),
      company: str(p.company_name),
      location: str((p.location as { name?: string } | undefined)?.name),
    };
  } else if (kind === "lever") {
    meta = { title: str(p.text), location: str((p.categories as { location?: string } | undefined)?.location) };
  } else if (kind === "smartrecruiters") {
    const loc = (p.location ?? {}) as { city?: string; region?: string; country?: string };
    meta = {
      title: str(p.name),
      company: str((p.company as { name?: string } | undefined)?.name),
      location: [loc.city, loc.region, loc.country?.toUpperCase()].map(str).filter(Boolean).join(", "),
    };
  } else if (kind === "workday") {
    const info = (p.jobPostingInfo ?? {}) as { title?: string; location?: string };
    meta = { title: str(info.title), location: str(info.location) };
  } else if (kind === "workable") {
    meta = { title: str(p.title) };
  } else {
    return null;
  }
  const out: JobMeta = {};
  for (const [k, val] of Object.entries(meta) as [keyof JobMeta, string | undefined][]) {
    if (val) out[k] = val;
  }
  return Object.keys(out).length ? out : null;
}

/** Pull the full JD text out of an ATS API's JSON payload. */
export function jdFromAtsPayload(kind: string, payload: unknown): string | null {
  const p = payload as Record<string, unknown>;
  if (!p || typeof p !== "object") return null;
  if (kind === "greenhouse") {
    return ok(stripJdHtml(String(p.content ?? "")));
  }
  if (kind === "lever") {
    const parts: string[] = [String(p.descriptionPlain ?? p.description ?? "")];
    for (const l of (p.lists as { text?: string; content?: string }[]) ?? []) {
      parts.push(l.text ?? "", stripJdHtml(l.content ?? ""));
    }
    parts.push(String((p as { additionalPlain?: string }).additionalPlain ?? ""));
    return ok(stripJdHtml(parts.join("\n")));
  }
  if (kind.startsWith("ashby:")) {
    const id = kind.slice("ashby:".length);
    const jobs = (p.jobs as { id?: string; descriptionHtml?: string; descriptionPlain?: string }[]) ?? [];
    const hit = jobs.find((j) => (j.id ?? "").toLowerCase() === id);
    if (!hit) return null;
    return ok(hit.descriptionPlain ?? stripJdHtml(hit.descriptionHtml ?? ""));
  }
  if (kind === "smartrecruiters") {
    const sections = ((p.jobAd as Record<string, unknown>)?.sections ?? {}) as Record<
      string,
      { title?: string; text?: string }
    >;
    const parts = Object.values(sections).map((s) => `${s.title ?? ""}\n${stripJdHtml(s.text ?? "")}`);
    return ok(parts.join("\n\n"));
  }
  if (kind === "workday") {
    const info = (p.jobPostingInfo ?? {}) as { jobDescription?: string };
    return ok(stripJdHtml(info.jobDescription ?? ""));
  }
  if (kind === "workable") {
    const parts = [p.description, (p as { requirements?: string }).requirements, (p as { benefits?: string }).benefits]
      .map((x) => stripJdHtml(String(x ?? "")));
    return ok(parts.join("\n\n"));
  }
  if (kind === "oracle") {
    const it = oracleItem(p);
    if (!it) return null; // empty `items`: closed, or the wrong site
    return ok(joinSections([
      ["", it.ExternalDescriptionStr],
      ["Responsibilities", it.ExternalResponsibilitiesStr],
      ["Qualifications", it.ExternalQualificationsStr],
    ]));
  }
  if (kind === "eightfold") {
    return ok(stripJdHtml(str(p.job_description)));
  }
  if (kind === "apple") {
    const r = appleRes(p);
    return ok(joinSections([
      ["Summary", r.jobSummary],
      ["Description", r.description],
      ["Minimum Qualifications", r.minimumQualifications],
      ["Preferred Qualifications", r.preferredQualifications],
    ]));
  }
  return null;
}

// -- tier 2: embedded structured data (port of jd_source.py) ----------------

function walkDescriptions(obj: unknown, out: string[]): void {
  if (Array.isArray(obj)) {
    for (const item of obj) walkDescriptions(item, out);
  } else if (obj && typeof obj === "object") {
    for (const [key, val] of Object.entries(obj)) {
      if (key === "description" && typeof val === "string") out.push(val);
      else walkDescriptions(val, out);
    }
  }
}

/** The balanced `{...}` object literal starting at `start` (string-aware). */
function sliceJsonObject(s: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

/** Phenom career sites (careers.cisco.com and similar) server-render the
 * posting into `phApp.ddo = {...}`: jobDetail.data.job carries the JD html
 * plus title, companyName and location. */
export function phenomJob(html: string): { text: string | null; meta: JobMeta | null } | null {
  const at = html.search(/phApp\.ddo\s*=\s*\{/);
  if (at < 0) return null;
  const raw = sliceJsonObject(html, html.indexOf("{", at));
  if (!raw) return null;
  try {
    const job = JSON.parse(raw)?.jobDetail?.data?.job;
    if (!job || typeof job !== "object") return null;
    const meta: JobMeta = {};
    if (str(job.title)) meta.title = str(job.title);
    if (str(job.companyName)) meta.company = str(job.companyName);
    const loc = str(job.cityStateCountry) || str(job.location);
    if (loc) meta.location = loc;
    return { text: ok(stripJdHtml(str(job.description))), meta: Object.keys(meta).length ? meta : null };
  } catch {
    return null;
  }
}

export function embeddedDescription(html: string): string | null {
  const phenom = phenomJob(html);
  if (phenom?.text) return phenom.text;
  const pats = [
    /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/g,
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  ];
  for (const re of pats) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      try {
        const found: string[] = [];
        walkDescriptions(JSON.parse(m[1]), found);
        for (const desc of found) {
          const got = ok(stripJdHtml(desc));
          if (got) return got;
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

// -- orchestrator -----------------------------------------------------------

export type AcquireResult = {
  text: string | null;
  /** which tier produced it: "ats:<kind>" | "embedded" | "scrape" | null */
  source: string | null;
  /** raw page HTML when a page was fetched but no tier accepted it — the
   * caller's LLM last-resort tier extracts from this. */
  html: string | null;
  /** posting fields from an ATS payload or Phenom data, even when its JD
   * text missed (ingest uses them when the page itself is a JS shell). */
  meta?: JobMeta | null;
};

async function tryAts(
  ats: AtsApi,
  fetchText: (url: string) => Promise<string>,
): Promise<{ text: string | null; meta: JobMeta | null }> {
  try {
    const payload = JSON.parse(await fetchText(ats.api));
    let meta = metaFromAtsPayload(ats.kind, payload);
    if (ats.company && !meta?.company) meta = { ...meta, company: ats.company };
    return { text: jdFromAtsPayload(ats.kind, payload), meta };
  } catch {
    return { text: null, meta: null };
  }
}

/**
 * Full acquisition chain for one URL. `fetchText` is injected so callers
 * control timeouts/limits and tests stay offline. Never throws.
 */
export async function acquireJdFromUrl(
  url: string,
  fetchText: (url: string) => Promise<string>,
): Promise<AcquireResult> {
  if (!url) return { text: null, source: null, html: null };

  let meta: JobMeta | null = null;
  const ats = atsApiUrl(url);
  if (ats) {
    const got = await tryAts(ats, fetchText);
    meta = got.meta;
    if (got.text) return { text: got.text, source: `ats:${ats.kind.split(":")[0]}`, html: null, meta };
    // fall through to the page itself
  }

  let html = "";
  try {
    html = await fetchText(pageFetchUrl(url));
  } catch {
    return { text: null, source: null, html: null, meta };
  }
  // Oracle CX on a custom domain: the page names its pod, whose REST feed
  // carries the JD the JS shell never renders server-side.
  const hinted = ats ? null : oracleApiFromPage(url, html);
  if (hinted) {
    const got = await tryAts(hinted, fetchText);
    meta = got.meta ?? meta;
    if (got.text) return { text: got.text, source: "ats:oracle", html, meta };
  }
  meta = meta ?? phenomJob(html)?.meta ?? null;
  // A page fetched via redirect may land on a supported ATS host even when
  // the original URL didn't look like one — no cheap way to see the final
  // URL through the injected fetch, so embedded data is the next tier.
  const embedded = embeddedDescription(html);
  if (embedded) return { text: embedded, source: "embedded", html, meta };

  const body = ok(stripJdHtml(html));
  if (body && looksLikeJd(body)) return { text: body, source: "scrape", html, meta };
  return { text: null, source: null, html, meta };
}

// -- last-resort tier: LLM extraction (callers with model plumbing) ---------

import { callModel, OPERATOR_MODEL, OPERATOR_PROVIDER } from "./llm_providers";

const LLM_EXTRACT_SYSTEM =
  "You extract job descriptions from raw webpage text. Reply with the " +
  "complete job description verbatim - responsibilities, qualifications, " +
  "preferred skills, everything - as plain text. No commentary, no " +
  "summarizing, no rewording. If the text contains no job description, " +
  "reply with exactly NONE.";

/**
 * Last-resort JD extraction from a fetched page via the operator Gemini key.
 * Used only when every deterministic tier missed but a page WAS fetched.
 * Returns null when the key is absent, the model says NONE, or the result
 * fails the same plausibility gates as scraped text. Never throws.
 */
export async function llmExtractJd(html: string): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !html) return null;
  const pageText = stripJdHtml(html).slice(0, 28_000);
  if (pageText.length < JD_MIN_CHARS) return null;
  try {
    const out = await callModel(OPERATOR_PROVIDER, {
      model: OPERATOR_MODEL,
      system: LLM_EXTRACT_SYSTEM,
      user: pageText,
      apiKey,
    });
    const trimmed = out.trim();
    if (trimmed === "NONE") return null;
    const got = trimmed.replace(/[ \t]+/g, " ").trim().slice(0, JD_MAX_CHARS);
    return got.length >= JD_MIN_CHARS && looksLikeJd(got) ? got : null;
  } catch {
    return null;
  }
}
