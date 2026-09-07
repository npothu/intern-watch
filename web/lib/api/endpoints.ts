import "server-only";
import { z } from "zod";
import * as store from "../convex";
import * as s from "./schemas";
import { ApiError } from "./auth";

type Method = "GET" | "POST" | "PUT" | "DELETE";
type Params = Record<string, string>;
export type Endpoint = {
  method: Method;
  path: string;
  summary: string;
  schema: z.ZodType;
  status: number;
  run: (user: string, params: Params, raw: unknown) => Promise<unknown>;
};

function endpoint<T extends z.ZodType>(
  method: Method, path: string, summary: string, schema: T,
  run: (user: string, params: Params, body: z.output<T>) => Promise<unknown>,
  status = 200,
): Endpoint {
  return { method, path, summary, schema, status, run: (user, params, raw) => run(user, params, schema.parse(raw)) };
}

function requireSuccess(result: { ok: boolean; error?: string; reason?: string }) {
  if (!result.ok) {
    const missing = result.reason === "not_found" || /not found/i.test(result.error ?? "");
    throw new ApiError(missing ? 404 : 409, missing ? "not_found" : "conflict", result.error ?? "The requested operation could not be completed.");
  }
  return result;
}

export function fileResponse(file: store.ResumeExportFile): Response {
  const bytes = Buffer.from(file.base64, "base64");
  const ascii = file.filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return new Response(bytes, { headers: {
    "Content-Type": file.contentType,
    "Content-Length": String(bytes.byteLength),
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
  } });
}

