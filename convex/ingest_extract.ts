// Pure, dependency-free helpers for manual ingest URL handling and HTML extraction.
//
// No Convex imports, no "use node" - so both the isolate (ingest.ts) and the
// Node action (ingest_node.ts) can import these without runtime issues.
const TRACKING_KEYS = new Set([
  "jr_id",
  "utm",
  "ref",
  "source",
  "src",
  "lang",
  "mode",
  "iis",
  "s",
  "gh_src",
  "lever-source",
  "gh_jid_src",
]);

/**
 * Canonicalize a URL for dedup: lower host+sheme, strip www., drop fragment,
 * strip utm_* and gh_* tracking params except gh_jid, remove trailing slash, sort
 * remaining query params.
 */
export function canonicalUrl(raw: string): string {
  const trimmed = raw.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    // Try with https prefix if no scheme
    try {
      u = new URL("https://" + trimmed);
    } catch {
      return trimmed.toLowerCase();
    }
  }
  // scheme lower
  const scheme = u.protocol.toLowerCase().replace(/:$/, "");
  let host = u.hostname.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);
  // port: keep if non-default? For dedup drop default ports
  // Simplify: drop port if 80/443 matching scheme
  let portPart = "";
  if (u.port) {
    if (!((scheme === "https" && u.port === "443") || (scheme === "http" && u.port === "80"))) {
      portPart = ":" + u.port;
    }
  }
  let path = u.pathname;
  // strip trailing slash (unless path is just "/")
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  // decode? keep as is but lower? Keep case for path
  // Build filtered query
  const params: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) {
    const kl = k.toLowerCase();
    if (kl.startsWith("utm_")) continue;
    if (kl.startsWith("gh_") && kl !== "gh_jid") continue;
    if (TRACKING_KEYS.has(kl)) continue;
    params.push([k, v]);
  }
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const query = params.length ? "?" + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") : "";
  // Reconstruct without fragment
  return `${scheme}://${host}${portPart}${path}${query}`;
}

const GH_HOSTS = new Set([
  "boards.greenhouse.io", "job-boards.greenhouse.io",
  "boards.eu.greenhouse.io", "job-boards.eu.greenhouse.io",
]);
const GH_API_HOSTS = new Set(["boards-api.greenhouse.io", "boards-api.eu.greenhouse.io"]);
const LEVER_HOSTS = new Set(["jobs.lever.co", "jobs.eu.lever.co"]);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Same cross-source identities as src/normalize.py; never use these tokens
 * as fetch URLs or replace an existing row's key with one. */
