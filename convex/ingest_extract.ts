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
 * strip utm_* and gh_* and known tracking params, remove trailing slash, sort
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
    if (kl.startsWith("gh_")) continue;
    if (TRACKING_KEYS.has(kl)) continue;
    params.push([k, v]);
  }
  params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const query = params.length ? "?" + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") : "";
  // Reconstruct without fragment
  return `${scheme}://${host}${portPart}${path}${query}`;
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

/**
 * Pull a "Fall 2026"-style term out of whichever text carries it. Manual adds
 * otherwise land under "Unknown term" even when the title spells the term out.
 */
export function inferTerm(...texts: (string | undefined)[]): string {
  const re = /\b(fall|spring|summer|winter)\s*'?\s*(20\d{2})\b/i;
  for (const t of texts) {
    if (!t) continue;
    const m = re.exec(t);
    if (m) {
      const season = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
      return `${season} ${m[2]}`;
    }
  }
  return "";
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
