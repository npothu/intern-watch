import "server-only";
import { currentUser } from "@clerk/nextjs/server";

/**
 * Resolve the signed-in Clerk user to a tracker user key, or null.
 *
 * The mapping comes from the TRACKER_USER_MAP env var: a JSON object mapping
 * the user's Clerk primary email -> tracker user key (the key used by the
 * intern-watch pipeline, e.g. {"nathan@example.com":"nathan"}). Read
 * server-side only. A signed-in email absent from the map resolves to null,
 * which callers render as the "not provisioned" screen.
 */

function trackerUserMap(): Record<string, string> {
  const raw = process.env.TRACKER_USER_MAP;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // malformed env -> treat as empty (no users provisioned)
  }
  return {};
}

function clerkConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY &&
      process.env.CLERK_SECRET_KEY
  );
}

/**
 * Returns the tracker user key for the current request, or null when
 * unauthenticated, Clerk isn't configured, or the email isn't provisioned.
 * Never throws - guards everything that would fail without real keys so the
 * build and unauthenticated renders stay green.
 */
export async function resolveTrackerUser(): Promise<string | null> {
  if (!clerkConfigured()) return null;
  let user: Awaited<ReturnType<typeof currentUser>> | null = null;
  try {
    user = await currentUser();
  } catch {
    return null;
  }
  const email = user?.primaryEmailAddress?.emailAddress?.toLowerCase();
  if (!email) return null;
  return trackerUserMap()[email] ?? null;
}
