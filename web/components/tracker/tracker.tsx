"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Eraser as EraserIcon,
  ExternalLink as ExternalLinkIcon,
  FileText as FileTextIcon,
  Ghost as GhostIcon,
  LayoutList as LayoutListIcon,
  ListChecks as ListChecksIcon,
  Plus as PlusIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  CommandPalette,
  type PaletteAction,
} from "@/components/command-palette";
import { FilterPills, type PillOption } from "@/components/filter-pills";
import { RefreshControl } from "@/components/refresh-control";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updateStatus } from "@/app/(app)/tracker-actions";
import { useAppView } from "@/lib/view";
import {
  GHOST_DAYS,
  STATUS_LABELS,
  STATUS_ORDER,
  WAIT_DAYS,
  entryDate,
  formatDate,
  waitingDays,
} from "@/components/tracker/tracker-lib";
import type {
  HistoryEntry,
  TrackerRow,
  TrackerStatus,
} from "@/components/tracker/tracker-lib";

/**
 * The applications-ledger surface: a funnel bar with a counts line, status
 * pills per application, and row actions (resume link, note, history).
 *
 * Status and note changes commit through the server action optimistically -
 * the row updates in place, rolls back with a toast if the write fails.
 */

/* Funnel segment fill, mirroring the webui's .fb-* colors. */
const FUNNEL_COLOR: Record<string, string> = {
  applied: "bg-accent/75",
  oa: "bg-amber",
  phone_screen: "bg-amber",
  interview: "bg-accent",
  offer: "bg-accent",
  rejected: "bg-red",
  withdrawn: "bg-ink-2/50",
};

/* Status-pill text tone (compact, surface bg, line-2 border per the task's
 * identity; only the label color changes with the status). */
const SELECT_TONE: Record<string, string> = {
  applied: "text-ink",
  oa: "text-amber",
  phone_screen: "text-amber",
  interview: "text-accent",
  offer: "text-accent font-semibold",
  rejected: "text-red",
  withdrawn: "text-ink-2",
};

function labelLower(status: string): string {
  return (STATUS_LABELS[status as TrackerStatus] ?? status).toLowerCase();
}

/** The status-pill value meaning "no status filter". */
const ALL_STATUSES = "__all__";

/**
 * All seven ledger statuses, always, in the progression order src/ledger.py
 * defines - the pill row doubles as the funnel's legend, so a status the user
 * has not reached yet still has to be visible (and clickable) rather than
 * appearing only once something lands in it. Empty ones are dimmed by
 * FilterPills.
 */
function statusPills(rows: TrackerRow[]): PillOption[] {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  return [
    { key: ALL_STATUSES, label: "All", count: rows.length },
    ...STATUS_ORDER.map((s) => ({
      key: s,
      label: STATUS_LABELS[s],
      count: counts.get(s) ?? 0,
    })),
  ];
}

function matchesQuery(row: TrackerRow, q: string): boolean {
  if (!q) return true;
  return `${row.company} ${row.title} ${row.location}`.toLowerCase().includes(q);
}

function Funnel({ rows }: { rows: TrackerRow[] }) {
  const counts: Record<string, number> = {};
  let waiting = 0;
  for (const r of rows) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (waitingDays(r) >= GHOST_DAYS) waiting++;
  }
  const present = STATUS_ORDER.filter((s) => counts[s]);
  if (present.length === 0 && waiting === 0) return null;

  return (
    <div className="mb-5 mt-4">
      <div className="flex h-3.5 overflow-hidden rounded-md border border-line-2">
        {present.map((s) => (
          <span
            key={s}
            className={cn("min-w-[8px]", FUNNEL_COLOR[s])}
            style={{ flex: counts[s] }}
            title={`${counts[s]} ${labelLower(s)}`}
          />
        ))}
      </div>
      <div className="mt-2 text-[12.5px] tabular-nums text-ink-2">
        {present.map((s, i) => (
          <span key={s}>
            {i > 0 && <span className="mx-1">·</span>}
            <b className="font-semibold text-ink">{counts[s]}</b>{" "}
            {labelLower(s)}
          </span>
        ))}
        {waiting > 0 && (
          <>
            {present.length > 0 && <span className="mx-1">·</span>}
            <b className="font-semibold text-ink">{waiting}</b> awaiting
            response
          </>
        )}
      </div>
    </div>
  );
}

function StatusSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (status: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        className={cn(
          "h-7 w-full rounded-full border border-line-2 bg-surface px-3 text-[12.5px] font-medium data-placeholder:text-ink-2 md:w-[128px]",
          SELECT_TONE[value] ?? "text-ink"
        )}
      >
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
  );
}

function WaitingChip({ row }: { row: TrackerRow }) {
  const wd = waitingDays(row);
  if (wd >= GHOST_DAYS) {
    return (
      <span
        className="ml-1.5 inline-block rounded-full bg-amber/15 px-2 py-px text-[10.5px] font-medium text-amber"
        title={`no status change in ${wd} days`}
      >
        no response {wd}d
      </span>
    );
  }
  if (wd >= WAIT_DAYS) {
    return (
      <span
        className="ml-1.5 inline-block rounded-full bg-amber/10 px-2 py-px text-[10.5px] font-medium text-amber"
        title={`no status change in ${wd} days`}
      >
        waiting {wd}d
      </span>
    );
  }
  return null;
}

function TrackerRowView({
  row,
  focused,
  onStatus,
  onNote,
  onHistory,
}: {
  row: TrackerRow;
  /** The row a command-palette jump landed on - washed until the next jump. */
  focused: boolean;
  onStatus: (s: string) => void;
  onNote: () => void;
  onHistory: () => void;
}) {
  return (
    <div
      data-short={row.short}
      className={cn(
        "flex flex-col gap-2 border-t border-line px-3 py-2.5 transition-colors first:border-t-0 md:grid md:grid-cols-[128px_minmax(0,1fr)_auto] md:items-start md:gap-x-3",
        focused && "bg-[color-mix(in_srgb,var(--color-accent)_8%,transparent)]"
      )}
    >
      {/* Company (600), ellipsized title, meta - the approved row anatomy.
          On mobile this leads the row; on desktop it sits in the middle
          column (the status pill is col 1). */}
      <div className="order-1 min-w-0 md:col-start-2 md:order-none">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[13.5px] font-semibold text-ink">
            {row.company}
          </span>
          <WaitingChip row={row} />
        </div>
        {row.title && (
          <a
            href={row.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-0.5 block truncate text-ink-2 transition-colors hover:text-accent hover:underline underline-offset-3"
            title={row.title}
          >
            {row.title}
            <ExternalLinkIcon className="mb-0.5 ml-1 inline size-3 shrink-0" />
          </a>
        )}
        <div className="mt-0.5 text-[11.5px] tabular-nums text-ink-2">
          applied {formatDate(row.appliedDate)} · last activity{" "}
          {formatDate(row.lastActivity)}
          {row.lastNote && (
            <>
              {" "}
              · <span className="italic">{row.lastNote}</span>
            </>
          )}
        </div>
      </div>

      {/* Status pill: col 1 on desktop, full-width under the company line on
          mobile. */}
      <div className="order-2 md:order-none md:col-start-1 md:row-start-1">
        <StatusSelect value={row.status} onChange={onStatus} />
      </div>

      {/* Actions: resume link (built only), note, history. */}
      <div className="order-3 flex items-center gap-1 md:flex-wrap md:col-start-3 md:row-start-1">
        {row.resumeUrl && (
          <a
            href={row.resumeUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Built resume"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-accent/40 px-2.5 text-[12px] font-medium text-accent transition-colors hover:border-accent"
          >
            <FileTextIcon className="size-3.5" />
            resume
          </a>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={onNote}
          className="text-ink-2"
        >
          <PlusIcon className="size-3.5" />
          note
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onHistory}
          className="text-ink-2"
        >
          history
        </Button>
      </div>
    </div>
  );
}

function HistoryDialog({
  row,
  onOpenChange,
}: {
  row: TrackerRow | null;
  onOpenChange: (open: boolean) => void;
}) {
  const history: HistoryEntry[] = row ? [...row.history].reverse() : [];
  return (
    <Dialog open={row !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>
            {row ? `${row.company} - history` : "History"}
          </DialogTitle>
        </DialogHeader>
        {history.length === 0 ? (
          <p className="text-[13px] text-ink-2">No history yet.</p>
        ) : (
          <ul className="max-h-[58vh] overflow-y-auto">
            {history.map((e, i) => (
              <li
                key={i}
                className="grid grid-cols-[76px_120px_minmax(0,1fr)] gap-3 border-t border-dashed border-line px-1 py-2 text-[13px] first:border-t-0"
              >
                <span className="tabular-nums text-ink-2">
                  {formatDate(entryDate(e))}
                </span>
                <span className="text-ink">
                  {STATUS_LABELS[e.status as TrackerStatus] ?? e.status}
                </span>
                <span className="text-ink-2">{e.note ?? ""}</span>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NoteDialog({
  row,
  onOpenChange,
  onSave,
}: {
  row: TrackerRow | null;
  onOpenChange: (open: boolean) => void;
  onSave: (short: string, note: string) => void;
}) {
  const [value, setValue] = useState("");
  const open = row !== null;

  // Reset the draft whenever a different row opens the dialog. This is a
  // render-phase state adjustment (conditional, stable), which React allows.
  const [lastRow, setLastRow] = useState<TrackerRow | null>(null);
  if (row !== lastRow) {
    setLastRow(row);
    if (row) setValue("");
  }

  function submit() {
    if (!row || !value.trim()) return;
    onSave(row.short, value.trim());
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{row ? `${row.company} - note` : "Note"}</DialogTitle>
        </DialogHeader>
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="e.g. OA due Friday, recruiter: Sam"
          className="w-full rounded-md border border-line-2 bg-bg px-3 py-2 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-accent"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!value.trim()}>
            Save note
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmptyState() {
  return (
    <div className="mt-2 rounded-md border border-line bg-surface px-4 py-9 text-center text-[13px] text-ink-2">
      No applications yet - tick a match as applied and it lands here
      permanently.
    </div>
  );
}

export function Tracker({ rows: initialRows }: { rows: TrackerRow[] }) {
  const { show } = useAppView();
  const [rows, setRows] = useState(initialRows);
  const [historyRow, setHistoryRow] = useState<TrackerRow | null>(null);

  // Re-seed from the server whenever it hands over a new array (a refresh, an
  // ingest landing). Without this the optimistic copy taken at mount would
  // outlive every router.refresh() and the page would look frozen. Adjusting
  // state during render, which React allows for exactly this case.
  const [seed, setSeed] = useState(initialRows);
  if (initialRows !== seed) {
    setSeed(initialRows);
    setRows(initialRows);
  }

  const [noteRow, setNoteRow] = useState<TrackerRow | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>(ALL_STATUSES);
  const [focused, setFocused] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();
  // Search first, then pills: each pill counts what it would show given the
  // current search, so the row never advertises results the search excludes.
  const searched = useMemo(
    () => rows.filter((r) => matchesQuery(r, q)),
    [rows, q]
  );
  const pills = useMemo(() => statusPills(searched), [searched]);

  const shown = useMemo(
    () =>
      status === ALL_STATUSES
        ? searched
        : searched.filter((r) => r.status === status),
    [searched, status]
  );

  // Bring a palette jump's row into view once it is actually rendered.
  useEffect(() => {
    if (!focused) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-short="${CSS.escape(focused)}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focused, shown]);

  function clearFilters() {
    setQuery("");
    setStatus(ALL_STATUSES);
  }

  const paletteJumps = useMemo(
    () =>
      rows.map((r) => ({ id: r.short, title: r.company, subtitle: r.title })),
    [rows]
  );

  const paletteActions: PaletteAction[] = [
    {
      id: "matches",
      label: "Go to Matches",
      icon: <LayoutListIcon className="size-4" />,
      run: () => show("matches"),
    },
    {
      id: "tracker",
      label: "Go to Tracker",
      icon: <ListChecksIcon className="size-4" />,
      run: clearFilters,
    },
    {
      id: "hidden",
      label: "Show hidden",
      icon: <GhostIcon className="size-4" />,
      // The hidden list lives on the matches surface, which opens on whatever
      // `?filter=` says - so from here it is a view switch, not a local toggle.
      run: () => show("matches", "hidden"),
    },
    {
      id: "clear",
      label: "Clear filters",
      icon: <EraserIcon className="size-4" />,
      run: clearFilters,
    },
  ];

  function paletteJump(short: string) {
    if (!shown.some((r) => r.short === short)) clearFilters();
    setFocused(short);
  }

  function applyChange(short: string, status: string, note: string) {
    const today = new Date().toISOString();
    return rows.map((r) => {
      if (r.short !== short) return r;
      const entry: HistoryEntry = {
        at: today,
        status,
        ...(note ? { note } : {}),
      };
      const history = r.history.concat(entry);
      return {
        ...r,
        status,
        lastActivity: today.slice(0, 10),
        lastNote: note || r.lastNote,
        history,
      };
    });
  }

  async function commitStatus(short: string, newStatus: string) {
    const prev = rows.find((r) => r.short === short);
    if (!prev || prev.status === newStatus) return;
    const snapshot = rows;
    setRows(applyChange(short, newStatus, ""));
    const res = await updateStatus(short, newStatus, "");
    if (res.ok) {
      toast.success(`${STATUS_LABELS[newStatus as TrackerStatus] ?? newStatus} recorded`);
    } else {
      setRows(snapshot);
      toast.error(res.error);
    }
  }

  async function commitNote(short: string, note: string) {
    const prev = rows.find((r) => r.short === short);
    if (!prev || !note.trim()) return;
    const snapshot = rows;
    setRows(applyChange(short, prev.status, note.trim()));
    const res = await updateStatus(short, prev.status, note.trim());
    if (res.ok) {
      toast.success("Note saved");
    } else {
      setRows(snapshot);
      toast.error(res.error);
    }
  }

  return (
    <div>
      <Funnel rows={rows} />

      <div className="mb-3 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search applications..."
            autoComplete="off"
            aria-label="Search applications"
            className="w-full min-w-[180px] rounded-[5px] border border-line-2 bg-surface px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-2/70 focus:border-accent focus:outline-none sm:w-[280px]"
          />
          <RefreshControl className="ml-auto" />
        </div>
        <FilterPills
          label="Filter by status"
          options={pills}
          value={status}
          onChange={setStatus}
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState />
      ) : shown.length === 0 ? (
        <div className="rounded-md border border-line bg-surface px-4 py-7 text-center text-[13px] text-ink-2">
          Nothing matches the current filters.
          <button
            type="button"
            onClick={clearFilters}
            className="ml-2 cursor-pointer font-medium text-accent underline decoration-dashed underline-offset-2"
          >
            clear filters
          </button>
        </div>
      ) : (
        <div
          ref={listRef}
          className="overflow-hidden rounded-md border border-line bg-surface"
        >
          {shown.map((r) => (
            <TrackerRowView
              key={r.short}
              row={r}
              focused={r.short === focused}
              onStatus={(s) => commitStatus(r.short, s)}
              onNote={() => setNoteRow(r)}
              onHistory={() => setHistoryRow(r)}
            />
          ))}
        </div>
      )}

      <CommandPalette
        jumps={paletteJumps}
        onJump={paletteJump}
        actions={paletteActions}
      />

      <HistoryDialog
        row={historyRow}
        onOpenChange={(o) => {
          if (!o) setHistoryRow(null);
        }}
      />
      <NoteDialog
        row={noteRow}
        onOpenChange={(o) => {
          if (!o) setNoteRow(null);
        }}
        onSave={(short, note) => {
          setNoteRow(null);
          commitNote(short, note);
        }}
      />
    </div>
  );
}