export function postingIdentity(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (!["http:", "https:"].includes(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "jobright.ai" || host.endsWith(".jobright.ai")) return null;
  const path = u.pathname.replace(/^\/[a-z]{2}[-_][a-z]{2}(?=\/)/i, "").replace(/\/+$/, "");
  const params = [...u.searchParams.entries()];
  if (GH_HOSTS.has(host) || GH_API_HOSTS.has(host)) {
    const id = path.match(/\/jobs\/(\d+)/)?.[1];
    if (id) return `ats:gh:${id}`;
    if (GH_HOSTS.has(host) && path === "/embed/job_app") {
      const token = params.find(([k, v]) => k.toLowerCase() === "token" && /^\d+$/.test(v));
      if (token) return `ats:gh:${token[1]}`;
    }
  }
  const gh = params.find(([k, v]) => k.toLowerCase() === "gh_jid" && /^\d+$/.test(v));
  if (gh) return `ats:gh:${gh[1]}`;
  const custom = path.match(/\/jobs\/(\d{7,})-[\w-]+\/?$/)?.[1];
  if (custom) return `ats:gh:${custom}`;
  if (LEVER_HOSTS.has(host)) {
    const match = path.match(/^\/([^/]+)\/([^/]+)/);
    if (match && UUID.test(match[2])) return `ats:lever:${match[1].toLowerCase()}:${match[2].toLowerCase()}`;
  }
  if (host === "jobs.ashbyhq.com") {
    const id = path.match(UUID)?.[0];
    if (id) return `ats:ashby:${id.toLowerCase()}`;
  }
  if (host.endsWith(".myworkdayjobs.com")) {
    const id = path.split("/").at(-1)?.match(/_(R[-\w]*\d{3,}|JR[-\w]*\d{3,})/i)?.[1];
    if (id) return `ats:wd:${host.split(".")[0]}:${id.toUpperCase()}`;
  }
  if (host === "apply.workable.com") {
    const match = path.match(/^\/([^/]+)\/j\/([^/]+)/);
    if (match) return `ats:workable:${match[1].toLowerCase()}:${match[2].toUpperCase()}`;
  }
  if (host === "amazon.jobs") {
    const id = path.match(/^(?:\/[a-z]{2})?\/jobs\/(\d+)(?:\/.*)?$/i)?.[1];
    if (id) return `ats:amazon:${id}`;
  }
  const ashby = params.find(([k, v]) => k.toLowerCase() === "ashby_jid" && UUID.test(v));
  if (ashby) return `ats:ashby:${ashby[1].match(UUID)![0].toLowerCase()}`;
  const segments = new Set(path.toLowerCase().split("/"));
  const kept = params.filter(([k, v]) => !k.toLowerCase().startsWith("utm_")
    && !TRACKING_KEYS.has(k.toLowerCase()) && !segments.has(v.toLowerCase()));
  kept.sort(([ak, av], [bk, bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0);
  const query = new URLSearchParams(kept).toString();
  return `https://${host}${u.port ? `:${u.port}` : ""}${path}${query ? `?${query}` : ""}`;
}

export function applyUrlRank(raw: string): number {
  if (!postingIdentity(raw)) return 0;
  const u = new URL(raw);
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.replace(/\/+$/, "");
  if (GH_API_HOSTS.has(host)) return 0;
  if (GH_HOSTS.has(host) || LEVER_HOSTS.has(host) || host === "jobs.ashbyhq.com"
      || host === "apply.workable.com" || host.endsWith(".myworkdayjobs.com")) {
    return path === "/embed/job_app" || /\/(apply|application)$/.test(path) ? 3 : 2;
  }
  return 1;
}

export function preferredApplyUrl(current: string, candidate: string): string {
  return applyUrlRank(candidate) > applyUrlRank(current) ? candidate : current;
}

/**
 * Validate a URL string. Throws with a descriptive message if invalid.
 * Blocks: localhost, private IPs, file://, no-dot hosts.
 */
export function validateUrl(raw: string): void {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("empty url");
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error("invalid url");
  }
  const scheme = u.protocol.toLowerCase();
  if (scheme === "file:") throw new Error("file urls not allowed");
  if (scheme !== "http:" && scheme !== "https:") throw new Error("only http/https urls allowed");
  const host = u.hostname.toLowerCase();
  if (!host) throw new Error("missing host");
  if (host === "localhost" || host.endsWith(".localhost")) throw new Error("localhost not allowed");
  if (!host.includes(".")) {
    // also allow punycode? but require dot
    throw new Error("host must contain a dot");
  }
  // Private IP checks
  if (/^127\./.test(host) || host === "0.0.0.0" || host === "::1" || host === "[::1]") {
    throw new Error("private address not allowed");
  }
  // 10.x.x.x
  if (/^10\./.test(host)) throw new Error("private address not allowed");
  // 192.168.x.x
  if (/^192\.168\./.test(host)) throw new Error("private address not allowed");
  // 172.16-31.x.x
  const m172 = host.match(/^172\.(\d+)\./);
  if (m172) {
    const second = parseInt(m172[1], 10);
    if (second >= 16 && second <= 31) throw new Error("private address not allowed");
  }
  // 169.254.x.x link-local
  if (/^169\.254\./.test(host)) throw new Error("private address not allowed");
  // fe80:: link-local (ipv6)
  if (host.startsWith("fe80:")) throw new Error("private address not allowed");
  // fc00::/7 unique local
  if (host.startsWith("fc") || host.startsWith("fd")) {
    // crude: any fc/fd prefix ipv6
    if (/^[0-9a-f]*:/i.test(host) && (host.startsWith("fc") || host.startsWith("fd"))) {
      // Only block if it looks like ipv6 containing colon
      if (host.includes(":")) throw new Error("private address not allowed");
    }
  }
  if (isListingUrl(u)) {
    throw new Error(
      "this looks like a job search or listing page, not a single posting - open the job and paste its own URL",
    );
  }
}

// Last path segments that are a search/results page on every board seen
// (careers.ibm.com/.../search, Avature SearchJobs, Phenom search-results).
const LISTING_SEGMENTS = new Set([
  "search", "searchjobs", "search-jobs", "search-results", "jobsearch", "job-search",
  "results", "jobs", "careers", "openings", "positions", "job-openings",
]);
// Search-box parameters. A URL carrying one is a results page unless it
// also names a posting (an id-looking path segment or an id parameter).
const SEARCH_PARAMS = ["q", "query", "keyword", "keywords", "search", "searchtext"];
const ID_PARAMS = /^(?:jobid|job_id|gh_jid|pid|id|reqid|req_id|jobreqid|requisitionid|ashby_jid|lever-via)$/i;

/** A search/listing URL rather than one posting (#4 in the scrape issues:
 * an IBM row saved with a search URL could never become a real match). */
export function isListingUrl(u: URL): boolean {
  const segs = u.pathname.split("/").filter(Boolean);
  const keys = [...u.searchParams.keys()];
  if (keys.some((k) => ID_PARAMS.test(k))) return false;
  // Any segment carrying a 4+ digit run or a UUID is a posting id.
  if (segs.some((seg) => /\d{4,}|[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg))) return false;
  const last = (segs.at(-1) ?? "").toLowerCase();
  if (LISTING_SEGMENTS.has(last)) return true;
  return keys.some((k) => SEARCH_PARAMS.includes(k.toLowerCase()));
}

/**
 * Detect ATS by hostname.
 */
export function detectAts(host: string): string | null {
  const h = host.toLowerCase().replace(/^www\./, "");
  if (h.includes("greenhouse.io") || h.includes("boards.greenhouse.io") || h.includes("job-boards.greenhouse.io")) return "greenhouse";
  if (h.includes("lever.co") || h.includes("jobs.lever.co")) return "lever";
  if (h.includes("ashbyhq.com") || h.includes("jobs.ashbyhq.com")) return "ashby";
  if (h.includes("myworkdayjobs.com") || h.includes("myworkday.com")) return "workday";
  if (h.includes("smartrecruiters.com")) return "smartrecruiters";
  if (h.includes("workable.com")) return "workable";
  if (h.includes("amazon.jobs")) return "amazon";
  return null;
}

// -- HTML extraction helpers (cheerio-free regex) --------------------------

function extractLdJson(html: string): any | null {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      // Also handle @graph
      const flat: any[] = [];
      for (const c of candidates) {
        if (c["@graph"] && Array.isArray(c["@graph"])) flat.push(...c["@graph"]);
        else flat.push(c);
      }
      for (const c of flat) {
        const t = c["@type"];
        const typeStr = Array.isArray(t) ? t.join(",") : (t || "");
        if (typeStr.toLowerCase().includes("jobposting")) return c;
      }
      // If no JobPosting found but single object, return it as fallback
      if (candidates.length === 1 && candidates[0]["title"]) return candidates[0];
    } catch {
      // try to handle html entities? skip
      continue;
    }
  }
  return null;
}

