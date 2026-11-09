"use client";

import type { CSSProperties, ReactNode } from "react";
import { AlertTriangle, Download, FileSearch, Loader2, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { useReplay, TICK_POP, TICK_POP_OPTS, CHECK_DRAW, CHECK_DRAW_OPTS } from "@/lib/motion";
import type { Day } from "@/lib/terms";
import type { ResumeMeta } from "@/lib/convex";
import type { TriageRow } from "@/app/(app)/page";
import { ReferralLink } from "@/components/referrals/referral-link";
import { DenseTable, type DenseColumn, type DenseSlot } from "./dense-table";
import { ClosedBadge, CollapseShell, FOCUS_RING, blurOnPointerActivate } from "./row-primitives";
import {
  UNKNOWN_TERM,
  absoluteDate,
  foundAge,
  isClosed,
  isPrimaryTerm,
  reportSummary,
  rowStatus,
  tagIsInformative,
  tagLabel,
  termLabel,
  termOf,
  termShort,
  worthKnowing,
  type Sort,
  type SortKey,
} from "./matches-lib";

/**
 * The Matches columns on the dense table shell (dense-table.tsx): toggles,
 * company / role / location / term / found / status, the resume cell and the
 * details panel. Every control here calls back into triage.tsx, which owns
 * the state, the tick batching, the build machine and the keyboard - so a
 * tick clicked here, pressed in the panel or typed as `x` is one code path.
 */

export type BuildState = "idle" | "building" | "built" | "failed";

export type MatchHandlers = {
  onActivate: (short: string) => void;
  onToggleApplied: (short: string) => void;
  onToggleSaved: (short: string) => void;
  onHide: (short: string) => void;
  onRestore: (short: string) => void;
  onBuild: (short: string) => void;
  onOpenReport: (row: TriageRow) => void;
};

const MONO_CAPS = "font-mono text-[11px] tracking-[0.04em] uppercase";
const SMALL_BTN = cn(
  "inline-flex min-h-7 items-center justify-center gap-1.5 rounded-[5px] border px-2.5 py-[5px] whitespace-nowrap transition-colors select-none",
  MONO_CAPS,
  FOCUS_RING
);
const PANEL_BTN = cn(
  "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border px-3.5 py-2.5 text-[13px] font-medium transition-colors",
  FOCUS_RING
);
const DT = "pt-0.5 font-mono text-[11px] tracking-[0.06em] text-ink-2 uppercase";

export function MatchesTable({
  rows,
  sort,
  onSort,
  openShort,
  cursor,
  wantedTerms,
  today,
  hiding,
  entering,
  rowStyle,
  flashFor,
  buildStateFor,
  buildErrorFor,
  metaFor,
  justBuilt,
  handlers,
  empty,
}: {
  /** Visible rows, already filtered and sorted. */
  rows: TriageRow[];
  sort: Sort;
  onSort: (key: SortKey) => void;
  openShort: string | null;
  cursor: string | null;
  wantedTerms: string[] | null;
  today: Day;
  hiding: ReadonlySet<string>;
  entering: ReadonlySet<string>;
  rowStyle: (index: number) => CSSProperties;
  /** Replay token for a tick the user just turned on, else null. */
  flashFor: (short: string, field: "a" | "s") => number | null;
  buildStateFor: (row: TriageRow) => BuildState;
  buildErrorFor: (row: TriageRow) => string | undefined;
  metaFor: (row: TriageRow) => ResumeMeta | null;
  justBuilt: ReadonlySet<string>;
  handlers: MatchHandlers;
  empty: ReactNode;
}) {
  const columns: DenseColumn<TriageRow, SortKey>[] = [
    {
      id: "company",
      label: "Company",
      track: "160px",
      sortKey: "company",
      render: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          {r.priority && (
            <span
              role="img"
              aria-label="priority"
              className="inline-block size-[7px] flex-none rounded-full bg-accent"
            />
          )}
          <span className="truncate font-medium" title={r.company}>
            {r.company}
          </span>
          {isClosed(r) && <ClosedBadge />}
        </span>
      ),
    },
    {
      id: "role",
      label: "Role",
      track: "minmax(0,2.2fr)",
      render: (r) => <span className="block leading-[1.35]">{r.title}</span>,
    },
    {
      id: "location",
      label: "Location",
      track: "minmax(0,1.1fr)",
      render: (r) => <span className="block leading-[1.35] text-ink-2">{r.location}</span>,
    },
    {
      id: "term",
      label: "Term",
      track: "72px",
      sortKey: "term",
      render: (r) => (
        <span
          title={termLabel(termOf(r))}
          className={cn(
            "font-mono text-[12px]",
            !r.term || isPrimaryTerm(r.term, wantedTerms) ? "text-ink-2" : "text-amber"
          )}
        >
          {termShort(r.term)}
        </span>
      ),
    },
    {
      id: "found",
      label: "Found",
      track: "68px",
      sortKey: "found",
      render: (r) => (
        // The age is computed against the viewer's clock, which can differ
        // from the server's across midnight; the absolute date is the title.
        <span suppressHydrationWarning title={absoluteDate(r.added)} className="font-mono text-[12px] text-ink-2">
          {foundAge(r.added, today)}
        </span>
      ),
    },
    {
      id: "status",
      label: "Status",
      track: "100px",
      render: (r) => {
        const s = rowStatus(r);
        return (
          <span
            className={cn(
              MONO_CAPS,
              s === "applied" ? "text-accent" : s === "saved" ? "text-amber" : "text-ink-2"
            )}
          >
            {s}
          </span>
        );
      },
    },
  ];

  const lead: DenseSlot<TriageRow> = {
    id: "Applied and saved",
    track: "55px",
    render: (r) => (
      <RowToggles
        row={r}
        appliedFlash={flashFor(r.short, "a")}
        savedFlash={flashFor(r.short, "s")}
        onToggleApplied={() => handlers.onToggleApplied(r.short)}
        onToggleSaved={() => handlers.onToggleSaved(r.short)}
      />
    ),
  };

  const trail: DenseSlot<TriageRow>[] = [
    {
      id: "resume",
      label: "Resume",
      track: "136px",
      className: "flex flex-wrap items-center gap-1.5 py-2",
      render: (r) => (
        <ResumeCell
          row={r}
          state={buildStateFor(r)}
          error={buildErrorFor(r)}
          meta={metaFor(r)}
          pulse={justBuilt.has(r.short)}
          onBuild={() => handlers.onBuild(r.short)}
          onOpenReport={() => handlers.onOpenReport(r)}
        />
      ),
    },
  ];

  return (
    <DenseTable<TriageRow, SortKey>
      label="Matches"
      rows={rows}
      rowKey={(r) => r.short}
      rowLabel={(r) => `Details for ${r.company}, ${r.title}`}
      columns={columns}
      lead={lead}
      trail={trail}
      sort={sort}
      onSort={onSort}
      openKey={openShort}
      onActivate={handlers.onActivate}
      cursorKey={cursor}
      rowStyle={rowStyle}
      wrapRow={(r, node) => (
        <CollapseShell key={r.short} open={!hiding.has(r.short)} enter={entering.has(r.short)}>
          {node}
        </CollapseShell>
      )}
      renderPanel={(r) => (
        <MatchPanel row={r} state={buildStateFor(r)} meta={metaFor(r)} handlers={handlers} />
      )}
      empty={empty}
    />
  );
}

