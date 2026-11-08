"use node";

import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { canonicalUrl, companyFromUrl, detectAts, extractForAts, inferTerm } from "./ingest_extract";
import { manualArgs } from "./ingest";
import {
  acquireJdFromUrl, atsApiUrl, llmExtractJd, oracleApiFromPage, pageFetchUrl, type AcquireResult,
} from "./jd_acquire";

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_BYTES = 200 * 1024; // 200KB cap
const ERROR_TRUNC = 300;
const RETRY_DELAY_MS = 750;

// A Mozilla-compatible crawler identity: browser-shaped enough for sites
// that drop anything not starting with "Mozilla/", honest about what it is.
// Measured (2026-11): every board answered it the same as a spoofed desktop
// Chrome UA, except iCIMS, whose AWS WAF serves a captcha (HTTP 405) to a
// Chrome UA that cannot run JS and the posting to this one. A real JS
// challenge (careers.ibm.com answers every UA with an empty 202) is reported
// as `blocked`, never worked around.
export const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (compatible; intern-baddie/1.0)",
  Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function truncateError(msg: string): string {
  return msg.length > ERROR_TRUNC ? msg.slice(0, ERROR_TRUNC - 3) + "..." : msg;
}

/** A failed fetch, classified so the API can say what the caller can do:
 * `blocked` (bot wall / JS-only page - paste the JD), `fetch_failed`
 * (HTTP error, closed posting, network). */
export class FetchError extends Error {
  constructor(public code: "blocked" | "fetch_failed", message: string, public retryable = false) {
    super(message);
  }
}

