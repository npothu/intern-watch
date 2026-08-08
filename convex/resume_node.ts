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
import { composeResumeDoc, projectEntries, resumeFilename, resumeOutline } from "./resume_docx";
import { bulletsFor, type ProfileV2, toV2 } from "./profile_schema";
import { analyze, pickVariant, selectProjects as scoreSelect } from "./resume_select";

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

// Select which projects surface on the resume: JD-scored via resume_select
// (the select.py port - tags x3, tech x2, prose x1, top MAX_PROJECTS),
// replacing the former bank-order slice, and per project the bullet VARIANT
// whose text hits the most JD weight (pick_variant parity; ties go to base).
// Scores and variants ride along into the build report so the user can see
// why a project was picked, dropped, or shown in a non-base voice.
function selectForBuild(
  profile: ProfileV2,
  jdText: string,
  forcedVariant?: string,
): {
  payload: ProjectPayload[];
  scores: Record<string, number>;
  variants: Record<string, string>;
} {
  const { selected, scores } = scoreSelect(profile, jdText);
  const jd = analyze(jdText);
  const variants: Record<string, string> = {};
  const payload = buildProjectPayload(
    selected.map(([name, e]) => {
      // A forced variant (user picked it in the report dialog's Edit tab)
      // replaces the per-project JD auto-pick everywhere. bulletsFor falls
      // back to "base" when a project has no array for that variant, so a
      // variant with sparse coverage still renders.
      const variant = forcedVariant ?? pickVariant(e, jd);
      variants[name] = variant;
      return {
        name,
        tech: (e.tech ?? []).join(", "),
        bullets: bulletsFor(e, variant),
      };
    }),
  );
  return { payload, scores, variants };
}

// What the tailor did, stored next to the artifact it describes (the
// resumes.report column) and rendered by the web app's report dialog.
type BuildReport = {
  builtAt: number;
  usedLlm: boolean;
  llmError?: string;
  jdSource: "manual" | "fetched" | "stub";
  jdChars: number;
  instructions?: string;
  // The user-forced bullet variant, when one was picked instead of the
  // per-project JD auto-pick. Undefined = auto.
  variant?: string;
  scores: Record<string, number>;
  notes: string[];
  projects: {
    name: string;
    variant: string;
    before: string[];
    after: string[];
    llmRewritten: boolean;
    overridden: boolean;
  }[];
  outline: string[];
};

type BuildOverride = { name: string; bullets: string[] };

