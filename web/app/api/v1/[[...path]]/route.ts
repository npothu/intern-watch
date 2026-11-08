import { handleApiRequest } from "../../../../lib/api/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// POST /ingests waits up to 20s for the ingest outcome (lib/api/endpoints.ts
// INGEST_WAIT_MS); leave headroom over it on every plan.
export const maxDuration = 60;

async function handle(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const response = await handleApiRequest(request, (await context.params).path ?? []);
  return request.method === "HEAD" ? new Response(null, { status: response.status, headers: response.headers }) : response;
}

export { handle as GET, handle as POST, handle as PUT, handle as DELETE, handle as PATCH, handle as HEAD, handle as OPTIONS };
