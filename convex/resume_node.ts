"use node";

// The Convex-native resume builder's Node-runtime action.
//
// This file is separate from resume.ts because a "use node" file may only
// export actions (Convex rejects queries/mutations declared alongside a
// "use node" pragma) - resume.ts keeps requestBuild/getBuildStatus/putProfile
// (mutations/queries) in the default (V8 isolate) runtime, and this file
// holds only runBuild.
//
// The default runtime has no Node globals (see mail.ts's atob/TextDecoder
// comment for the precedent in this codebase). The `docx` npm package is a
// bundler-oriented library not vetted for that isolate, and its output
// (Packer.toBuffer) is documented as a Node `Buffer`, so the build action -
// JD fetch -> Gemini call -> docx generation -> storage - runs here under
// the Node runtime instead of risking a runtime-only failure in the isolate.

import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { Packer } from "docx";
import {
  applyRewrites,
  assemblePrompt,
  buildProjectPayload,
  parseRewrites,
  type ProjectPayload,
} from "./resume_prompt";
import { composeResumeDoc, resumeFilename, type Profile } from "./resume_docx";

const MAX_PROJECTS = 6; // src/resume/select.py MAX_PROJECTS
const JD_MIN_CHARS = 200; // src/resume/jd_source.py MIN_JD_CHARS
const JD_MAX_CHARS = 6000; // generous cap for the tailor prompt excerpt

// ---------------------------------------------------------------------------
// JD acquisition + LLM tailor (mirrors src/resume/build.py + tailor.py).
// ---------------------------------------------------------------------------

// Basic html-to-text: drop script/style blocks, strip tags, decode a few
// entities, collapse whitespace. Cap the length for the prompt.
function stripHtml(html: string): string {
  const noScript = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const text = noScript
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

// Fetch the job page text with a 10s timeout. Tolerates any failure (network,
// non-200, blocked page, short/empty body) by returning "" so the caller can
// degrade to the title/company/location fallback.
async function fetchJdText(url: string): Promise<string> {
  if (!url) return "";
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; intern-watch/1.0)" },
      redirect: "follow",
    });
    if (!resp.ok) return "";
    const text = stripHtml(await resp.text());
    return text.length >= JD_MIN_CHARS ? text.slice(0, JD_MAX_CHARS) : "";
  } catch {
    return "";
  }
}

// Call Gemini (gemini-flash-lite-latest) with the tailor prompt, returning the
// raw response text. Mirrors src/llm.py _call_gemini: JSON mime, temp 0.
async function llmCall(system: string, user: string, apiKey: string): Promise<string> {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent";
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 8192,
        temperature: 0,
      },
    }),
  });
  if (!resp.ok) {
    throw new Error(`gemini rejected the request: HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join("");
  if (!text.trim()) throw new Error("gemini returned an empty response");
  return text;
}

// Select which projects surface on the resume: bank order, capped at
// MAX_PROJECTS, base bullet variants. DIVERGENCE from Python (documented):
// the Python build_plan scores projects against the JD, picks a per-project
// variant, and page-fits; the Convex builder keeps bank order + base variants
// and tailors only through the LLM rewrite pass (select.py profile/bank work
// is out of scope here).
function selectProjects(profile: Profile): ProjectPayload[] {
  const entries = Object.entries(profile.projects ?? {}).slice(0, MAX_PROJECTS);
  return buildProjectPayload(
    entries.map(([name, p]) => ({
      name,
      tech: (p.tech ?? []).join(", "),
      bullets: p.bullets.base ?? [],
    })),
  );
}

// The build's executable body. Shared by the runBuild action so the error
// boundary lives in one place.
async function performBuild(ctx: ActionCtx, user: string, short: string): Promise<void> {
  const match = await ctx.runQuery(internal.resume.getMatchInternal, { user, short });
  if (!match) throw new Error("match not found");
  const item = (match.item ?? {}) as {
    company?: string;
    title?: string;
    location?: string;
    url?: string;
  };
  const company = item.company ?? "";
  const title = item.title ?? "";
  const location = item.location ?? "";

  const profileRow = await ctx.runQuery(internal.resume.getProfileInternal, { user });
  if (!profileRow) throw new Error("profile not found");
  // `data` is a JSON string (putProfile's contract - object storage rejects
  // non-ASCII dict keys); tolerate legacy rows written as a raw object.
  const profile = (
    typeof profileRow.data === "string" ? JSON.parse(profileRow.data) : profileRow.data
  ) as Profile;

  // JD text: the real page if we can get it; otherwise degrade to the match's
  // title/company/location (the Python skips on no JD, but the task directs
  // the Convex builder to fall back so the resume still builds).
  let jdText = await fetchJdText(item.url ?? "");
  if (!jdText) {
    jdText = [company && `Company: ${company}`, title && `Title: ${title}`, location && `Location: ${location}`]
      .filter(Boolean)
      .join("\n");
  }

  // Tailor the selected project bullets with the LLM (all failures fall back
  // to the deterministic bank text, exactly like tailor.py never raising).
  const selected = selectProjects(profile);
  const projectDates = new Map(
    Object.entries(profile.projects ?? {}).map(([n, p]) => [n, p.date]),
  );
  let content = {
    projects: selected.map((p) => ({
      name: p.name,
      tech: p.tech,
      date: projectDates.get(p.name) ?? "",
      bullets: p.bullets.map((b) => b.text),
    })),
  };
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    try {
      const { system, user: userMsg } = assemblePrompt(jdText, selected);
      const text = await llmCall(system, userMsg, apiKey);
      const rewrites = parseRewrites(text);
      const applied = applyRewrites(
        selected.map((p) => ({ name: p.name, bullets: p.bullets.map((b) => b.text) })),
        rewrites,
      );
      const bulletsByName = new Map(applied.projects.map((p) => [p.name, p.bullets]));
      content = {
        projects: content.projects.map((p) => ({
          ...p,
          bullets: bulletsByName.get(p.name) ?? p.bullets,
        })),
      };
    } catch (err) {
      console.warn("resume tailor fell back to bank text", err);
    }
  }

  // Compose + serialize the .docx and store its bytes in Convex storage.
  // ctx.storage.store() takes a Blob (not a raw Buffer/ArrayBuffer) - the
  // Blob's type becomes the stored file's Content-Type on retrieval, so it
  // must match the DOCX Open Packaging mime the Python ConvexStore.put_resume
  // upload uses (src/store.py's _DOCX_MIME) for the two paths to agree.
  const DOCX_MIME =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const doc = composeResumeDoc(profile, content);
  const buf = await Packer.toBuffer(doc);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const blob = new Blob([arrayBuffer], { type: DOCX_MIME });
  const storageId = await ctx.storage.store(blob);

  // Attach replace-on-upsert, then clear the in-flight marker.
  await ctx.runMutation(internal.resume.attachResumeInternal, {
    user,
    short,
    filename: resumeFilename(profile, company),
    storageId,
  });
  await ctx.runMutation(internal.resume.clearBuild, { user, short });
}

// ---------------------------------------------------------------------------
// Internal action ("use node"): the actual build, run on a scheduler slot.
// Any failure is recorded on the resumeBuilds row and swallowed so a broken
// build never crash-loops the scheduler (same pattern as mail.ts sync).
// ---------------------------------------------------------------------------
export const runBuild = internalAction({
  args: { user: v.string(), short: v.string() },
  handler: async (ctx, { user, short }) => {
    try {
      await performBuild(ctx, user, short);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("resume build failed", err);
      await ctx.runMutation(internal.resume.markBuildFailed, { user, short, error: message });
    }
  },
});