/** The applied tick and saved star, outside the row's expand button. */
function RowToggles({
  row,
  appliedFlash,
  savedFlash,
  onToggleApplied,
  onToggleSaved,
}: {
  row: TriageRow;
  appliedFlash: number | null;
  savedFlash: number | null;
  onToggleApplied: () => void;
  onToggleSaved: () => void;
}) {
  const { applied, saved } = row;
  // Replay tokens are null except on the row the user just ticked, so a row
  // that arrives already applied renders static through SSR and hydration.
  const appliedBtn = useReplay<HTMLButtonElement>(appliedFlash, TICK_POP, TICK_POP_OPTS);
  const checkPath = useReplay<SVGPathElement>(appliedFlash, CHECK_DRAW, CHECK_DRAW_OPTS);
  const savedBtn = useReplay<HTMLButtonElement>(savedFlash, TICK_POP, TICK_POP_OPTS);
  return (
    <span className="flex items-center gap-1.5 pt-3 pl-[9px]">
      <button
        ref={appliedBtn}
        type="button"
        aria-label={`Mark ${row.company} applied`}
        aria-pressed={applied}
        onClick={(e) => {
          blurOnPointerActivate(e);
          onToggleApplied();
        }}
        className={cn(
          "flex size-[18px] flex-none cursor-pointer items-center justify-center rounded-[4px] border transition-[background-color,border-color,box-shadow] duration-150 active:scale-90",
          FOCUS_RING,
          applied
            ? "border-accent bg-accent text-accent-ink"
            : "border-line-2 bg-surface text-transparent hover:border-ink-2 hover:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_14%,transparent)]"
        )}
      >
        {/* Inline path rather than lucide's <Check/> so the stroke can draw
            itself: dasharray 20 covers the whole path, and the replay walks
            the offset to 0. Unticked rows park it at 20 (fully hidden). */}
        <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden>
          <path
            ref={checkPath}
            d="M3 8.5 L6.5 12 L13 4.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="3.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="20"
            style={{ strokeDashoffset: applied ? 0 : 20 }}
          />
        </svg>
      </button>
      <button
        ref={savedBtn}
        type="button"
        aria-label={`Save ${row.company}`}
        aria-pressed={saved}
        onClick={(e) => {
          blurOnPointerActivate(e);
          onToggleSaved();
        }}
        className={cn(
          "flex size-[18px] flex-none cursor-pointer items-center justify-center rounded-[4px] transition-colors active:scale-90",
          FOCUS_RING,
          saved ? "text-amber" : "text-line-2 hover:text-ink-2"
        )}
      >
        <Star className="size-[15px]" strokeWidth={2} fill={saved ? "currentColor" : "none"} />
      </button>
    </span>
  );
}

