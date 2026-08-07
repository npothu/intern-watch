import type { LedgerRecord, MatchItem, ResumeUrls } from "@/lib/convex";
import { shortKey } from "@/lib/shortkey";
import { entryDate, lastNoteOf } from "@/components/tracker/tracker-lib";
import type { HistoryEntry, TrackerRow } from "@/components/tracker/tracker-lib";

/**
 * Join a user's ledger records with their display snapshots and built resume
 * URLs into the flat row list the tracker renders.
 *
 * A ledger record carries a `snapshot` (the match row copied in at apply
 * time, so the record outlives the match). Records created before snapshots
 * existed, or by the mail-sync path, fall back to the flat record fields and
 * then to the live match row (by short key).
 *
 * The ledger can arrive either as a Record<short, record> (the file-store
 * shape) or an array of { short, ... } rows (the Convex shape); both are
 * normalized here.
 */

type LedgerValue = Record<string, LedgerRecord>;
type LedgerArray = Array<{ short?: string; [k: string]: unknown }>;
type RawLedger = LedgerValue | LedgerArray;

interface LedgerRec {
  short?: string;
  status?: unknown;
  applied?: unknown;
  createdAt?: unknown;
  history?: unknown;
  snapshot?: unknown;
  company?: unknown;
  title?: unknown;
  location?: unknown;
  url?: unknown;
}

function entriesOf(ledger: RawLedger): Array<[string, LedgerRec]> {
  if (Array.isArray(ledger)) {
    const out: Array<[string, LedgerRec]> = [];
    for (const r of ledger) {
      if (!r) continue;
      const short = asStrings(r.short);
      if (short) out.push([short, r as unknown as LedgerRec]);
    }
    return out;
  }
  return Object.entries(ledger as LedgerValue).map(([short, rec]) => [
    short,
    rec as unknown as LedgerRec,
  ]);
}

function asStrings(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function snapshotOf(rec: LedgerRec): LedgerRec | null {
  const snap = rec.snapshot;
  if (snap && typeof snap === "object" && !Array.isArray(snap)) {
    return snap as LedgerRec;
  }
  return null;
}

function historyOf(rec: LedgerRec): HistoryEntry[] {
  if (!Array.isArray(rec.history)) return [];
  const out: HistoryEntry[] = [];
  for (const e of rec.history) {
    if (e && typeof e === "object") {
      const s = e as Record<string, unknown>;
      const status = asStrings(s.status);
      if (status) {
        out.push({
          on: asStrings(s.on) || undefined,
          at: asStrings(s.at) || undefined,
          status,
          note: asStrings(s.note) || undefined,
        });
      }
    }
  }
  return out;
}

export function buildTrackerRows(
  ledger: RawLedger,
  matches: MatchItem[],
  resumeUrls: ResumeUrls
): TrackerRow[] {
  // Index matches by short key for the display fallback.
  const byShort = new Map<string, MatchItem>();
  for (const m of matches) {
    const s = m.short ?? shortKey(m.key);
    if (s && !byShort.has(s)) byShort.set(s, m);
  }

  const rows: TrackerRow[] = [];
  for (const [short, rec] of entriesOf(ledger)) {
    const snap = snapshotOf(rec) ?? {
      company: rec.company,
      title: rec.title,
      location: rec.location,
      url: rec.url,
    };
    let company = asStrings(snap.company);
    let title = asStrings(snap.title);
    let url = asStrings(snap.url);
    // Only the search box reads location, so an absent one just narrows what
    // the query can match - never a reason to fall back to the live match row.
    let location = asStrings(snap.location);
    if (!company && !title) {
      const match = byShort.get(short);
      if (match) {
        company = match.company;
        title = match.title;
        url = match.url;
        location = location || match.location;
      }
    }

    const history = historyOf(rec);
    const appliedDate =
      (history[0] ? entryDate(history[0]) : "") ||
      asStrings(rec.applied) ||
      asStrings(rec.createdAt) ||
      "";
    const lastActivity = history.length
      ? entryDate(history[history.length - 1])
      : appliedDate;

    rows.push({
      short,
      status: asStrings(rec.status) || "applied",
      appliedDate,
      lastActivity,
      lastNote: lastNoteOf(history),
      history,
      company,
      title,
      location,
      url,
      resumeUrl: resumeUrls[short],
    });
  }

  // Newest activity first, then company - matches the webui's sort.
  rows.sort(
    (a, b) =>
      b.lastActivity.localeCompare(a.lastActivity) ||
      a.company.localeCompare(b.company)
  );
  return rows;
}
