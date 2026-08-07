"use node";

import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { canonicalUrl, detectAts, extractForAts } from "./ingest_extract";

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
    if (text.length > FETCH_MAX_BYTES) return text.slice(0, FETCH_MAX_BYTES);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

// LLM fallback: if GEMINI_API_KEY present, try to enrich via Gemini.
// For Phase 1 we keep this as a stub that returns null (skip).
async function llmEnrich(_html: string, _url: string): Promise<null> {
  if (!process.env.GEMINI_API_KEY) return null;
  // Placeholder: future phase could call Gemini to extract structured data.
  return null;
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

      // LLM enrichment if needed and key present (best-effort, never throws outer)
      try {
        const llmData = await llmEnrich(html, canonical);
        if (llmData) {
          // Future: merge llmData into extracted
        }
      } catch (e) {
        console.warn("llm enrich failed", e);
      }

      // If extraction yielded placeholder Unknown and we have no data, still proceed with fallback
      if (!extracted.company || extracted.company === "Unknown") {
        // Try to fallback to generic host-derived company (already done)
      }
      if (!extracted.title || extracted.title === "Unknown") {
        extracted.title = "Manual Ingest";
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
        term: "",
        added: today,
        tag: "[MANUAL]",
        salary: "",
        url: canonical,
        source: "manual",
      };

      // Upsert into matches
      await ctx.runMutation(internal.ingest.upsertMatchInternal, {
        user,
        short,
        item,
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
