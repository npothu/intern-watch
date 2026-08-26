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
// JD fetch -> model call -> PDF/DOCX generation -> storage - runs here under
// the Node runtime instead of risking a runtime-only failure in the isolate.

import { action, internalAction } from "./_generated/server";
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
import {
  composeResumeDoc,
  projectEntries,
  resumeFilename,
  resumeOutline,
} from "./resume_renderers/docx";
import { buildResumePdf, pdfFilename } from "./resume_renderers/pdf";
import {
  callModel,
  chooseLlm,
  effectiveProvider,
  llmNote,
  PROVIDER_LABEL,
  resumeImportOutputTokens,
} from "./llm_providers";
import { bulletsFor, type ProfileV2, toV2 } from "./profile_schema";
import {
  extractResume,
  mapExtractionWithModel,
  MAX_IMPORT_BYTES,
  meteredInvoke,
} from "./resume_import";
import { analyze, pickVariant, selectProjects as scoreSelect } from "./resume_select";
import { exportResume, parseExportProfile } from "./resume_export";

// The TRACKER_SECRET env var set in the Convex dashboard (same gate as
// resume.ts - every public endpoint of the builder is private to the web app).
function checkSecret(secret: string) {
  if (secret !== process.env.TRACKER_SECRET) {
    throw new Error("bad secret");
  }
}

// saveProfile's cap (web/app/(app)/profile/profile-actions.ts), so any profile
// the editor could save also exports; the route re-checks it before calling.
const EXPORT_MAX_BYTES = 256 * 1024;
const EXPORT_VARIANT_MAX = 40;

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