/** The four build states, outside the expand button. */
function ResumeCell({
  row,
  state,
  error,
  meta,
  pulse,
  onBuild,
  onOpenReport,
}: {
  row: TriageRow;
  state: BuildState;
  error?: string;
  meta: ResumeMeta | null;
  /** Play the one-shot "just built" ring on the report button. */
  pulse: boolean;
  onBuild: () => void;
  onOpenReport: () => void;
}) {
  if (state === "built") {
    const stub = meta?.report?.jdSource === "stub";
    return (
      <>
        <a
          href={row.resumeUrl ?? "#"}
          target="_blank"
          rel="noopener noreferrer"
          title={
            stub
              ? "No job description was found. This resume used only the job title, company, and location."
              : "Open the built resume"
          }
          className={cn(
            SMALL_BTN,
            "border-[color-mix(in_srgb,var(--color-accent)_42%,transparent)] text-accent hover:border-accent"
          )}
        >
          {stub && <AlertTriangle className="size-3.5 text-amber" aria-label="built without a job description" />}
          Resume
        </a>
        <button
          type="button"
          title="Build report - what the tailor did"
          aria-label={`Build report for ${row.company}`}
          onClick={(e) => {
            blurOnPointerActivate(e);
            onOpenReport();
          }}
          style={pulse ? { animation: "reportPulse 1s var(--ease-out-soft) 2" } : undefined}
          className={cn(
            "flex size-7 cursor-pointer items-center justify-center rounded-[5px] text-ink-2 transition-colors hover:bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] hover:text-accent",
            FOCUS_RING
          )}
        >
          <FileSearch className="size-3.5" />
        </button>
      </>
    );
  }
  if (state === "building") {
    return (
      <button type="button" disabled aria-busy="true" className={cn(SMALL_BTN, "cursor-default border-line-2 text-ink-2")}>
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Building
      </button>
    );
  }
  if (state === "failed") {
    return (
      <button
        type="button"
        title={error}
        onClick={(e) => {
          blurOnPointerActivate(e);
          onBuild();
        }}
        className={cn(SMALL_BTN, "cursor-pointer border-red text-red hover:bg-[color-mix(in_srgb,var(--color-red)_10%,transparent)]")}
      >
        Retry
      </button>
    );
  }
  return (
    <button
      type="button"
      title={
        row.hasJobDescription
          ? "Build a resume tailored to this posting"
          : "No job description found - you can paste one before building"
      }
      onClick={(e) => {
        blurOnPointerActivate(e);
        onBuild();
      }}
      className={cn(SMALL_BTN, "cursor-pointer border-accent text-accent hover:bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]")}
    >
      Build
    </button>
  );
}

