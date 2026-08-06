import type { DatabaseWriter } from "./_generated/server";

// Shared application-ledger write, extracted from tracker.ts recordStatus so
// the mail-sync paths (auto-applied statuses, resolved inbox actions) and the
// TrackerStore driver write history through ONE implementation.
//
// Semantics (mirroring src/ledger.py set_status):
//  - repeating the current status with the same note is a no-op, not history
//    spam;
//  - a new status (or a new note) appends a history entry and moves `status`;
//  - a missing application row is created on first write.
//
// Snapshot backfill: when neither the caller nor the existing row carries a
// display snapshot, the matches table is consulted for the (user, short) item
// so a record created by mail-sync (or the webui status path) never renders
// blank in the tracker.
export async function applyStatus(
  db: DatabaseWriter,
  {
    user,
    short,
    status,
    note,
    snapshot,
  }: {
    user: string;
    short: string;
    status: string;
    note?: string;
    snapshot?: unknown;
  },
): Promise<void> {
  const entry: { status: string; at: string; note?: string } = {
    status,
    at: new Date().toISOString(),
  };
  if (note) {
    entry.note = note;
  }
  const existing = await db
    .query("applications")
    .withIndex("by_user_short", (q) => q.eq("user", user).eq("short", short))
    .first();

  if (snapshot === undefined && (!existing || existing.snapshot === undefined)) {
    const match = await db
      .query("matches")
      .withIndex("by_user_short", (q) => q.eq("user", user).eq("short", short))
      .first();
    if (match) {
      snapshot = match.item;
    }
  }

  if (existing) {
    const history = existing.history ?? [];
    const last = history[history.length - 1];
    // Repeating the current status without a change is a no-op rather than
    // history spam (mirrors src/ledger.py set_status).
    if (last && last.status === status && (last.note ?? "") === (note ?? "")) {
      return;
    }
    history.push(entry);
    const patch: Record<string, unknown> = { status, history };
    if (note !== undefined) {
      patch.note = note;
    }
    if (snapshot !== undefined) {
      patch.snapshot = snapshot;
    }
    await db.patch(existing._id, patch);
  } else {
    await db.insert("applications", {
      user,
      short,
      status,
      note,
      history: [entry],
      snapshot,
      createdAt: new Date().toISOString(),
    });
  }
}
