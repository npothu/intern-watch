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

/**
 * Whether the current request may write deployment-wide configuration (the
 * Google wizard's GMAIL_* / MAIL_* env vars).
 *
 * Admins are ADMIN_TRACKER_USERS: a comma-separated list of tracker user keys,
 * the same keys TRACKER_USER_MAP resolves. Passing the already-resolved key
 * avoids a second Clerk lookup on the actions that already have it.
 *
 * UNSET deliberately means "everyone is an admin": a single-user deployment
 * that never declares the list would otherwise dead-end its only user in the
 * wizard, since that user IS the admin. The list being set is the deployment
 * declaring itself multi-user, and from then on only listed keys can write.
 */
export async function isAdminUser(user: string | null = null): Promise<boolean> {
  const raw = process.env.ADMIN_TRACKER_USERS;
  if (!raw) return true; // single-user deployment - never lock the solo admin out
  const admins = raw
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (admins.length === 0) return true; // empty list -> treat as unset
  const key = user ?? (await resolveTrackerUser());
  return key !== null && admins.includes(key);
}