// The provider-specific calls now live in ./llm_providers (the twin of
// src/llm.py's _PROVIDERS table), so this file only decides WHICH model runs
// and what to say about it afterwards.

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
      const requestedVariant = forcedVariant ?? pickVariant(e, jd);
      const variant = e.bullets[requestedVariant] ? requestedVariant : "base";
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
  format: "pdf";
  pageCount: 1;
  fit: {
    heightPt: number;
    safeHeightPt: number;
    adjustments: string[];
  };
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
  const manual = (opts.jdText ?? match.jobDescription ?? "").trim();
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
  // Which model tailors this build, and on whose quota.
  //
  // A user's own key always wins and is never capped - it is theirs to spend.
  // Otherwise the operator's shared key runs a cheap default, metered by a
  // per-user daily allowance. A user who has configured nothing still gets a
  // resume; the LLM step is simply skipped and the report says so. That is the
  // whole point of the design: the key is an upgrade, never a toll.
  const settingsRow = await ctx.runQuery(internal.settings.getSettingsInternal, { user });
  // The stored row uses resume-prefixed column names; chooseLlm takes the
  // generic shape so it stays a pure function with no schema knowledge.
  const preference = {
    provider: settingsRow?.resumeProvider,
    model: settingsRow?.resumeModel,
  };
  // Always look one up, under the default provider when no preference is set.
  // Gating this on a preference row would have orphaned every key saved before
  // the settings table existed.
  const userKey = await ctx.runAction(internal.credentials.resolveProviderKey, {
    user,
    provider: effectiveProvider(preference),
  });

  const operatorKey = process.env.GEMINI_API_KEY ?? null;
  // Read the allowance, but do not spend it yet: a build that never reaches a
  // successful model call must not cost the user a slot, or a broken operator
  // key would burn the whole day and then blame their usage for it.
  const capReached =
    !userKey && operatorKey
      ? await ctx.runQuery(internal.settings.operatorCapReached, { user })
      : false;
  const choice = chooseLlm({
    preference,
    userKey,
    operatorKey,
    operatorCapReached: capReached,
  });

  const apiKey = choice.apiKey;
  if (apiKey) {
    try {
      // Free-form user guidance rides into the prompt alongside the JD, so
      // "emphasize the Go work" steers the same rewrite pass a plain build
      // runs - no separate edit pipeline to maintain.
      const jdForPrompt = opts.instructions
        ? `Additional instructions from the candidate (follow these):\n${opts.instructions.slice(0, 1000)}\n\n${jdText}`
        : jdText;
      const { system, user: userMsg } = assemblePrompt(jdForPrompt, selected);
      const text = await callModel(choice.provider, {
        model: choice.model,
        system,
        user: userMsg,
        apiKey,
      });
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
      notes.push(llmNote(choice));
      // Charged only now, on a call that actually produced tailored text.
      if (choice.source === "operator") {
        await ctx.runMutation(internal.settings.consumeOperatorLlm, { user });
      }
    } catch (err) {
      llmError = err instanceof Error ? err.message : String(err);
      // Name the model that failed - "the LLM broke" is unactionable when the
      // user chose the model themselves and can switch it in one click.
      notes.push(
        `${PROVIDER_LABEL[choice.provider]} ${choice.model} failed - bank text used verbatim`,
      );
      console.warn("resume tailor fell back to bank text", err);
    }
  } else {
    notes.push(llmNote(choice));
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

  // Fit and validate the PDF before storing either artifact. The PDF renderer
  // owns pagination and may deterministically condense or remove the least
  // relevant optional content. DOCX is composed from that exact fitted plan,
  // so both downloads contain the same selected projects and bullets.
  const pdf = await buildResumePdf(profile, content, {
    scores,
  });
  content = pdf.content;
  notes.push(...pdf.notes.map((note) => note.message));

  const DOCX_MIME =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const doc = composeResumeDoc(pdf.profile, content);
  const buf = await Packer.toBuffer(doc);
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const docxBlob = new Blob([arrayBuffer], { type: DOCX_MIME });
  const pdfArrayBuffer = pdf.bytes.buffer.slice(
    pdf.bytes.byteOffset,
    pdf.bytes.byteOffset + pdf.bytes.byteLength,
  ) as ArrayBuffer;
  const pdfBlob = new Blob([pdfArrayBuffer], { type: "application/pdf" });

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
    format: "pdf",
    pageCount: 1,
    fit: {
      heightPt: pdf.heightPt,
      safeHeightPt: pdf.safeHeightPt,
      adjustments: pdf.notes.map((note) => note.message),
    },
    projects: content.projects.map((p) => ({
      name: p.name,
      variant: variants[p.name] ?? "base",
      before: before.get(p.name) ?? [],
      after: p.bullets,
      llmRewritten: rewritten.has(p.name),
      overridden: overridden.has(p.name),
    })),
    outline: resumeOutline(pdf.profile, content),
  };

  // Store and attach the pair atomically from the table's perspective. If the
  // second store or mutation fails, delete everything created by this action
  // so a failed build cannot leak unreferenced files.
  let pdfStorageId: Awaited<ReturnType<typeof ctx.storage.store>> | undefined;
  let docxStorageId: Awaited<ReturnType<typeof ctx.storage.store>> | undefined;
  try {
    pdfStorageId = await ctx.storage.store(pdfBlob);
    docxStorageId = await ctx.storage.store(docxBlob);
    await ctx.runMutation(internal.resume.attachResumeInternal, {
      user,
      short,
      filename: pdfFilename(pdf.profile, company),
      storageId: pdfStorageId,
      docxFilename: resumeFilename(pdf.profile, company),
      docxStorageId,
      report: JSON.stringify(report),
    });
  } catch (error) {
    if (pdfStorageId) await ctx.storage.delete(pdfStorageId);
    if (docxStorageId) await ctx.storage.delete(docxStorageId);
    throw error;
  }
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

