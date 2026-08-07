"use server";

import { resolveTrackerUser } from "@/lib/user";
import {
  getInboxActions,
  resolveInboxAction as convexResolveAction,
  type InboxState,
} from "@/lib/convex";
import { isTrackerStatus } from "@/components/tracker/tracker-lib";

/**
 * Inbox-page server actions. Every call re-resolves the tracker user
 * server-side (never trusted from the client) so a signed-in user can only
 * read/resolve their own pending actions.
 */

// The first 12 hex chars of a match key's sha1 (see lib/shortkey.ts).
const SHORT_RE = /^[0-9a-f]{12}$/i;

export type FetchInboxResult =
  | ({ ok: true } & InboxState)
  | { ok: false; error: string };

/** Load all pending inbox actions plus linked account health for the user. */
export async function fetchInboxActions(): Promise<FetchInboxResult> {
  const user = await resolveTrackerUser();
  if (!user) {
    return {
      ok: false,
      error: "Not signed in, or this account isn't provisioned.",
    };
  }
  try {
    const state = await getInboxActions(user);
    return { ok: true, ...state };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Couldn't load the inbox." };
  }
}

export type ResolveActionResult = { ok: true } | { ok: false; error: string };

export type ResolveActionOpts = {
  short?: string;
  status?: string;
  dismiss?: boolean;
};

/**
 * Resolve one pending action: either dismiss it, or write an application
 * status through to the ledger. The id must be non-empty; a present short must
 * be 12 hex chars and a present status must be a known ledger status.
 */
export async function resolveAction(
  id: string,
  opts: ResolveActionOpts = {}
): Promise<ResolveActionResult> {
  if (typeof id !== "string" || id.length === 0) {
    return { ok: false, error: "Missing action id." };
  }
  if (
    opts.short !== undefined &&
    (typeof opts.short !== "string" || !SHORT_RE.test(opts.short))
  ) {
    return { ok: false, error: "Invalid application key." };
  }
  if (
    opts.status !== undefined &&
    (typeof opts.status !== "string" || !isTrackerStatus(opts.status))
  ) {
    return { ok: false, error: `Unknown status "${opts.status}".` };
  }
  const user = await resolveTrackerUser();
  if (!user) {
    return {
      ok: false,
      error: "Not signed in, or this account isn't provisioned.",
    };
  }
  try {
    await convexResolveAction(user, {
      id,
      short: opts.short,
      status: opts.status,
      dismiss: opts.dismiss,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || "Couldn't resolve the action." };
  }
}
