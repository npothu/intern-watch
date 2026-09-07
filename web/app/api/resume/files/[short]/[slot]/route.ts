import { resolveTrackerUser } from "@/lib/user";
import { authenticate, ApiError } from "@/lib/api/auth";
import { downloadResumeFile } from "@/lib/convex";

export async function GET(request: Request, context: { params: Promise<{ short: string; slot: string }> }) {
  try {
    const user = request.headers.has("Authorization") ? authenticate(request).user : await resolveTrackerUser();
    if (!user) return new Response(null, { status: 401, headers: { "Cache-Control": "no-store" } });
    const { short, slot } = await context.params;
    if (!/^[0-9a-f]{12}$/.test(short) || !["current", "docx", "previous", "previous-docx"].includes(slot)) {
      return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    return await downloadResumeFile(user, short, slot);
  } catch (error) {
    return new Response(null, { status: error instanceof ApiError ? error.status : 502, headers: { "Cache-Control": "no-store" } });
  }
}