// ---------------------------------------------------------------------------
// Internal action ("use node"): map a claimed resume upload into a ProfileV2
// preview. Scheduled by resume.claimProfileImportUpload - the same
// schedule-then-poll contract as requestBuild/runBuild (see convex/resume.ts),
// because the mapping makes up to two model calls over an 80k-char payload and
// must never hold a Vercel server action open for that long.
//
// The storage id comes ONLY from the user's own claim record - never from a
// client argument - so this action cannot be pointed at another user's stored
// file (see the claim mutation for the opaque-id threat model). Failures are
// recorded on the profileImports row and swallowed, like runBuild, so a broken
// import never crash-loops the scheduler.
// ---------------------------------------------------------------------------
export const runProfileImport = internalAction({
  args: { user: v.string(), storageId: v.id("_storage") },
  handler: async (ctx, { user, storageId: scheduledFor }) => {
    const record = await ctx.runQuery(internal.resume.getPendingProfileImport, { user });
    // Discarded, or superseded by a newer claim, before this ran. Nothing to
    // clean either: whoever removed or replaced the record removed its blob.
    if (!record || record.status !== "mapping" || !record.storageId) return;
    // Only map the upload this run was scheduled for. Without this check a
    // superseded run would map whatever record is current - the newer upload,
    // a second time - and bill the shared allowance twice for one import.
    if (record.storageId !== scheduledFor) return;
    const storageId = record.storageId;
    try {
      const blob = await ctx.storage.get(storageId);
      if (!blob) throw new Error("The temporary resume upload could not be found. Upload it again.");
      if (blob.size > MAX_IMPORT_BYTES) {
        throw new Error("Resume files must be 5 MB or smaller.");
      }
      const storedType = blob.type.trim().toLowerCase();
      const declaredType = record.contentType.trim().toLowerCase();
      if (storedType && declaredType && storedType !== declaredType) {
        throw new Error("The uploaded resume content type changed during upload.");
      }
      const extraction = await extractResume(
        new Uint8Array(await blob.arrayBuffer()),
        { filename: record.filename, contentType: storedType || declaredType },
      );

      const settingsRow = await ctx.runQuery(internal.settings.getSettingsInternal, { user });
      const preference = {
        provider: settingsRow?.resumeProvider,
        model: settingsRow?.resumeModel,
      };
      const userKey = await ctx.runAction(internal.credentials.resolveProviderKey, {
        user,
        provider: effectiveProvider(preference),
      });
      const operatorKey = process.env.GEMINI_API_KEY ?? null;
      // Read the allowance before spending anything, so a capped user is told
      // to bring a key instead of burning shared calls that cannot succeed.
      const operatorCapReached =
        !userKey && operatorKey
          ? await ctx.runQuery(internal.settings.operatorCapReached, { user })
          : false;
      const choice = chooseLlm({
        preference,
        userKey,
        operatorKey,
        operatorCapReached,
      });
      if (!choice.apiKey) {
        throw new Error(
          `Resume import needs semantic mapping from a configured model. ${choice.reason ?? "Add an API key in Settings and try again."}`,
        );
      }

      const invokeModel = async ({ system, user: userMsg }: { system: string; user: string }) => {
        try {
          return await callModel(choice.provider, {
            model: choice.model,
            system,
            user: userMsg,
            apiKey: choice.apiKey!,
            // Gemini exposes a larger structured-output budget. Free-form
            // custom models keep their conservative provider default.
            maxOutputTokens: resumeImportOutputTokens(choice.provider, choice.model),
          });
        } catch (error) {
          throw new Error(
            `${PROVIDER_LABEL[choice.provider]} ${choice.model} could not map this resume: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      };
      // Operator-key runs are metered per productive call (see meteredInvoke
      // for the whole policy). consumeOperatorLlm can answer {allowed: false}
      // when a concurrent build took the last slot between the cap read above
      // and this charge; the result is deliberately ignored - the call already
      // happened, and failing now would discard work the operator was billed
      // for. The cap read is what gates the NEXT run.
      const invoke =
        choice.source === "operator"
          ? meteredInvoke(invokeModel, () =>
              ctx.runMutation(internal.settings.consumeOperatorLlm, { user }),
            )
          : invokeModel;

      const imported = await mapExtractionWithModel(extraction, invoke);
      await ctx.runMutation(internal.resume.finishProfileImport, {
        user,
        storageId,
        preview: JSON.stringify(imported),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("resume import failed", err);
      await ctx.runMutation(internal.resume.finishProfileImport, {
        user,
        storageId,
        error: message,
      });
    }
  },
});

// ---------------------------------------------------------------------------
// Public action ("use node"): render one variant of a profile whole, as a PDF
// or DOCX, and hand the bytes straight back. Nothing is stored: unlike a
// tailored build there is no JD fetch or model call to wait on, so the render
// (well under a second) can hold the web server's request open, and a file
// that never touches storage has nothing to sweep.
//
// The profile arrives as JSON rather than being read from the `profiles`
// table so the download matches what is on the editor's screen, including
// edits the autosave has not flushed yet. Its only consumer is the user it
// came from, so the render trusts it as far as putProfile would.
// ---------------------------------------------------------------------------
export const exportProfile = action({
  args: {
    data: v.string(),
    variant: v.string(),
    format: v.union(v.literal("pdf"), v.literal("docx")),
    secret: v.string(),
  },
  handler: async (_ctx, { data, variant, format, secret }) => {
    checkSecret(secret);
    if (Buffer.byteLength(data) > EXPORT_MAX_BYTES) throw new Error("profile is too large");
    const name = variant.trim().slice(0, EXPORT_VARIANT_MAX) || "base";
    const exported = await exportResume(parseExportProfile(data), name, format);
    return {
      filename: exported.filename,
      contentType: exported.contentType,
      base64: Buffer.from(exported.bytes).toString("base64"),
    };
  },
});
