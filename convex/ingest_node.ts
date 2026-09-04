"use node";

import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { canonicalUrl, detectAts, extractForAts, inferTerm } from "./ingest_extract";
import { acquireJdFromUrl, llmExtractJd } from "./jd_acquire";

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_BYTES = 200 * 1024; // 200KB cap
const ERROR_TRUNC = 300;

function truncateError(msg: string): string {
  return msg.length > ERROR_TRUNC ? msg.slice(0, ERROR_TRUNC - 3) + "..." : msg;
}

async function fetchWithLimits(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "intern-watch/1.0" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`fetch failed: HTTP ${resp.status}`);
    const text = await resp.text();
    // A 2xx with nothing in it is not a success. Avature answers automated
    // requests with HTTP 202 and a zero-length body, which passed `resp.ok`
    // and left the extractor parsing an empty string - producing a match row
    // with a hostname for a company and a placeholder title.
    if (!text.trim()) {
      throw new Error(
        `empty response (HTTP ${resp.status}) - this page likely renders with JavaScript or blocks automated fetches`
      );
    }
    if (text.length > FETCH_MAX_BYTES) return text.slice(0, FETCH_MAX_BYTES);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

// Acquire the full JD for an ingested URL so the match row carries its
// jobDescription from the moment it exists. Tier order (jd_acquire): ATS
// public APIs by URL shape, then the already-fetched page's embedded
// structured data, then the plausibility-gated page body, and finally the
// LLM extraction last resort. Never throws; null means every tier missed.
async function acquireJdForIngest(
  canonical: string,
  pageHtml: string,
): Promise<string | null> {
  const { text, html } = await acquireJdFromUrl(canonical, async (u) => {
    // The posting page itself was already fetched; only ATS API calls hit
    // the network again.
    if (u === canonical) return pageHtml;
    return await fetchWithLimits(u);
  });
  if (text) return text;
  return await llmExtractJd(html ?? pageHtml);
}

export const runIngest = internalAction({
  args: { user: v.string(), ingestId: v.id("manualIngests") },
  handler: async (ctx: ActionCtx, { user, ingestId }) => {
    try {
      const ingest = await ctx.runQuery(internal.ingest.getIngestInternal, { ingestId });
      if (!ingest) throw new Error("ingest not found");

      // Update status to extracting
      await ctx.runMutation(internal.ingest.patchIngestInternal, {
        ingestId,
        status: "extracting",
      });

      const canonical = ingest.canonicalUrl || canonicalUrl(ingest.url);
      // Fetch URL
      const html = await fetchWithLimits(canonical);

      // Detect ATS and extract
      let host = "";
      try { host = new URL(canonical).hostname; } catch { host = ""; }
      const ats = detectAts(host);
      let extracted = extractForAts(html, canonical, ats);

      // Full-JD acquisition (ATS APIs -> embedded -> body -> LLM last
      // resort), so the build never has to fetch anything later.
      let jobDescription: string | null = null;
      try {
        jobDescription = await acquireJdForIngest(canonical, html);
      } catch (e) {
        console.warn("jd acquisition failed", e);
      }

      // A row whose title is a placeholder is worse than no row: it looks like
      // a real match in the list and gives no clue that extraction failed.
      // Fail the ingest instead, so the dialog can say so.
      if (!extracted.title || extracted.title === "Unknown") {
        throw new Error(
          "couldn't read a job title from this page - it may require JavaScript or a login"
        );
      }

      // Build MatchItem
      const dedupKey = ingest.dedupKey || "";
      const short = ingest.short;
      const today = new Date().toISOString().slice(0, 10);
      const item = {
        key: dedupKey,
        short,
        company: extracted.company,
        title: extracted.title,
        location: extracted.location || "",
        term: inferTerm(extracted.title, ingest.url),
        added: today,
        tag: "[MANUAL]",
        salary: "",
        url: canonical,
        source: "manual",
      };

      // Upsert into matches, jobDescription riding along when acquired.
      // (Built conditionally: an explicit `undefined` is not a Convex value.)
      await ctx.runMutation(internal.ingest.upsertMatchInternal, {
        user,
        short,
        item,
        ...(jobDescription ? { jobDescription } : {}),
      });

      // Patch ingest to done
      await ctx.runMutation(internal.ingest.patchIngestInternal, {
        ingestId,
        status: "done",
        dedupKey,
        short,
        canonicalUrl: canonical,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("runIngest failed", err);
      try {
        await ctx.runMutation(internal.ingest.patchIngestInternal, {
          ingestId,
          status: "failed",
          error: truncateError(msg),
        });
      } catch (e) {
        console.error("failed to patch ingest to failed", e);
      }
    }
  },
});