function metaContent(html: string, attr: string, value: string): string | null {
  // attr is "property" or "name"
  const re = new RegExp(`<meta[^>]*${attr}=["']${value}["'][^>]*>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const cm = /content=["']([^"']*)["']/i.exec(tag);
    if (cm) return cm[1];
  }
  return null;
}

function tagText(html: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = re.exec(html);
  if (!m) return null;
  // strip inner tags
  return m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export interface ExtractedJob {
  company: string;
  title: string;
  location: string;
}

export function extractGeneric(html: string, url: string): ExtractedJob {
  // Try ld+json first
  const ld = extractLdJson(html);
  if (ld) {
    const title = typeof ld.title === "string" ? ld.title.trim() : "";
    let company = "";
    const org = ld.hiringOrganization;
    if (typeof org === "string") company = org.trim();
    else if (org && typeof org.name === "string") company = org.name.trim();
    else if (typeof ld.hiringOrganization === "object" && ld.hiringOrganization !== null) {
      company = (ld.hiringOrganization.name || "").trim();
    }
    let location = "";
    const loc = ld.jobLocation;
    const locObj = Array.isArray(loc) ? loc[0] : loc;
    if (locObj) {
      if (typeof locObj.address === "string") location = locObj.address.trim();
      else if (locObj.address && typeof locObj.address.addressLocality === "string") {
        const addr = locObj.address;
        const parts = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean);
        location = parts.join(", ");
      } else if (typeof locObj.name === "string") location = locObj.name.trim();
    }
    if (title || company) {
      return {
        company:
          decodeEntities(company) || companyFromUrl(url) || hostFallback(url),
        title: decodeEntities(title) || titleFallback(html),
        location: decodeEntities(location),
      };
    }
  }

  const ogTitle = metaContent(html, "property", "og:title");
  const h1 = tagText(html, "h1");
  const titleTag = tagText(html, "title");

  let title = (ogTitle || h1 || titleTag || "").trim();
  // title often is "Role at Company" - keep raw as title, but try to split for company fallback
  title = decodeEntities(title);
  // If title contains " - " or " | " or " at ", keep full; extraction of company from title is optional
  // Normalize title: if it contains company separator, we keep whole string as title for now

  const siteName = metaContent(html, "property", "og:site_name") || "";
  let company = decodeEntities(siteName).trim();
  // Check the " at <employer>" phrase across every title-ish string, not just
  // the one chosen as the job title: boards commonly put the role in the <h1>
  // and "<role> at <employer>" in the <title>, so keying off the chosen title
  // alone misses the employer entirely.
  if (!company) {
    for (const candidate of [titleTag, ogTitle, h1]) {
      if (!candidate) continue;
      const found = companyFromAtPhrase(decodeEntities(candidate));
      if (found) {
        company = found;
        break;
      }
    }
  }
  if (!company) company = companyFromUrl(url);
  if (!company) company = hostFallback(url);

  // Location: try meta or location-ish text
  let location = "";
  // generic location meta?
  // Look for og:description etc? Keep empty if not found

  return {
    company: company || "Unknown",
    title: title || titleFallback(html) || "Unknown",
    location,
  };
}

/**
 * The employer name carried in an ATS URL. More reliable than the hostname on
 * shared boards: job-boards.greenhouse.io yields "Job-boards" from the host but
 * names the employer in `?for=`, and Ashby/Lever put it in the first path
 * segment.
 */
export function companyFromUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "";
  }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const seg = u.pathname.split("/").filter(Boolean);
  const pretty = (s: string) =>
    s
      .replace(/[-_]+/g, " ")
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  if (host.includes("greenhouse.io")) {
    const forParam = u.searchParams.get("for");
    if (forParam) return pretty(forParam);
    const first = seg.find((s) => s !== "embed" && s !== "job_app");
    if (first) return pretty(first);
  }
  if (host.includes("ashbyhq.com") || host.includes("lever.co")) {
    if (seg.length) return pretty(seg[0]);
  }
  return "";
}

/**
 * "Job Application for Maps Intern (Fall 2026) at Zipline" -> "Zipline".
 * Job boards put the employer after the last " at " in the page title far more
 * often than they expose og:site_name.
 */
function companyFromAtPhrase(text: string): string {
  const atIdx = text.toLowerCase().lastIndexOf(" at ");
  if (atIdx === -1) return "";
  const maybe = text
    .slice(atIdx + 4)
    .trim()
    .split(/[|–—\n]/)[0]
    .trim();
  return maybe.length >= 2 && maybe.length <= 60 ? maybe : "";
}

// -- term inference -------------------------------------------------------
//
// Mirror of src/normalize.py infer_term, rule for rule; both suites run the
// vectors in shared/term-inference-cases.json, so change the two together.
// The tiers (first hit wins):
//   1. explicit: a season next to a year, in the title, then the URL, then
//      the JD body.
//   2. inferred: title month+year / season with no year / bare year; then JD
//      month range with a year, month+year in a clause about starting, or a
//      season next to an internship noun (year from the anchor date).
//   3. unknown.
// JD clauses about graduation, returning to school or deadlines are skipped;
// a JD's explicit term starting more than 90 days before the anchor is a past
// cohort; a JD year must be four digits or apostrophe'd; lowercase "may" is a
// verb.

/** How a term was found. Stored rows may also carry "manual" (match_overrides.ts). */
export type TermConfidence = "explicit" | "inferred" | "unknown";
export type TermInference = {
  /** Chronological. */
  terms: string[];
  /** The single stored term: the earliest, or "" when unknown. */
  term: string;
  confidence: TermConfidence;
  source: "title" | "url" | "jd" | null;
};

const SEASON_NAMES: Record<string, string> = {
  summer: "Summer", fall: "Fall", autumn: "Fall", spring: "Spring", winter: "Winter",
};
const SEASON_ALT = "summer|fall|autumn|spring|winter";
const YY = "2[4-9]";
const MONTH_NUM: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_ALT =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
const SEASON_LIST = `(?:${SEASON_ALT})(?:\\s*/\\s*(?:${SEASON_ALT}))*`;
const EXPLICIT_RE = new RegExp(`(?<![a-z])(${SEASON_LIST})[\\s_-]*(?:of\\s+)?[‘’']?\\s*(?:20)?(${YY})(?!\\d)`, "gi");
// JD prose is noisier than a title ("prices fall 27%"): four-digit or apostrophe'd year only.
const JD_EXPLICIT_RE = new RegExp(`(?<![a-z])(${SEASON_LIST})[\\s_-]*(?:of\\s+)?(?:20|[‘’']\\s*)(${YY})(?!\\d)`, "gi");
const EXPLICIT_REV_RE = new RegExp(`(?<!\\d)20(${YY})[\\s_-]+(${SEASON_ALT})(?![a-z])`, "gi");
const MONTH_YEAR_RE = new RegExp(`\\b(${MONTH_ALT})\\.?\\s*[‘’']?\\s*(?:20)?(${YY})\\b`, "gi");
const SEASON_ONLY_RE = new RegExp(`\\b(${SEASON_ALT})\\b`, "i");
const BARE_YEAR_RE = new RegExp(`\\b20(${YY})\\b`);
const JD_YEAR = `(?:20|[‘’'])(${YY})`;
const DAY = "(?:\\s+\\d{1,2}(?:st|nd|rd|th)?)?";
const JD_RANGE_RE = new RegExp(
  `\\b(${MONTH_ALT})\\b\\.?${DAY},?(?:\\s*${JD_YEAR})?\\s*(?:-|–|—|to|through|thru|until)\\s*(${MONTH_ALT})\\b\\.?${DAY},?\\s*${JD_YEAR}\\b`,
  "i",
);
const JD_MONTH_YEAR_RE = new RegExp(`\\b(${MONTH_ALT})\\b\\.?${DAY},?\\s*${JD_YEAR}\\b`, "i");
const JD_START_RE = /\b(?:start|starts|starting|begin|begins|beginning|commence|commences|commencing|start date)\b/i;
const JD_SEASON_NOUN_RE = new RegExp(
  `\\b(${SEASON_ALT})\\s+(?:intern(?:ship)?s?|co-?ops?|semester|term|session|program(?:me)?|cohort|placement)\\b`,
  "i",
);
const JD_SKIP_RE =
  /graduat|class of|commencement|diploma|returning to|return to (?:school|campus|university|college)|deadline|apply by|applications? (?:close|due|open)|date posted|posted on|last updated|on track to|(?:complet|finish)\w*\s+(?:\S+\s+){0,3}?(?:bachelor|master|ph\.?d|doctora|undergrad|degree)/i;
const CLAUSE_SPLIT_RE = /(?<=[.!?;])\s+(?=[A-Z])|[\r\n•·]+/;
const PAST_COHORT_DAYS = 90;
const SEASON_START: Record<string, [number, number]> = {
  Spring: [1, 10], Summer: [5, 20], Fall: [8, 20], Winter: [12, 1],
};
const SEASON_START_MONTH: Record<string, number> = { Spring: 1, Summer: 5, Fall: 8, Winter: 12 };
const RANGE_BLOCK = ["Spring", "Spring", "Spring", "Spring", "Summer", "Summer", "Summer", "Summer", "Fall", "Fall", "Fall", "Fall"];

/** Start date of "Summer 2027" as a UTC timestamp; null when not a term. */
function termStartMs(term: string): number | null {
  const m = /^(Spring|Summer|Fall|Winter) (\d{4})$/.exec(term);
  if (!m) return null;
  const [month, day] = SEASON_START[m[1]];
  return Date.UTC(Number(m[2]), month - 1, day);
}

function orderedTerms(terms: string[]): string[] {
  return [...new Set(terms)].sort((a, b) => (termStartMs(a) ?? Infinity) - (termStartMs(b) ?? Infinity));
}

function monthNum(name: string): number {
  return MONTH_NUM[name.toLowerCase().slice(0, 3)];
}

function monthToSeason(month: number): string {
  if (month <= 3) return "Spring";
  if (month <= 7) return "Summer";
  if (month <= 11) return "Fall";
  return "Winter";
}

/** Year of the next start of `season` on/after the anchor (UTC calendar). */
function nextOccurrence(season: string, anchor: Date): number {
  const month = anchor.getUTCMonth() + 1;
  return month <= SEASON_START_MONTH[season] ? anchor.getUTCFullYear() : anchor.getUTCFullYear() + 1;
}

function explicitTerms(text: string, pattern: RegExp = EXPLICIT_RE): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(pattern)) {
    for (const season of m[1].split("/")) out.push(`${SEASON_NAMES[season.trim().toLowerCase()]} 20${m[2]}`);
  }
  for (const m of text.matchAll(EXPLICIT_REV_RE)) out.push(`${SEASON_NAMES[m[2].toLowerCase()]} 20${m[1]}`);
  return out;
}

function titleInferred(title: string, anchor: Date): string[] {
  const found = [...title.matchAll(MONTH_YEAR_RE)].map((m) => `${monthToSeason(monthNum(m[1]))} 20${m[2]}`);
  if (found.length) return found;
  const season = SEASON_ONLY_RE.exec(title);
  if (season) {
    const name = SEASON_NAMES[season[1].toLowerCase()];
    return [`${name} ${nextOccurrence(name, anchor)}`];
  }
  const year = BARE_YEAR_RE.exec(title);
  return year ? [`Summer 20${year[1]}`] : [];
}

/** Start month's season plus every Jan-Apr / May-Aug / Sep-Dec block covered 2+ months. */
function rangeSeasons(m1: number, y1: number, m2: number, y2: number): string[] {
  const out = [`${monthToSeason(m1)} ${y1}`];
  const counts = new Map<string, number>();
  let month = m1;
  let year = y1;
  for (let i = 0; i < 24; i++) {
    const key = `${RANGE_BLOCK[month - 1]} ${year}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (year > y2 || (year === y2 && month >= m2)) break;
    if (month === 12) { month = 1; year += 1; } else { month += 1; }
  }
  for (const [key, n] of counts) if (n >= 2) out.push(key);
  return out;
}

function jdClauses(jd: string): string[] {
  return jd.split(CLAUSE_SPLIT_RE).filter((c) => c.trim() && !JD_SKIP_RE.test(c));
}

function jdExplicit(clauses: string[], anchor: Date): string[] {
  const cutoff = anchor.getTime() - PAST_COHORT_DAYS * 86_400_000;
  return clauses.flatMap((c) => explicitTerms(c, JD_EXPLICIT_RE)).filter((t) => (termStartMs(t) ?? Infinity) >= cutoff);
}

function jdInferred(clauses: string[], anchor: Date): string[] {
  for (const c of clauses) {
    const r = JD_RANGE_RE.exec(c);
    if (!r || r[1] === "may") continue; // lowercase "may" is the verb
    const m1 = monthNum(r[1]);
    const m2 = monthNum(r[3]);
    const y2 = 2000 + Number(r[4]);
    const y1 = r[2] ? 2000 + Number(r[2]) : m1 <= m2 ? y2 : y2 - 1;
    if (y1 < y2 || (y1 === y2 && m1 <= m2)) return rangeSeasons(m1, y1, m2, y2);
  }
  for (const c of clauses) {
    if (!JD_START_RE.test(c)) continue;
    const m = JD_MONTH_YEAR_RE.exec(c);
    if (m && m[1] !== "may") return [`${monthToSeason(monthNum(m[1]))} 20${m[2]}`];
  }
  for (const c of clauses) {
    const m = JD_SEASON_NOUN_RE.exec(c);
    if (m) {
      const name = SEASON_NAMES[m[1].toLowerCase()];
      return [`${name} ${nextOccurrence(name, anchor)}`];
    }
  }
  return [];
}

/**
 * The term(s) of a posting from its title, URL and JD body. `today` anchors
 * the yearless rules and the past-cohort cutoff: the ingest date for a new
 * row, the row's `added` date in the backfill.
 */
export function inferTermDetailed(input: {
  title?: string | null;
  url?: string | null;
  jd?: string | null;
  today?: Date | string;
}): TermInference {
  const anchor = input.today instanceof Date ? input.today
    : input.today ? new Date(`${input.today.slice(0, 10)}T00:00:00Z`) : new Date();
  const title = input.title ?? "";
  const clauses = input.jd ? jdClauses(input.jd) : [];
  const done = (terms: string[], confidence: TermConfidence, source: TermInference["source"]): TermInference => {
    const ordered = orderedTerms(terms);
    return { terms: ordered, term: ordered[0] ?? "", confidence, source };
  };
  const explicit: [TermInference["source"], string[]][] = [
    ["title", explicitTerms(title)],
    ["url", explicitTerms(input.url ?? "")],
    ["jd", jdExplicit(clauses, anchor)],
  ];
  for (const [source, found] of explicit) if (found.length) return done(found, "explicit", source);
  const inferred: [TermInference["source"], string[]][] = [
    ["title", titleInferred(title, anchor)],
    ["jd", jdInferred(clauses, anchor)],
  ];
  for (const [source, found] of inferred) if (found.length) return done(found, "inferred", source);
  return { terms: [], term: "", confidence: "unknown", source: null };
}

/** The single "Fall 2026"-style term a match row stores, or "". */
export function inferTerm(title?: string, url?: string, jd?: string | null, today?: Date | string): string {
  return inferTermDetailed({ title, url, jd, today }).term;
}

function hostFallback(url: string): string {
  try {
    const u = new URL(url);
    let h = u.hostname.replace(/^www\./, "");
    // Turn host into company-ish: take first label capitalized
    const first = h.split(".")[0];
    return first.charAt(0).toUpperCase() + first.slice(1);
  } catch {
    return "Unknown";
  }
}

function titleFallback(html: string): string {
  const t = tagText(html, "title") || tagText(html, "h1") || "";
  if (t) return t.split(/[|\-–—]/)[0].trim();
  return "";
}

// Stubs for ATS-specific extractors (fallback to generic for now)
export function extractGreenhouse(html: string, url: string): ExtractedJob {
  return extractGeneric(html, url);
}
export function extractLever(html: string, url: string): ExtractedJob {
  return extractGeneric(html, url);
}
export function extractAshby(html: string, url: string): ExtractedJob {
  return extractGeneric(html, url);
}
export function extractWorkday(html: string, url: string): ExtractedJob {
  return extractGeneric(html, url);
}

export function extractForAts(html: string, url: string, ats: string | null): ExtractedJob {
  switch (ats) {
    case "greenhouse":
      return extractGreenhouse(html, url);
    case "lever":
      return extractLever(html, url);
    case "ashby":
      return extractAshby(html, url);
    case "workday":
      return extractWorkday(html, url);
    default:
      return extractGeneric(html, url);
  }
}
