// @vitest-environment node
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import schema from "../../../convex/schema";
import { api } from "../../../convex/_generated/api";

vi.mock("server-only", () => ({}));
// The real HTTP client captures these at import time.
vi.hoisted(() => {
  process.env.CONVEX_URL = "https://api-test.convex.cloud";
  process.env.CONVEX_SECRET = "test-backend-secret";
});

import { GET, POST, PUT, DELETE, HEAD } from "../../app/api/v1/[[...path]]/route";
import { endpoints } from "./endpoints";
import { handleApiRequest, openApiDocument } from "./handler";

const modules = import.meta.glob("../../../convex/**/*.ts");
const key = `iw_${"a".repeat(43)}`;
const readKey = `iw_${"b".repeat(43)}`;
const otherKey = `iw_${"c".repeat(43)}`;
const short = "0123456789ab";
const secret = "test-backend-secret";
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
let backend: ReturnType<typeof convexTest>;
let upstream: ReturnType<typeof vi.fn>;

async function request(path: string, method = "GET", body?: unknown, token = key) {
  const req = new Request(`https://app.example/api/v1${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const handlers = { GET, POST, PUT, DELETE, HEAD };
  const handler = handlers[method as keyof typeof handlers];
  return handler ? handler(req, { params: Promise.resolve({ path: path.slice(1).split("/") }) })
    : handleApiRequest(req, path.slice(1).split("/"));
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubEnv("TRACKER_SECRET", secret);
  vi.stubEnv("TRACKER_API_KEYS", JSON.stringify([
    { sha256: hash(key), user: "alice", access: "write" },
    { sha256: hash(readKey), user: "alice", access: "read" },
    { sha256: hash(otherKey), user: "bob", access: "write" },
  ]));
  backend = convexTest(schema, modules);
  upstream = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toMatch(/^https:\/\/api-test.convex.cloud\/api\/(query|mutation|action)$/);
    const { path, args } = JSON.parse(String(init.body));
    const kind = url.split("/").at(-1) as "query" | "mutation" | "action";
    try {
      const value = await backend[kind](makeFunctionReference(path), args);
      return Response.json({ status: "success", value: value ?? null });
    } catch (error) {
      return Response.json({ status: "error", errorMessage: String(error) }, { status: 400 });
    }
  });
  vi.stubGlobal("fetch", upstream);
  await backend.mutation(api.tracker.pushMatches, { user: "alice", secret, items: [{
    key: "job:1", short, company: "Example", title: "Intern", url: "https://example.com/jobs/1",
    applied: false, saved: false, dismissed: false,
  }] });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("a script can triage, track an application, set and clear dates, then read its state", async () => {
  expect((await request("/ticks", "PUT", { writes: [
    { short, field: "saved", value: true }, { short, field: "applied", value: true },
  ] })).status).toBe(200);
  expect((await request(`/applications/${short}/status`, "PUT", { status: "interview", note: "  Tuesday  " })).status).toBe(200);
  expect((await request(`/applications/${short}/due-date`, "PUT", { dueAt: "2026-10-01" })).status).toBe(200);
  expect((await request(`/applications/${short}/snooze`, "PUT", { snoozedUntil: "2026-09-10T09:00:00-04:00" })).status).toBe(200);
  const { data: rows } = await (await request("/applications")).json();
  expect(rows).toEqual([expect.objectContaining({ short, status: "interview", note: "Tuesday", dueAt: "2026-10-01" })]);
  expect(rows[0].history).toHaveLength(2);
  const matches = await (await request("/matches")).json();
  expect(matches.data[0]).toMatchObject({ short, applied: true, saved: true });
  expect((await request(`/applications/${short}/due-date`, "PUT", { dueAt: null })).status).toBe(200);
  const cleared = await (await request("/applications")).json();
  expect(cleared.data[0].dueAt).toBeUndefined();
  expect((await (await request("/applications", "GET", undefined, otherKey)).json()).data).toEqual([]);
});

test("deadlines on missing applications return 404, without inventing an application", async () => {
  for (const [path, body] of [["due-date", { dueAt: "2026-10-01" }], ["snooze", { snoozedUntil: null }]] as const) {
    const response = await request(`/applications/${short}/${path}`, "PUT", body);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
  }
  expect((await (await request("/applications")).json()).data).toEqual([]);
});

test("profile, preferences and model writes round-trip and remain private", async () => {
  const profile = { version: 2, header: { name: "Alice" }, sections: [], skills: {} };
  expect((await request("/profile", "PUT", { profile })).status).toBe(200);
  expect((await (await request("/profile")).json()).data).toEqual(profile);
  expect((await (await request("/profile", "GET", undefined, otherKey)).json()).data).toBeNull();
  expect((await request("/preferences", "PUT", { watch: { location: { remoteCounts: true } } })).status).toBe(200);
  expect((await (await request("/preferences")).json()).data.watch).toEqual({ location: { remoteCounts: true } });
  expect((await request("/resume-model", "PUT", { provider: "openrouter", model: "example/model" })).status).toBe(200);
  expect((await (await request("/resume-model")).json()).data).toMatchObject({ provider: "openrouter", model: "example/model" });
});

test("job ingestion can be started and polled only by its owner", async () => {
  const started = await request("/ingests", "POST", { url: "https://example.com/jobs/2" });
  expect(started.status).toBe(202);
  const { data } = await started.json();
  expect((await request(`/ingests/${data.ingestId}`)).status).toBe(200);
  expect((await request(`/ingests/${data.ingestId}`, "GET", undefined, otherKey)).status).toBe(404);
});

test("resume preconditions, saved job descriptions and build polling preserve backend semantics", async () => {
  expect((await request(`/resumes/${short}/build`, "POST", {})).status).toBe(409);
  expect((await request(`/matches/${short}/job-description`, "PUT", { jdText: "Build reliable APIs." })).status).toBe(200);
  expect((await (await request(`/matches/${short}/job-description`)).json()).data.text).toBe("Build reliable APIs.");
  expect((await request("/profile", "PUT", { profile: { header: { name: "Alice" } } })).status).toBe(200);
  expect((await request(`/resumes/${short}/build`, "POST", {})).status).toBe(202);
  expect((await (await request(`/resumes/${short}`)).json()).data).toEqual({ build: "building", resume: null });
  expect((await request(`/resumes/${short}/restore`, "POST", {})).status).toBe(409);
  expect((await request(`/resumes/${short}`, "DELETE")).status).toBe(404);
});

test("authentication rejects missing, revoked and malformed keys without contacting Convex", async () => {
  for (const token of ["", "wrong", `iw_${"x".repeat(43)}`]) {
    const response = await request("/me", "GET", undefined, token);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(response.headers.get("location")).toBeNull();
  }
  vi.stubEnv("TRACKER_API_KEYS", "[]");
  expect((await request("/me")).status).toBe(401);
  expect(upstream).not.toHaveBeenCalled();
});

test.each(["", "{broken", '[{"sha256":"invalid","user":"alice","access":"write"}]'])("bad or absent key configuration fails closed: %s", async (config) => {
  vi.stubEnv("TRACKER_API_KEYS", config);
  expect((await request("/me")).status).toBe(503);
  expect(upstream).not.toHaveBeenCalled();
});

describe("every write endpoint enforces its key and body contract", () => {
  test.each(endpoints.filter((endpoint) => endpoint.method !== "GET"))("$method $path rejects read keys and extra fields", async (endpoint) => {
    const path = endpoint.path.replace("{short}", short).replace("{id}", "some-id").replace("{provider}", "openai");
    expect((await request(path, endpoint.method, { user: "bob" }, readKey)).status).toBe(403);
    expect((await request(path, endpoint.method, { user: "bob" })).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });
});

test.each([
  ["/ticks", { writes: [{ short, field: "saved", value: "true" }] }],
  [`/applications/${short}/status`, { status: "ghosted" }],
  [`/applications/${short}/due-date`, { dueAt: "2026-02-30" }],
  ["/preferences", { watch: { location: { remoteCounts: "true" } } }],
])("invalid domain input does not write: %s", async (path, body) => {
  expect((await request(path, "PUT", body)).status).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
});

test("malformed, oversized and wrongly typed requests have useful HTTP errors", async () => {
  for (const [body, type, code] of [["{", "application/json", 400], ["{}", "text/plain", 415], [" ".repeat(2 * 1024 * 1024 + 1), "application/json", 413]] as const) {
    const response = await handleApiRequest(new Request("https://app.example/api/v1/profile", {
      method: "PUT", headers: { Authorization: `Bearer ${key}`, "Content-Type": type }, body,
    }), ["profile"]);
    expect(response.status).toBe(code);
  }
  expect((await request("/profile", "PATCH", {})).status).toBe(405);
  expect((await request("/missing")).status).toBe(404);
  expect(upstream).not.toHaveBeenCalled();
});

test("backend failures do not expose credentials or stack traces", async () => {
  upstream.mockRejectedValueOnce(new Error("secret=do-not-leak stacktrace"));
  const response = await request("/profile");
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("do-not-leak");
});

test.each(["build", "restore"])("malformed backend %s responses never report success", async (operation) => {
  upstream.mockResolvedValueOnce(Response.json({ status: "success", value: {} }));
  expect((await request(`/resumes/${short}/${operation}`, "POST", {})).status).toBe(502);
});

test("inbox resolution is scoped to the owner and writes application history", async () => {
  const id = await backend.run((ctx) => ctx.db.insert("inboxActions", {
    user: "alice", gmailMessageId: "message-1", threadId: "thread-1", accountEmail: "alice@example.com",
    from: "recruiter@example.com", subject: "Interview", receivedAt: "2026-09-07T10:00:00Z",
    signal: "interview", evidence: "Interview invitation", source: "regex", state: "pending",
    createdAt: "2026-09-07T10:00:00Z", candidates: [{ short, company: "Example", title: "Intern", score: 1 }],
  }));
  expect((await request(`/inbox/${id}/resolve`, "POST", {})).status).toBe(400);
  expect((await request(`/inbox/${id}/resolve`, "POST", { dismiss: true }, otherKey)).status).toBe(404);
  expect((await request(`/inbox/${id}/resolve`, "POST", { short, status: "interview" })).status).toBe(200);
  expect((await (await request("/inbox")).json()).data.actions).toEqual([]);
  expect((await (await request("/applications")).json()).data[0].status).toBe("interview");
  expect((await request(`/inbox/${id}/resolve`, "POST", { dismiss: true })).status).toBe(409);
});

test("provider secrets are encrypted, never returned, and can be removed", async () => {
  vi.stubEnv("CREDENTIALS_KEY", Buffer.alloc(32, 1).toString("base64"));
  const apiKey = "private-provider-key-do-not-return";
  expect((await request("/connections/openai", "PUT", { fields: { apiKey } })).status).toBe(200);
  const listing = await (await request("/connections")).text();
  expect(listing).not.toContain(apiKey);
  expect(JSON.parse(listing).data.credentials).toHaveLength(1);
  expect((await (await request("/connections", "GET", undefined, otherKey)).json()).data.credentials).toEqual([]);
  const row = await backend.run((ctx) => ctx.db.query("credentials").first());
  expect(JSON.stringify(row)).not.toContain(apiKey);
  expect((await request("/connections/openai", "DELETE")).status).toBe(200);
  expect((await (await request("/connections")).json()).data.credentials).toEqual([]);
});

test("profile export returns downloadable bytes instead of a JSON envelope", async () => {
  upstream.mockResolvedValueOnce(Response.json({ status: "success", value: {
    base64: Buffer.from("%PDF-test").toString("base64"), contentType: "application/pdf", filename: "resume.pdf",
  } }));
  const response = await request("/profile/export", "POST", { profile: { header: { name: "Alice" } }, format: "pdf" });
  expect(response.headers.get("content-type")).toBe("application/pdf");
  expect(response.headers.get("content-disposition")).toContain('filename="resume.pdf"');
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("%PDF-test");
});

test("resume polling reads download metadata after build status to avoid stale completed builds", async () => {
  let releaseStatus!: () => void;
  let statusStarted!: () => void;
  const gate = new Promise<void>((resolve) => { releaseStatus = resolve; });
  const started = new Promise<void>((resolve) => { statusStarted = resolve; });
  upstream.mockImplementation(async (_url: string, init: RequestInit) => {
    const { path } = JSON.parse(String(init.body));
    if (path === "resume:getBuildStatus") {
      statusStarted();
      await gate;
      return Response.json({ status: "success", value: null });
    }
    expect(path).toBe("tracker:getResumeUrls");
    return Response.json({ status: "success", value: [{ short, url: "https://example.com/new-resume.pdf", filename: "new-resume.pdf", format: "pdf" }] });
  });
  const pending = request(`/resumes/${short}`);
  await started;
  const callsBeforeStatus = upstream.mock.calls.length;
  releaseStatus();
  const response = await pending;
  expect(callsBeforeStatus).toBe(1);
  expect((await response.json()).data).toMatchObject({ build: null, resume: { url: "https://example.com/new-resume.pdf" } });
});

test("OpenAPI covers all operations and HEAD returns no body", async () => {
  const doc = openApiDocument();
  expect(Object.values(doc.paths).reduce((count, methods) => count + Object.keys(methods).length, 0)).toBe(endpoints.length);
  const response = await request("/openapi.json", "GET", undefined, readKey);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()).openapi).toBe("3.1.0");
  expect(await (await request("/me", "HEAD")).text()).toBe("");
});