async function fetchOnce(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let resp: Response;
    try {
      resp = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow", signal: controller.signal });
    } catch (e) {
      throw new FetchError("fetch_failed", `fetch failed: ${e instanceof Error ? e.message : String(e)}`, true);
    }
    // Avature answers automated requests with HTTP 202 (an AWS WAF
    // challenge, sometimes with a small body); a 202 is never the posting.
    if (resp.status === 202) {
      throw new FetchError(
        "blocked",
        `empty response (HTTP 202) - this page likely renders with JavaScript or blocks automated fetches`,
        true,
      );
    }
    const waf = resp.headers.get("x-amzn-waf-action");
    if (waf) {
      throw new FetchError(
        "blocked",
        `blocked by a bot check (HTTP ${resp.status}, ${waf}) - this site does not serve automated fetches`,
      );
    }
    if (!resp.ok) {
      const closed = resp.status === 404 || resp.status === 410;
      throw new FetchError(
        "fetch_failed",
        `fetch failed: HTTP ${resp.status}${closed ? " - the posting may be closed" : ""}`,
        resp.status === 429 || resp.status >= 500,
      );
    }
    const text = await resp.text();
    // A 2xx with nothing in it is not a success either: it left the
    // extractor parsing an empty string - producing a match row with a
    // hostname for a company and a placeholder title.
    if (!text.trim()) {
      throw new FetchError(
        "blocked",
        `empty response (HTTP ${resp.status}) - this page likely renders with JavaScript or blocks automated fetches`,
        true,
      );
    }
    if (text.length > FETCH_MAX_BYTES) return text.slice(0, FETCH_MAX_BYTES);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

/** fetchOnce plus a single retry after a short backoff for transient
 * failures (network, 429, 5xx, an empty 202). Sequential, so a site sees at
 * most two requests per URL. */
export async function fetchWithLimits(url: string): Promise<string> {
  try {
    return await fetchOnce(url);
  } catch (e) {
    if (!(e instanceof FetchError) || !e.retryable) throw e;
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return await fetchOnce(url);
  }
}

/** One fetch per URL per ingest: the page, ATS API and JD tiers share it. */
function cachedFetcher(): (url: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>();
  return (url) => {
    let hit = cache.get(url);
    if (!hit) {
      hit = fetchWithLimits(url);
      cache.set(url, hit);
    }
    return hit;
  };
}

function pageTitleTag(html: string): string {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

export type ManualFields = { jdText?: string; title?: string; company?: string; location?: string };

export type ResolvedJob = {
  company: string;
  title: string;
  location: string;
  jobDescription: string | null;
  jdIsManual: boolean;
};

/**
 * Everything an ingest learns about a URL, without touching the database:
 * the page (when it can be fetched), the ATS API metadata and JD, and any
 * caller-supplied fields, merged in that order of trust - caller > ATS
 * payload > page scrape. Throws FetchError / Error when no title can be
 * found anywhere, so a placeholder row is never created.
 */
export async function resolveIngest(
  canonical: string,
  manual: ManualFields,
  fetchText: (url: string) => Promise<string> = cachedFetcher(),
): Promise<ResolvedJob> {
  let pageHtml = "";
  let pageError: unknown = null;
  try {
    pageHtml = await fetchText(pageFetchUrl(canonical));
  } catch (e) {
    pageError = e;
  }

  let host = "";
  try { host = new URL(canonical).hostname; } catch { host = ""; }
  const extracted = pageHtml ? extractForAts(pageHtml, canonical, detectAts(host)) : null;

  // Full-JD acquisition (ATS APIs -> embedded -> body -> LLM last resort),
  // skipped when the caller pasted the JD. The page was already fetched, so
  // only ATS API calls hit the network again (cachedFetcher).
  let acquired: AcquireResult = { text: null, source: null, html: null, meta: null };
  try {
    acquired = await acquireJdFromUrl(canonical, fetchText);
  } catch (e) {
    console.warn("jd acquisition failed", e);
  }
  let jobDescription: string | null = manual.jdText?.trim() || null;
  const jdIsManual = !!jobDescription;
  if (!jobDescription) {
    jobDescription = acquired.text;
    if (!jobDescription && (acquired.html || pageHtml)) {
      jobDescription = await llmExtractJd(acquired.html ?? pageHtml);
    }
  }

  const meta = acquired.meta ?? {};
  // An Oracle CX page is a JS shell whose <title> is the employer, never the
  // role: only the requisition feed (meta) or the caller can name the job.
  const oracle = atsApiUrl(canonical)?.kind === "oracle" || !!oracleApiFromPage(canonical, pageHtml);
  const scrapedTitle = !oracle && extracted && extracted.title !== "Unknown" ? extracted.title : "";

  // Acquisition failed - the page could not be fetched, or an Oracle feed
  // had no such posting - and no tier produced a JD: caller-supplied
  // title/company/location alone must not turn that into a match. Only a
  // pasted JD does.
  if (!jobDescription && (pageError || (oracle && !meta.title))) {
    const base = pageError
      ? (pageError instanceof Error ? pageError.message : String(pageError))
      : "the Oracle requisition feed has no such posting - it may be closed or on another career site";
    const hint = /may be closed/.test(base) ? "" : " - paste the job description and title to add it anyway";
    throw new FetchError(pageError instanceof FetchError ? pageError.code : "fetch_failed", base + hint);
  }

  const title = manual.title?.trim() || meta.title || scrapedTitle;
  if (!title) {
    if (pageError) {
      const base = pageError instanceof Error ? pageError.message : String(pageError);
      // A closed posting gets no "paste it" hint: there is nothing to apply to.
      const hint = /may be closed/.test(base) ? ""
        : manual.jdText ? " - pass `title` with the JD text to add it anyway"
        : " - paste the job description and title to add it anyway";
      throw new FetchError(pageError instanceof FetchError ? pageError.code : "fetch_failed", base + hint);
    }
    throw new FetchError(
      "blocked",
      "couldn't read a job title from this page - it may require JavaScript or a login",
    );
  }
  // An Oracle CX shell's <title> is the employer, not the role.
  const oracleShellCompany = acquired.source === "ats:oracle" || /oraclecloud\.com$/.test(host)
    ? pageTitleTag(pageHtml) : "";
  const company = manual.company?.trim() || meta.company || oracleShellCompany
    || extracted?.company || companyFromUrl(canonical) || host.replace(/^www\./, "").split(".")[0] || "Unknown";
  const location = manual.location?.trim() || meta.location || extracted?.location || "";
  return { company, title, location, jobDescription, jdIsManual };
}

export const runIngest = internalAction({
  args: {
    user: v.string(),
    ingestId: v.id("manualIngests"),
    // Caller-supplied fields (REST `jdText` / `title` / ...): a manual JD
    // lets a bot-walled posting still become a match.
    manual: v.optional(v.object(manualArgs)),
  },
  handler: async (ctx: ActionCtx, { user, ingestId, manual }) => {
    try {
      const ingest = await ctx.runQuery(internal.ingest.getIngestInternal, { ingestId });
      if (!ingest) throw new Error("ingest not found");

      await ctx.runMutation(internal.ingest.patchIngestInternal, {
        ingestId,
        status: "extracting",
      });

      // Older ingests stripped gh_jid, which can turn a posting into the
      // company's entire careers page. Recover identity from the raw URL.
      const canonical = canonicalUrl(ingest.url);
      const job = await resolveIngest(canonical, manual ?? {});

      const dedupKey = ingest.dedupKey || "";
      const short = ingest.short;
      const today = new Date().toISOString().slice(0, 10);
      const item = {
        key: dedupKey,
        short,
        company: job.company,
        title: job.title,
        location: job.location,
        term: inferTerm(job.title, ingest.url),
        added: today,
        tag: "[MANUAL]",
        salary: "",
        url: canonical,
        source: "manual",
      };

      // Upsert into matches, jobDescription riding along when acquired.
      // (Built conditionally: an explicit `undefined` is not a Convex value.)
      const stored = await ctx.runMutation(internal.ingest.upsertMatchInternal, {
        user,
        short,
        item,
        ...(job.jobDescription ? { jobDescription: job.jobDescription } : {}),
        ...(job.jdIsManual ? { jobDescriptionIsManual: true } : {}),
      });

      await ctx.runMutation(internal.ingest.patchIngestInternal, {
        ingestId,
        status: "done",
        dedupKey: stored.dedupKey,
        short: stored.short,
        canonicalUrl: canonicalUrl(stored.url),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("runIngest failed", err);
      try {
        await ctx.runMutation(internal.ingest.patchIngestInternal, {
          ingestId,
          status: "failed",
          error: truncateError(msg),
          errorCode: err instanceof FetchError ? err.code : "fetch_failed",
        });
      } catch (e) {
        console.error("failed to patch ingest to failed", e);
      }
    }
  },
});