/** The open row: facts, worth knowing, actions. */
function MatchPanel({
  row,
  state,
  meta,
  handlers,
}: {
  row: TriageRow;
  state: BuildState;
  meta: ResumeMeta | null;
  handlers: MatchHandlers;
}) {
  const report = state === "built" ? meta?.report ?? null : null;
  const notes = worthKnowing(row, report);
  const resumeUrl = state === "built" ? row.resumeUrl : null;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_232px] gap-6 text-[13px] text-ink">
      <dl className="m-0 grid grid-cols-[auto_1fr] content-start gap-x-3.5 gap-y-2">
        <dt className={DT}>Added</dt>
        <dd className="m-0">{absoluteDate(row.added) || "—"}</dd>
        <dt className={DT}>Term</dt>
        <dd className="m-0">{row.term || termLabel(UNKNOWN_TERM)}</dd>
        {row.salary && (
          <>
            <dt className={DT}>Salary</dt>
            <dd className="m-0">{row.salary}</dd>
          </>
        )}
        {tagIsInformative(row.tag) && (
          <>
            <dt className={DT}>Tag</dt>
            <dd className="m-0">{tagLabel(row.tag)}</dd>
          </>
        )}
        <dt className={DT}>Key</dt>
        <dd className="m-0 font-mono text-[12px]">{row.short}</dd>
      </dl>

      <div className="flex flex-col gap-2.5">
        <div className={DT}>{notes.length ? "Worth knowing" : "Nothing to flag"}</div>
        {notes.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {notes.map((n) => (
              <li key={n} className="leading-[1.4]">
                {n}
              </li>
            ))}
          </ul>
        )}
        {report && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-2.5">
            <span className="font-mono text-[11px] tracking-[0.04em] text-ink-2">
              resume · {reportSummary(report)}
            </span>
            <button
              type="button"
              onClick={(e) => {
                blurOnPointerActivate(e);
                handlers.onOpenReport(row);
              }}
              className={cn(SMALL_BTN, "cursor-pointer border-line-2 text-ink hover:border-ink-2")}
            >
              Report
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {row.url && (
          <a
            href={row.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(PANEL_BTN, "border-accent bg-accent text-accent-ink hover:opacity-90")}
          >
            Open posting
          </a>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            aria-pressed={row.applied}
            onClick={(e) => {
              blurOnPointerActivate(e);
              handlers.onToggleApplied(row.short);
            }}
            className={cn(
              PANEL_BTN,
              "flex-1 cursor-pointer bg-surface",
              row.applied ? "border-accent text-accent" : "border-line-2 text-ink hover:border-ink-2"
            )}
          >
            {row.applied ? "Applied ✓" : "Mark applied"}
          </button>
          <button
            type="button"
            aria-pressed={row.saved}
            onClick={(e) => {
              blurOnPointerActivate(e);
              handlers.onToggleSaved(row.short);
            }}
            className={cn(
              PANEL_BTN,
              "flex-1 cursor-pointer bg-surface",
              row.saved ? "border-amber text-amber" : "border-line-2 text-ink hover:border-ink-2"
            )}
          >
            {row.saved ? "Saved" : "Save"}
          </button>
        </div>
        <div className="flex items-center gap-2">
          {row.dismissed ? (
            <button
              type="button"
              onClick={(e) => {
                blurOnPointerActivate(e);
                handlers.onRestore(row.short);
              }}
              className={cn(PANEL_BTN, "flex-1 cursor-pointer border-line bg-surface text-amber hover:border-ink-2")}
            >
              Restore
            </button>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                blurOnPointerActivate(e);
                handlers.onHide(row.short);
              }}
              className={cn(PANEL_BTN, "flex-1 cursor-pointer border-line bg-surface text-ink-2 hover:border-red hover:text-red")}
            >
              Hide
            </button>
          )}
          <ReferralLink short={row.short} />
        </div>
        {resumeUrl && (
          <a
            href={resumeUrl}
            target="_blank"
            rel="noopener noreferrer"
            download={meta?.filename}
            className={cn(PANEL_BTN, "border-line-2 bg-surface text-ink hover:border-ink-2")}
          >
            <Download className="size-3.5" aria-hidden />
            Download resume{meta?.format ? ` ${meta.format.toUpperCase()}` : ""}
          </a>
        )}
        {resumeUrl && meta?.format === "pdf" && meta.docxUrl && (
          <a
            href={meta.docxUrl}
            target="_blank"
            rel="noopener noreferrer"
            download={meta.docxFilename ?? undefined}
            className="text-center font-mono text-[11px] tracking-[0.04em] text-ink-2 underline decoration-dashed underline-offset-2 hover:text-accent"
          >
            Download DOCX
          </a>
        )}
      </div>
    </div>
  );
}