// The build's executable body. Shared by the runBuild action so the error
// boundary lives in one place.
async function performBuild(
  ctx: ActionCtx,
  user: string,
  short: string,
  opts: {
    jdText?: string;
    instructions?: string;
    overrides?: BuildOverride[];
    variant?: string;
  } = {},
): Promise<void> {
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
  const profile: ProfileV2 = toV2(
    typeof profileRow.data === "string" ? JSON.parse(profileRow.data) : profileRow.data,
  );

  // JD text, most trustworthy source first: user-pasted (a rebuild after the
  // report said acquisition failed, or an override of a bad fetch), then the
  // live page, then the title/company/location stub. The source is recorded in
  // the report - the old builder proceeded on the stub silently, which was the
  // single worst failure mode of the flagship feature.
  let jdSource: BuildReport["jdSource"];
  let jdText: string;
  const manual = (opts.jdText ?? "").trim();
  if (manual) {
    jdSource = "manual";
    jdText = manual.slice(0, JD_MAX_CHARS);
  } else {
    jdText = await fetchJdText(item.url ?? "");
    jdSource = jdText ? "fetched" : "stub";
    if (!jdText) {
      jdText = [company && `Company: ${company}`, title && `Title: ${title}`, location && `Location: ${location}`]
        .filter(Boolean)
        .join("\n");
    }
  }

  // Tailor the selected project bullets with the LLM (all failures fall back
  // to the deterministic bank text, exactly like tailor.py never raising).
  const { payload: selected, scores, variants } = selectForBuild(
    profile,
    jdText,
    opts.variant,
  );
  const projectDates = new Map(
    projectEntries(profile).map((e) => [e.heading, e.date]),
  );
  const before = new Map(
    selected.map((p) => [p.name, p.bullets.map((b) => b.text)]),
  );
  let content = {
    projects: selected.map((p) => ({
      name: p.name,
      tech: p.tech,
      date: projectDates.get(p.name) ?? "",
      bullets: p.bullets.map((b) => b.text),
    })),
  };
  let usedLlm = false;
  let llmError: string | undefined;
  const rewritten = new Set<string>();
  const notes: string[] = [];
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    try {
      // Free-form user guidance rides into the prompt alongside the JD, so
      // "emphasize the Go work" steers the same rewrite pass a plain build
      // runs - no separate edit pipeline to maintain.
      const jdForPrompt = opts.instructions
        ? `${jdText}\n\nAdditional instructions from the candidate (follow these):\n${opts.instructions.slice(0, 1000)}`
        : jdText;
      const { system, user: userMsg } = assemblePrompt(jdForPrompt, selected);
      const text = await llmCall(system, userMsg, apiKey);
      const rewrites = parseRewrites(text);
      const applied = applyRewrites(
        selected.map((p) => ({ name: p.name, bullets: p.bullets.map((b) => b.text) })),
        rewrites,
      );
      notes.push(...applied.notes);
      for (const p of applied.projects) {
        if (p.llmRewritten) rewritten.add(p.name);
      }
      const bulletsByName = new Map(applied.projects.map((p) => [p.name, p.bullets]));
      content = {
        projects: content.projects.map((p) => ({
          ...p,
          bullets: bulletsByName.get(p.name) ?? p.bullets,
        })),
      };
      usedLlm = true;
    } catch (err) {
      llmError = err instanceof Error ? err.message : String(err);
      console.warn("resume tailor fell back to bank text", err);
    }
  } else {
    notes.push("GEMINI_API_KEY not set - bank text used verbatim");
  }

  // Hand-edited bullet text wins over everything: it is the user's literal
  // words, applied after the LLM pass per project name.
  const overridden = new Set<string>();
  for (const o of opts.overrides ?? []) {
    const target = content.projects.find((p) => p.name === o.name);
    if (target && o.bullets.length) {
      target.bullets = o.bullets;
      overridden.add(o.name);
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

  const report: BuildReport = {
    builtAt: Date.now(),
    usedLlm,
    llmError,
    jdSource,
    jdChars: jdText.length,
    instructions: opts.instructions,
    variant: opts.variant,
    scores,
    notes,
    projects: content.projects.map((p) => ({
      name: p.name,
      variant: variants[p.name] ?? "base",
      before: before.get(p.name) ?? [],
      after: p.bullets,
      llmRewritten: rewritten.has(p.name),
      overridden: overridden.has(p.name),
    })),
    outline: resumeOutline(profile, content),
  };

  // Attach (keep-N=2 upsert) with the report, then clear the marker.
  await ctx.runMutation(internal.resume.attachResumeInternal, {
    user,
    short,
    filename: resumeFilename(profile, company),
    storageId,
    report,
  });
  await ctx.runMutation(internal.resume.clearBuild, { user, short });
}

// ---------------------------------------------------------------------------
// Internal action ("use node"): the actual build, run on a scheduler slot.
// Any failure is recorded on the resumeBuilds row and swallowed so a broken
// build never crash-loops the scheduler (same pattern as mail.ts sync).
// ---------------------------------------------------------------------------
export const runBuild = internalAction({
  args: {
    user: v.string(),
    short: v.string(),
    jdText: v.optional(v.string()),
    instructions: v.optional(v.string()),
    overrides: v.optional(
      v.array(v.object({ name: v.string(), bullets: v.array(v.string()) })),
    ),
    variant: v.optional(v.string()),
  },
  handler: async (ctx, { user, short, jdText, instructions, overrides, variant }) => {
    try {
      await performBuild(ctx, user, short, {
        jdText,
        instructions,
        overrides,
        variant,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("resume build failed", err);
      await ctx.runMutation(internal.resume.markBuildFailed, { user, short, error: message });
    }
  },
});
