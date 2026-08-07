"use server";

import { resolveTrackerUser } from "@/lib/user";
import { recordStatus, setDueAt, setSnooze } from "@/lib/convex";
import {
  isTrackerStatus,
  STATUS_ORDER,
} from "@/components/tracker/tracker-lib";

/**
 * Server action backing the tracker's status select and note field.
 *
 * The user is resolved server-side on every call - never trusted from the
 * client. `short` must be a 12-hex key and `status` must be one of the
 * authoritative ledger STATUSES (ghosted excluded - it is auto-detected, not
 * stored). Rejects unknown input with a structured error so the client can
 * show a toast without relying on a thrown exception.
 */

export type UpdateStatusResult =
  | { ok: true; status: string; note: string }
  | { ok: false; error: string };

const SHORT_RE = /^[0-9a-f]{12}$/i;

export async function updateStatus(
  short: string,
  status: string,
  note: string = ""
): Promise<UpdateStatusResult> {
  if (!SHORT_RE.test(short)) {
    return { ok: false, error: "Invalid application key." };
  }
  if (!isTrackerStatus(status)) {
    return {
      ok: false,
      error: `Unknown status "${status}" (have: ${STATUS_ORDER.join(", ")}).`,
    };
  }
  const user = await resolveTrackerUser();
  if (!user) {
    return {
      ok: false,
      error: "Not signed in, or this account isn't provisioned.",
    };
  }
  const trimmed = note.trim();
  try {
    await recordStatus(user, short, status, trimmed);
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message || "Couldn't save the status.",
    };
  }
  return { ok: true, status, note: trimmed };
}

/** Accepts a yyyy-mm-dd or full ISO datetime; null clears the field. */
function isDateString(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
}

export type UpdateDueAtResult =
  | { ok: true; dueAt: string | null }
  | { ok: false; error: string };

/** Set (or clear) a match's due date. */
export async function updateDueAt(
  short: string,
  dueAt: string | null
): Promise<UpdateDueAtResult> {
  if (!SHORT_RE.test(short)) {
    return { ok: false, error: "Invalid application key." };
  }
  if (dueAt !== null && !isDateString(dueAt)) {
    return { ok: false, error: "dueAt must be an ISO date, or null to clear." };
  }
  const user = await resolveTrackerUser();
  if (!user) {
    return {
      ok: false,
      error: "Not signed in, or this account isn't provisioned.",
    };
  }
  try {
    await setDueAt(user, short, dueAt);
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message || "Couldn't save the due date.",
    };
  }
  return { ok: true, dueAt };
}

export type UpdateSnoozeResult =
  | { ok: true; snoozedUntil: string | null }
  | { ok: false; error: string };

/** Set (or clear) a match's snooze. */
export async function updateSnooze(
  short: string,
  snoozedUntil: string | null
): Promise<UpdateSnoozeResult> {
  if (!SHORT_RE.test(short)) {
    return { ok: false, error: "Invalid application key." };
  }
  if (snoozedUntil !== null && !isDateString(snoozedUntil)) {
    return {
      ok: false,
      error: "snoozedUntil must be an ISO date, or null to clear.",
    };
  }
  const user = await resolveTrackerUser();
  if (!user) {
    return {
      ok: false,
      error: "Not signed in, or this account isn't provisioned.",
    };
  }
  try {
    await setSnooze(user, short, snoozedUntil);
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message || "Couldn't save the snooze.",
    };
  }
  return { ok: true, snoozedUntil };
}
