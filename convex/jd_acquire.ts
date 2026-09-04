// Shared JD acquisition: turn a job URL into the full job-description text.
//
// Tier order (first hit wins), mirroring src/resume/jd_source.py — keep the
// two in lockstep when adding an ATS or changing thresholds:
//   1. ATS public JSON APIs (greenhouse / lever / ashby / smartrecruiters /
//      workday CXS / workable) resolved from the URL shape — full-fidelity
//      JD straight from the source, no scraping.
//   2. Embedded structured data on the fetched page (__NEXT_DATA__ / JSON-LD
//      "description"), which carries the JD without nav/footer chrome.
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

export function stripJdHtml(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(br|\/p|\/li|\/div|\/h[1-6]|\/ul|\/ol|\/tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
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

export type AtsApi = { kind: string; api: string };

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
  return null;
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

export function embeddedDescription(html: string): string | null {
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
};

/**
 * Full acquisition chain for one URL. `fetchText` is injected so callers
 * control timeouts/limits and tests stay offline. Never throws.
 */
export async function acquireJdFromUrl(
  url: string,
  fetchText: (url: string) => Promise<string>,
): Promise<AcquireResult> {
  if (!url) return { text: null, source: null, html: null };

  const ats = atsApiUrl(url);
  if (ats) {
    try {
      const body = await fetchText(ats.api);
      const text = jdFromAtsPayload(ats.kind, JSON.parse(body));
      if (text) return { text, source: `ats:${ats.kind.split(":")[0]}`, html: null };
    } catch {
      // fall through to the page itself
    }
  }

  let html = "";
  try {
    html = await fetchText(url);
  } catch {
    return { text: null, source: null, html: null };
  }
  // A page fetched via redirect may land on a supported ATS host even when
  // the original URL didn't look like one — no cheap way to see the final
  // URL through the injected fetch, so embedded data is the next tier.
  const embedded = embeddedDescription(html);
  if (embedded) return { text: embedded, source: "embedded", html };

  const body = ok(stripJdHtml(html));
  if (body && looksLikeJd(body)) return { text: body, source: "scrape", html };
  return { text: null, source: null, html };
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
