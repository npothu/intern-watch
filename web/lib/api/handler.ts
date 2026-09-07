import "server-only";
import { z } from "zod";
import { authenticate, ApiError } from "./auth";
import { endpoints, parameterSchemas } from "./endpoints";
import { ConvexError } from "../convex";

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const responseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

/** Bound the bytes actually read, including chunked requests with no Content-Length. */
async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES) {
    throw new ApiError(413, "payload_too_large", "Request body must be 2 MiB or smaller.");
  }
  if (!request.body) return {};
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new ApiError(415, "unsupported_media_type", "Use Content-Type: application/json.");
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError(413, "payload_too_large", "Request body must be 2 MiB or smaller.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_json", "Send a valid UTF-8 JSON body.");
  } finally {
    reader.releaseLock();
  }
}

function matchPath(template: string, path: string): Record<string, string> | null {
  const expected = template.split("/");
  const actual = path.split("/");
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < expected.length; i++) {
    const name = /^\{(\w+)\}$/.exec(expected[i])?.[1];
    if (name) params[name] = actual[i];
    else if (expected[i] !== actual[i]) return null;
  }
  return params;
}

export function openApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const endpoint of endpoints) {
    const binary = endpoint.path === "/profile/export";
    const parameters = [...endpoint.path.matchAll(/\{(\w+)\}/g)].map((match) => ({
      name: match[1], in: "path", required: true,
      schema: z.toJSONSchema(parameterSchemas[match[1]], { io: "input" }),
    }));
    paths[endpoint.path] ??= {};
    paths[endpoint.path][endpoint.method.toLowerCase()] = {
      operationId: `${endpoint.method.toLowerCase()}_${endpoint.path.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "")}`,
      summary: endpoint.summary,
      parameters,
      ...(endpoint.method === "GET" || endpoint.method === "DELETE" ? {} : {
        requestBody: {
          required: !endpoint.schema.safeParse({}).success,
          content: { "application/json": { schema: z.toJSONSchema(endpoint.schema, { io: "input" }) } },
        },
      }),
      responses: {
        [endpoint.status]: {
          description: binary ? "The rendered resume file." : "Result wrapped in { data: ... }. See docs/api.md for response shapes.",
          content: binary ? {
            "application/pdf": { schema: { type: "string", format: "binary" } },
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { schema: { type: "string", format: "binary" } },
          } : { "application/json": { schema: { type: "object", required: ["data"], properties: { data: {} } } } },
        },
        default: { description: "An API error.", content: { "application/json": { schema: {
          type: "object", required: ["error"], properties: { error: {
            type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" } },
          } },
        } } } },
      },
    };
  }
  return {
    openapi: "3.1.0", info: { title: "intern-watch script API", version: "1.0.0" },
    servers: [{ url: "/api/v1" }],
    security: [{ bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "iw_ API key" } } },
    paths,
  };
}

export async function handleApiRequest(request: Request, segments: string[]): Promise<Response> {
  try {
    const principal = authenticate(request);
    const method = request.method === "HEAD" ? "GET" : request.method;
    const path = `/${segments.join("/")}`;
    if (new URL(request.url).search) throw new ApiError(400, "invalid_request", "This API does not accept query parameters.");
    if (method === "GET" && (path === "/" || path === "/openapi.json")) {
      return Response.json(openApiDocument(), { headers: responseHeaders });
    }
    const candidates = endpoints.flatMap((endpoint) => {
      const params = matchPath(endpoint.path, path);
      return params ? [{ endpoint, params }] : [];
    });
    if (!candidates.length) throw new ApiError(404, "not_found", "API endpoint not found.");
    const route = candidates.find(({ endpoint }) => endpoint.method === method);
    if (!route) {
      const allow = [...new Set(candidates.map(({ endpoint }) => endpoint.method))];
      return Response.json({ error: { code: "method_not_allowed", message: "Method not allowed for this endpoint." } }, {
        status: 405, headers: { ...responseHeaders, Allow: allow.join(", ") },
      });
    }
    if (method !== "GET" && principal.access !== "write") {
      throw new ApiError(403, "forbidden", "This API key has read-only access.");
    }
    const params = Object.fromEntries(Object.entries(route.params).map(([key, value]) => [key, parameterSchemas[key].parse(value)]));
    const body = method === "GET" ? {} : await readBody(request);
    const data = await route.endpoint.run(principal.user, params, body);
    const response = data instanceof Response ? data : Response.json({ data: data ?? null }, { status: route.endpoint.status });
    for (const [key, value] of Object.entries(responseHeaders)) response.headers.set(key, value);
    return response;
  } catch (error) {
    let failure: ApiError;
    if (error instanceof ApiError) failure = error;
    else if (error instanceof z.ZodError) {
      const message = error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
      failure = new ApiError(400, "invalid_request", message);
    } else if (error instanceof ConvexError && /Error: not found(?:\n|$)/.test(error.message)) {
      failure = new ApiError(404, "not_found", "The requested item was not found.");
    } else if (error instanceof ConvexError && /Error: already resolved(?:\n|$)/.test(error.message)) {
      failure = new ApiError(409, "conflict", "This inbox action has already been resolved.");
    } else if (error instanceof ConvexError && /rate limited: too many requests/.test(error.message)) {
      failure = new ApiError(429, "rate_limited", "Job ingestion rate limit reached. Try again later.");
    } else {
      // Convex error messages can contain argument values, including credentials.
      failure = new ApiError(502, "backend_error", "The backend could not complete this request.");
    }
    return Response.json({ error: { code: failure.code, message: failure.message } }, {
      status: failure.status,
      headers: { ...responseHeaders, ...(failure.status === 401 ? { "WWW-Authenticate": "Bearer" } : {}) },
    });
  }
}
