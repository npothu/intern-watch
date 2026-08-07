"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import {
  ChevronRight as ChevronRightIcon,
  Eraser as EraserIcon,
  ExternalLink as ExternalLinkIcon,
  FileText as FileTextIcon,
  Ghost as GhostIcon,
  LayoutList as LayoutListIcon,
  ListChecks as ListChecksIcon,
  PanelRight as PanelRightIcon,
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
import {
  updateDueAt,
  updateSnooze,
  updateStatus,
} from "@/app/(app)/tracker-actions";
import { ApplicationDrawer } from "@/components/tracker/drawer";
import { useAppView } from "@/lib/view";
import {
  GHOST_DAYS,
  LIVE_STATUSES,
  STATUS_LABELS,
  STATUS_ORDER,
  WAIT_DAYS,
  dueInDays,
  entryDate,
  formatDate,
  isSnoozed,
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

/** Deadline chip: red when overdue/imminent, amber when close, quiet chip
 * otherwise. Sits beside the waiting chip in the row and the drawer. */
function DueChip({ row }: { row: TrackerRow }) {
  const dd = dueInDays(row);
  if (dd === null) return null;
  const label =
    dd < 0
      ? `overdue ${-dd}d`
      : dd === 0
        ? "due today"
        : dd === 1
          ? "due tomorrow"
          : `due in ${dd}d`;
  return (
    <span
      className={cn(
        "ml-1.5 inline-block rounded-full px-2 py-px text-[10.5px] font-semibold",
        dd <= 1
          ? "bg-[color-mix(in_srgb,var(--color-red)_12%,transparent)] text-red"
          : dd <= 4
            ? "bg-[color-mix(in_srgb,var(--color-amber)_12%,transparent)] text-amber"
            : "bg-chip text-ink-2"
      )}
      title={`deadline ${row.dueAt}`}
    >
      {label}
    </span>
  );
}

/**
 * "Needs attention": one collapsible strip above the funnel, two sections -
 * user-entered deadlines (soonest first) and system-computed quiet
 * applications (waitingDays >= WAIT_DAYS on a live status, snooze-aware).
 * Collapsed it costs a single summary line, so the simple tracker view stays
 * simple; the open/closed choice sticks in localStorage. The strip renders
 * nothing at all when nothing needs attention.
 */
const NA_COLLAPSED_KEY = "iw:na-collapsed";
const NA_EVENT = "iw:na-collapsed-change";

/* localStorage as an external store: the server snapshot renders expanded,
 * the client snapshot takes over after hydration without a mismatch. */
function subscribeNa(cb: () => void) {
  window.addEventListener(NA_EVENT, cb);
  return () => window.removeEventListener(NA_EVENT, cb);
}
function readNa(): boolean {
  return localStorage.getItem(NA_COLLAPSED_KEY) === "1";
}

function NeedsAttention({
  rows,
  onOpenRow,
  onFollowUp,
  onSnooze,
  onClearDue,
}: {
  rows: TrackerRow[];
  onOpenRow: (row: TrackerRow) => void;
  onFollowUp: (short: string) => void;
  onSnooze: (short: string) => void;
  onClearDue: (short: string) => void;
}) {
  const collapsed = useSyncExternalStore(subscribeNa, readNa, () => false);
  function toggle() {
    localStorage.setItem(NA_COLLAPSED_KEY, collapsed ? "0" : "1");
    window.dispatchEvent(new Event(NA_EVENT));
  }

  const live = (r: TrackerRow) => LIVE_STATUSES.has(r.status as TrackerStatus);
  const deadlines = rows
    .filter((r) => live(r) && dueInDays(r) !== null)
    .sort((a, b) => (dueInDays(a) ?? 0) - (dueInDays(b) ?? 0));
  const withDue = new Set(deadlines.map((r) => r.short));
  const quiet = rows
    .filter(
      (r) =>
        live(r) &&
        !withDue.has(r.short) &&
        !isSnoozed(r) &&
        waitingDays(r) >= WAIT_DAYS
    )
    .sort((a, b) => waitingDays(b) - waitingDays(a));

  if (deadlines.length === 0 && quiet.length === 0) return null;

  const urgent = deadlines.filter((r) => (dueInDays(r) ?? 99) <= 1).length;

  return (
    <div className="mt-4 overflow-hidden rounded-md border border-[color-mix(in_srgb,var(--color-amber)_35%,var(--color-line))] bg-[color-mix(in_srgb,var(--color-amber)_5%,var(--color-surface))]">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-[12.5px]"
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-ink-2 transition-transform duration-200",
            !collapsed && "rotate-90"
          )}
        />
        <b className="font-semibold text-amber">Needs attention</b>
        <span className="flex flex-wrap items-center gap-1.5 text-ink-2">
          {deadlines.length > 0 && (
            <span
              className={cn(
                "rounded-full px-2 py-px text-[10.5px] font-semibold",
                urgent > 0
                  ? "bg-[color-mix(in_srgb,var(--color-red)_12%,transparent)] text-red"
                  : "bg-[color-mix(in_srgb,var(--color-amber)_12%,transparent)] text-amber"
              )}
            >
              {deadlines.length} deadline{deadlines.length > 1 ? "s" : ""}
            </span>
          )}
          {quiet.length > 0 && (
            <span className="rounded-full bg-[color-mix(in_srgb,var(--color-amber)_12%,transparent)] px-2 py-px text-[10.5px] font-semibold text-amber">
              {quiet.length} quiet {WAIT_DAYS}d+
            </span>
          )}
        </span>
      </button>
      {/* Grid-rows collapse so opening/closing folds instead of popping. */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-[var(--ease-out-soft)]"
        style={{ gridTemplateRows: collapsed ? "0fr" : "1fr" }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="px-3 pb-2.5">
            {deadlines.length > 0 && (
              <>
                <div className="mb-1 mt-0.5 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-ink-2">
                  Deadlines
                </div>
                {deadlines.map((r) => (
                  <div
                    key={r.short}
                    className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[7px] border border-line bg-surface px-2.5 py-1.5 text-[12.5px]"
                  >
                    <button
                      type="button"
                      onClick={() => onOpenRow(r)}
                      className="min-w-0 cursor-pointer truncate text-left hover:text-accent"
                    >
                      <b className="font-semibold">{r.company}</b>{" "}
                      <span className="text-ink-2">
                        {labelLower(r.status)}
                      </span>
                      <DueChip row={r} />
                    </button>
                    <span className="flex shrink-0 gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2.5 text-[11.5px]"
                        onClick={() => onClearDue(r.short)}
                      >
                        Done
                      </Button>
                    </span>
                  </div>
                ))}
              </>
            )}
            {quiet.length > 0 && (
              <>
                <div className="mb-1 mt-2 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-ink-2">
                  Quiet applications
                </div>
                {quiet.map((r) => (
                  <div
                    key={r.short}
                    className="mb-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-[7px] border border-line bg-surface px-2.5 py-1.5 text-[12.5px]"
                  >
                    <button
                      type="button"
                      onClick={() => onOpenRow(r)}
                      className="min-w-0 cursor-pointer truncate text-left hover:text-accent"
                    >
                      <b className="font-semibold">{r.company}</b>{" "}
                      <span className="text-ink-2">
                        {labelLower(r.status)} · applied{" "}
                        {formatDate(r.appliedDate)}
                      </span>
                      <WaitingChip row={r} />
                    </button>
                    <span className="flex shrink-0 gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2.5 text-[11.5px]"
                        onClick={() => onFollowUp(r.short)}
                      >
                        Log follow-up
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11.5px] text-ink-2"
                        onClick={() => onSnooze(r.short)}
                      >
                        Snooze 3d
                      </Button>
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
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
  onDetails,
}: {
  row: TrackerRow;
  /** The row a command-palette jump landed on - washed until the next jump. */
  focused: boolean;
  onStatus: (s: string) => void;
  onNote: () => void;
  onHistory: () => void;
  onDetails: () => void;
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
          <DueChip row={row} />
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
          onClick={onDetails}
          title="Open details"
          className="text-ink-2"
        >
          <PanelRightIcon className="size-3.5" />
          details
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
  /** dueAt: undefined = untouched, null = cleared, string = set. */
  onSave: (short: string, note: string, dueAt?: string | null) => void;
}) {
  const [value, setValue] = useState("");
  const [due, setDue] = useState("");
  const open = row !== null;

  // Reset the draft whenever a different row opens the dialog. This is a
  // render-phase state adjustment (conditional, stable), which React allows.
  const [lastRow, setLastRow] = useState<TrackerRow | null>(null);
  if (row !== lastRow) {
    setLastRow(row);
    if (row) {
      setValue("");
      setDue(row.dueAt ?? "");
    }
  }

  const dueChanged = row ? due !== (row.dueAt ?? "") : false;

  function submit() {
    if (!row) return;
    if (!value.trim() && !dueChanged) return;
    onSave(row.short, value.trim(), dueChanged ? due || null : undefined);
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
        {/* The deadline lives beside the note because that's where deadlines
            arrive in real life ("OA due Friday") - an explicit date field, so
            it feeds the needs-attention queue without any note parsing. */}
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
          <span>Deadline (optional)</span>
          <input
            type="date"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            aria-label="Deadline date"
            className="rounded-md border border-line-2 bg-bg px-2.5 py-1 text-[12.5px] text-ink outline-none transition-colors focus:border-accent"
          />
          {due && (
            <button
              type="button"
              onClick={() => setDue("")}
              className="cursor-pointer text-[11.5px] text-ink-2 underline decoration-dashed underline-offset-2 hover:text-ink"
            >
              clear
            </button>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!value.trim() && !dueChanged}>
            Save
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

  async function commitNote(short: string, note: string, label = "Note saved") {
    const prev = rows.find((r) => r.short === short);
    if (!prev || !note.trim()) return;
    const snapshot = rows;
    setRows(applyChange(short, prev.status, note.trim()));
    const res = await updateStatus(short, prev.status, note.trim());
    if (res.ok) {
      toast.success(label);
    } else {
      setRows(snapshot);
      toast.error(res.error);
    }
  }

  async function commitDueAt(short: string, dueAt: string | null) {
    const snapshot = rows;
    setRows(rows.map((r) => (r.short === short ? { ...r, dueAt: dueAt ?? undefined } : r)));
    const res = await updateDueAt(short, dueAt);
    if (res.ok) {
      toast.success(dueAt ? `Deadline set for ${formatDate(dueAt)}` : "Deadline cleared");
    } else {
      setRows(snapshot);
      toast.error(res.error);
    }
  }

  async function commitSnooze(short: string, until: string | null) {
    const snapshot = rows;
    setRows(
      rows.map((r) =>
        r.short === short ? { ...r, snoozedUntil: until ?? undefined } : r
      )
    );
    const res = await updateSnooze(short, until);
    if (res.ok) {
      toast.success(until ? `Snoozed until ${formatDate(until)}` : "Unsnoozed");
    } else {
      setRows(snapshot);
      toast.error(res.error);
    }
  }

  // The drawer tracks a short key, not a row object, so optimistic row
  // updates (status, notes, deadline) are live inside an open drawer.
  const [drawerShort, setDrawerShort] = useState<string | null>(null);
  const drawerRow = drawerShort
    ? (rows.find((r) => r.short === drawerShort) ?? null)
    : null;

  return (
    <div>
      <NeedsAttention
        rows={rows}
        onOpenRow={(r) => setDrawerShort(r.short)}
        onFollowUp={(short) => commitNote(short, "followed up", "Follow-up logged")}
        onSnooze={(short) =>
          commitSnooze(
            short,
            new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10)
          )
        }
        onClearDue={(short) => commitDueAt(short, null)}
      />

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
              onDetails={() => setDrawerShort(r.short)}
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
        onSave={(short, note, dueAt) => {
          setNoteRow(null);
          if (note) commitNote(short, note);
          if (dueAt !== undefined) commitDueAt(short, dueAt);
        }}
      />
      <ApplicationDrawer
        row={drawerRow}
        onOpenChange={(o) => {
          if (!o) setDrawerShort(null);
        }}
        onStatus={commitStatus}
        onNote={(short, note) => commitNote(short, note)}
        onDueAt={commitDueAt}
        onSnooze={commitSnooze}
      />
    </div>
  );
}