export const endpoints: Endpoint[] = [
  endpoint("GET", "/me", "Get the authenticated tracker user", s.empty, async (user) => ({ user })),
  endpoint("GET", "/health", "Read watcher and mail health", s.empty, (user) => store.getHealth(user)),
  endpoint("GET", "/matches", "List matches and their current applied, saved and dismissed flags", s.empty, async (user) => {
    const [matches, ticks] = await Promise.all([store.getMatches(user), store.getTicks(user)]);
    const byShort = new Map(ticks.map((tick) => [tick.short, tick]));
    return matches.map((match) => ({ ...match, ...byShort.get(match.short ?? "") }));
  }),
  endpoint("POST", "/ingests", "Add a job URL and start ingestion", z.strictObject({ url: s.jobUrl }),
    (user, _, body) => store.requestIngest(user, body.url), 202),
  endpoint("GET", "/ingests/{id}", "Poll a job ingestion", s.empty, async (user, { id }) => {
    const result = await store.getIngestStatus(user, id);
    if (!result) throw new ApiError(404, "not_found", "Ingestion not found.");
    return result;
  }),
  endpoint("GET", "/ticks", "List match flags", s.empty, (user) => store.getTicks(user)),
  endpoint("PUT", "/ticks", "Set up to 500 match flags atomically", s.ticks, async (user, _, { writes }) => {
    await store.setTicks(user, writes);
    return { count: writes.length };
  }),
  endpoint("GET", "/applications", "List applications with status, notes, history and deadlines", s.empty,
    async (user) => Object.values(await store.getLedger(user))),
  endpoint("PUT", "/applications/{short}/status", "Record an application status and note", z.strictObject({
    status: s.status, note: z.string().trim().max(20_000).default(""),
  }), async (user, { short }, body) => {
    await store.recordStatus(user, short, body.status, body.note);
    return body;
  }),
  endpoint("PUT", "/applications/{short}/due-date", "Set a due date, or clear it with null", z.strictObject({ dueAt: s.date }),
    async (user, { short }, { dueAt }) => requireSuccess(await store.setDueAt(user, short, dueAt))),
  endpoint("PUT", "/applications/{short}/snooze", "Set a snooze, or clear it with null", z.strictObject({ snoozedUntil: s.date }),
    async (user, { short }, { snoozedUntil }) => requireSuccess(await store.setSnooze(user, short, snoozedUntil))),
  endpoint("GET", "/inbox", "List pending inbox actions and mailbox health", s.empty, (user) => store.getInboxActions(user)),
  endpoint("POST", "/inbox/{id}/resolve", "Resolve or dismiss a pending inbox action", z.strictObject({
    short: s.short.optional(), status: s.status.optional(), dismiss: z.boolean().optional(),
  }).refine((body) => body.dismiss === true
    ? body.short === undefined && body.status === undefined
    : body.short !== undefined && body.status !== undefined,
    "Provide short and status to resolve, or only dismiss: true to dismiss."), async (user, { id }, body) => {
    await store.resolveInboxAction(user, { id, ...body });
    return { resolved: true };
  }),
  endpoint("GET", "/matches/{short}/job-description", "Read a saved job description", s.empty,
    (user, { short }) => store.getJobDescription(user, short)),
  endpoint("PUT", "/matches/{short}/job-description", "Save a job description", z.strictObject({ jdText: z.string().trim().min(1).max(20_000) }),
    async (user, { short }, { jdText }) => requireSuccess(await store.saveJobDescription(user, short, jdText))),
  endpoint("GET", "/resumes", "List built resumes, download URLs and reports", s.empty, (user) => store.getResumeUrls(user)),
  endpoint("GET", "/resumes/{short}", "Poll build status and read resume metadata", s.empty, async (user, { short }) => {
    const [build, resumes] = await Promise.all([store.fetchBuildStatus(user, short), store.getResumeUrls(user)]);
    return { build, resume: resumes[short] ?? null };
  }),
  endpoint("POST", "/resumes/{short}/build", "Start a resume build or rebuild with optional refinements", s.build,
    async (user, { short }, { profileSnapshot, ...options }) => requireSuccess(await store.requestResumeBuild(user, short, {
      ...options, ...(profileSnapshot ? { profileSnapshot: JSON.stringify(profileSnapshot) } : {}),
    })), 202),
  endpoint("POST", "/resumes/{short}/restore", "Restore the previous resume build", s.empty,
    async (user, { short }) => requireSuccess(await store.restoreResume(user, short))),
  endpoint("DELETE", "/resumes/{short}", "Delete both kept resume builds", s.empty,
    async (user, { short }) => requireSuccess(await store.deleteResume(user, short))),
  endpoint("GET", "/profile", "Read the resume profile JSON object", s.empty, async (user) => {
    const { data } = await store.getProfile(user);
    return data ? JSON.parse(data) : null;
  }),
  endpoint("PUT", "/profile", "Replace the resume profile JSON object", z.strictObject({ profile: s.profile }), async (user, _, { profile }) => {
    await store.putProfile(user, JSON.stringify(profile));
    return { saved: true };
  }),
  endpoint("POST", "/profile/export", "Download a full profile variant as PDF or DOCX", z.strictObject({
    profile: s.profile.optional(), variant: s.variant.default("base"), format: z.enum(["pdf", "docx"]),
  }), async (user, _, body) => {
    const data = body.profile ? JSON.stringify(body.profile) : (await store.getProfile(user)).data;
    if (!data) throw new ApiError(404, "not_found", "No resume profile on file.");
    return fileResponse(await store.exportProfileFile(data, body.variant, body.format));
  }),
  endpoint("POST", "/profile/suggest-cuts", "Suggest cuts for a profile variant", z.strictObject({ profile: s.profile, variant: s.variant }),
    (_, __, body) => store.suggestProfileCuts(JSON.stringify(body.profile), body.variant)),
  endpoint("POST", "/profile/import/upload", "Prepare a DOCX, TXT or Markdown upload", z.strictObject({
    filename: s.importFilename, size: z.int().min(1).max(5 * 1024 * 1024),
  }), async (user, _, { filename }) => ({
    uploadUrl: await store.getResumeImportUploadUrl(user), contentType: s.importContentType(filename),
  })),
  endpoint("POST", "/profile/import", "Claim the uploaded file and start profile mapping", z.strictObject({ storageId: s.id, filename: s.importFilename }),
    async (user, _, body) => {
      await store.claimResumeImportUpload(user, { ...body, contentType: s.importContentType(body.filename) });
      return { status: "mapping" };
    }, 202),
  endpoint("GET", "/profile/import", "Poll profile mapping and read its preview", s.empty, (user) => store.getResumeImportStatus(user)),
  endpoint("DELETE", "/profile/import", "Discard the pending profile import", s.empty, async (user) => {
    await store.discardResumeImportUpload(user);
    return { discarded: true };
  }),
  endpoint("POST", "/profile/import/confirm", "Save a reviewed import and back up the previous profile", z.strictObject({ profile: s.profile }),
    async (user, _, { profile }) => {
      await store.importProfile(user, JSON.stringify(profile));
      return { saved: true };
    }),
  endpoint("GET", "/preferences", "Read watcher preferences and the last resolved configuration", s.empty, (user) => store.getWatchSettings(user)),
  endpoint("PUT", "/preferences", "Replace watcher overrides; omitted blocks use YAML defaults", z.strictObject({ watch: s.watch }),
    (user, _, { watch }) => store.setWatchSettings(user, watch)),
  endpoint("GET", "/resume-model", "Read the resume model choice and shared-key usage", s.empty, (user) => store.getResumeLlm(user)),
  endpoint("PUT", "/resume-model", "Choose the resume model; null provider restores the shared default", z.strictObject({
    provider: z.enum(["gemini", "anthropic", "openai", "openrouter"]).nullable(),
    model: z.string().trim().min(1).max(200).nullable(),
  }).refine((body) => body.provider !== null || body.model === null, "A model requires a provider."), async (user, _, body) => {
    await store.setResumeLlm(user, body.provider, body.model);
    return body;
  }),
  endpoint("GET", "/connections", "List credential metadata and connected mailbox health, without secrets", s.empty, async (user) => {
    const [credentials, mailbox] = await Promise.all([store.listCredentials(user), store.getMailAccount(user)]);
    return { credentials, mailbox };
  }),
  endpoint("PUT", "/connections/{provider}", "Save or replace encrypted provider credentials", z.strictObject({
    fields: z.strictObject({ apiKey: z.string().trim().min(1).max(20_000) }),
  }), async (user, { provider }, { fields }) => {
    await store.putCredential(user, provider, fields);
    return { saved: true };
  }),
  endpoint("POST", "/connections/{provider}/test", "Test saved provider credentials", s.empty, (user, { provider }) => store.testCredential(user, provider)),
  endpoint("DELETE", "/connections/{provider}", "Remove saved provider credentials", s.empty, async (user, { provider }) => {
    await store.deleteCredential(user, provider);
    return { deleted: true };
  }),
];

export const parameterSchemas: Record<string, z.ZodType<string>> = { short: s.short, id: s.id, provider: s.provider };
