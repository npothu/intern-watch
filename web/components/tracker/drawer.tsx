"use client";

// The application detail drawer: one slide-out surface consolidating what
// used to be (or would have become) separate dialogs - status, timeline,
// mail evidence, resume link, deadline, snooze, quick note. Hidden until
// pulled out from a row's "details" action; Escape or scrim click closes.
//
// Mounted persistently so the open/close transform can animate both ways;
// the last non-null row stays rendered during the slide-out.

import { useEffect, useState } from "react";
import { ExternalLink, FileText, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  STATUS_LABELS,
  STATUS_ORDER,
  dueInDays,
  entryDate,
  formatDate,
  isSnoozed,
  waitingDays,
  type HistoryEntry,
  type TrackerRow,
  type TrackerStatus,
} from "@/components/tracker/tracker-lib";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";

const URL_RE = /(https?:\/\/[^\s"]+)/g;

/** Render a history note with its embedded URLs (Gmail deep links from the
 * mail-sync path) turned into real links. */
function Linkify({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a
            key={i}
            href={p}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline-offset-3 hover:underline"
          >
            {p.includes("mail.google.com") ? "open in Gmail" : p}
            <ExternalLink className="mb-0.5 ml-0.5 inline size-3" />
          </a>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-dashed border-line-2 py-3 first:border-t-0 first:pt-0">
      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-2">
        {label}
      </div>
      {children}
    </div>
  );
}

export function ApplicationDrawer({
  row,
  onOpenChange,
  onStatus,
  onNote,
  onDueAt,
  onSnooze,
}: {
  row: TrackerRow | null;
  onOpenChange: (open: boolean) => void;
  onStatus: (short: string, status: string) => void;
  onNote: (short: string, note: string) => void;
  onDueAt: (short: string, dueAt: string | null) => void;
  onSnooze: (short: string, until: string | null) => void;
}) {
  const open = row !== null;
  // Keep the last row rendered through the 280ms slide-out.
  const [shown, setShown] = useState<TrackerRow | null>(row);
  if (row && row !== shown) setShown(row);
  useEffect(() => {
    if (!row) {
      const t = window.setTimeout(() => setShown(null), 300);
      return () => window.clearTimeout(t);
    }
  }, [row]);

  const [note, setNote] = useState("");
  const [due, setDue] = useState("");
  // Reset drafts when a different application opens - a render-phase state
  // adjustment keyed on the row, same pattern as the tracker's NoteDialog.
  const [lastShort, setLastShort] = useState<string | null>(null);
  if (shown && shown.short !== lastShort) {
    setLastShort(shown.short);
    setNote("");
    setDue(shown.dueAt ?? "");
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  const history: HistoryEntry[] = shown ? [...shown.history].reverse() : [];
  const evidence = history.filter((e) => e.note && /from email:/i.test(e.note));
  const wd = shown ? waitingDays(shown) : 0;
  const dd = shown ? dueInDays(shown) : null;

  return (
    <>
      {/* Scrim */}
      <div
        aria-hidden
        onClick={() => onOpenChange(false)}
        className={cn(
          "fixed inset-0 z-[60] bg-black/35 transition-opacity duration-300",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
      />
      {/* Panel */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={shown ? `${shown.company} application details` : "Application details"}
        className={cn(
          "fixed inset-y-0 right-0 z-[61] w-[min(440px,94vw)] overflow-y-auto border-l border-line-2 bg-surface px-5 py-4 shadow-xl transition-transform duration-300 ease-[var(--ease-out-soft)]",
          open ? "translate-x-0" : "translate-x-[105%]"
        )}
      >
        {shown && (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-[15.5px] font-semibold leading-snug text-ink">
                  {shown.company}
                </h2>
                {shown.title && (
                  <a
                    href={shown.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-0.5 block truncate text-[12.5px] text-ink-2 underline-offset-3 hover:text-accent hover:underline"
                    title={shown.title}
                  >
                    {shown.title}
                    <ExternalLink className="mb-0.5 ml-1 inline size-3" />
                  </a>
                )}
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label="Close details"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-2 transition-colors hover:bg-chip hover:text-ink"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="mb-1 mt-2.5 flex flex-wrap items-center gap-1.5">
              <Select
                value={shown.status}
                onValueChange={(s) => onStatus(shown.short, s)}
              >
                <SelectTrigger className="h-7 w-[128px] rounded-full border border-line-2 bg-surface px-3 text-[12.5px] font-medium">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_ORDER.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {dd !== null && (
                <span
                  className={cn(
                    "rounded-full px-2 py-px text-[10.5px] font-semibold",
                    dd < 0
                      ? "bg-[color-mix(in_srgb,var(--color-red)_13%,transparent)] text-red"
                      : dd <= 1
                        ? "bg-[color-mix(in_srgb,var(--color-red)_10%,transparent)] text-red"
                        : "bg-[color-mix(in_srgb,var(--color-amber)_12%,transparent)] text-amber"
                  )}
                >
                  {dd < 0
                    ? `overdue ${-dd}d`
                    : dd === 0
                      ? "due today"
                      : dd === 1
                        ? "due tomorrow"
                        : `due in ${dd}d`}
                </span>
              )}
              {wd >= 10 && (
                <span className="rounded-full bg-amber/12 px-2 py-px text-[10.5px] font-medium text-amber">
                  quiet {wd}d
                </span>
              )}
              {shown && isSnoozed(shown) && (
                <span className="rounded-full bg-chip px-2 py-px text-[10.5px] font-medium text-ink-2">
                  snoozed until {formatDate(shown.snoozedUntil ?? "")}
                </span>
              )}
            </div>

            <div className="mt-3">
              <Section label="Timeline">
                {history.length === 0 ? (
                  <p className="text-[12.5px] text-ink-2">No history yet.</p>
                ) : (
                  <ul className="max-h-[30vh] overflow-y-auto">
                    {history.map((e, i) => (
                      <li
                        key={i}
                        className="grid grid-cols-[58px_minmax(0,1fr)] gap-2 py-1 text-[12.5px]"
                      >
                        <span className="tabular-nums text-ink-2">
                          {formatDate(entryDate(e))}
                        </span>
                        <span className="min-w-0 text-ink">
                          {STATUS_LABELS[e.status as TrackerStatus] ?? e.status}
                          {e.note && (
                            <span className="text-ink-2">
                              {" "}
                              - <Linkify text={e.note} />
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              {evidence.length > 0 && (
                <Section label="Mail evidence">
                  {evidence.map((e, i) => (
                    <div
                      key={i}
                      className="mb-1.5 rounded-md bg-chip px-2.5 py-1.5 text-[12px] text-ink-2 last:mb-0"
                    >
                      <Linkify text={e.note ?? ""} />
                    </div>
                  ))}
                </Section>
              )}

              {shown.resumeUrl && (
                <Section label="Resume">
                  <a
                    href={shown.resumeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-7 items-center gap-1.5 rounded-[5px] border border-[color-mix(in_srgb,var(--color-accent)_42%,transparent)] bg-surface px-2.5 text-[12px] font-medium text-accent transition-colors hover:border-ink-2"
                  >
                    <FileText className="size-3.5" />
                    download tailored resume
                  </a>
                </Section>
              )}

              <Section label="Deadline">
                <div className="flex flex-wrap items-center gap-1.5">
                  <input
                    type="date"
                    value={due}
                    onChange={(e) => setDue(e.target.value)}
                    aria-label="Deadline date"
                    className="rounded-md border border-line-2 bg-bg px-2.5 py-1 text-[12.5px] text-ink outline-none transition-colors focus:border-accent"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={due === (shown.dueAt ?? "")}
                    onClick={() => onDueAt(shown.short, due || null)}
                  >
                    {due ? "Save" : shown.dueAt ? "Clear" : "Save"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-ink-2"
                    onClick={() => {
                      const until = new Date(Date.now() + 3 * 864e5)
                        .toISOString()
                        .slice(0, 10);
                      onSnooze(shown.short, until);
                    }}
                  >
                    Snooze 3d
                  </Button>
                  {isSnoozed(shown) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-ink-2"
                      onClick={() => onSnooze(shown.short, null)}
                    >
                      Unsnooze
                    </Button>
                  )}
                </div>
              </Section>

              <Section label="Add note">
                <div className="flex gap-1.5">
                  <input
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && note.trim()) {
                        onNote(shown.short, note.trim());
                        setNote("");
                      }
                    }}
                    placeholder="e.g. OA due Friday, recruiter: Sam"
                    className="w-full min-w-0 flex-1 rounded-md border border-line-2 bg-bg px-3 py-1.5 text-[12.5px] text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-accent"
                  />
                  <Button
                    size="sm"
                    disabled={!note.trim()}
                    onClick={() => {
                      onNote(shown.short, note.trim());
                      setNote("");
                    }}
                  >
                    Save
                  </Button>
                </div>
              </Section>
            </div>
          </>
        )}
      </aside>
    </>
  );
}
