"use client";

import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { FOCUS_RING, PresenceCollapse, blurOnPointerActivate } from "./row-primitives";

/**
 * A dense, column-defined table with one expandable row at a time.
 *
 * Each row is an outer grid of [lead | expand button | trail... | chevron].
 * The lead and trail slots sit OUTSIDE the expand button, so the controls
 * they hold (ticks, a resume button) act without opening the row. The
 * button is itself a grid of `columns`, which is where the data cells live
 * and where clicking toggles the row's panel.
 *
 * Markup is a div grid with table roles rather than a <table>: cells wrap,
 * a full-width panel expands under its row and rows collapse on hide, all of
 * which fight table layout. Nothing in here knows about matches - columns,
 * slots and the panel come in as definitions, so another list (the Tracker)
 * can adopt it by passing its own.
 */

export type DenseSort = { key: string; dir: "asc" | "desc" } | null;

export type DenseColumn<R> = {
  id: string;
  label: string;
  /** Grid track inside the expand button, e.g. "160px" or "minmax(0,2fr)". */
  track: string;
  sortable?: boolean;
  render: (row: R) => ReactNode;
};

export type DenseSlot<R> = {
  id: string;
  /** Header text; empty for a slot with no heading. */
  label?: string;
  track: string;
  className?: string;
  render: (row: R) => ReactNode;
};

const ROW_GAP = "gap-[14px]";
const CHEVRON_TRACK = "36px";
const HEAD_LABEL = "font-mono text-[11px] tracking-[0.06em] uppercase text-ink-2";

export function DenseTable<R>({
  label,
  rows,
  rowKey,
  columns,
  lead,
  trail = [],
  sort,
  onSort,
  openKey,
  onActivate,
  renderPanel,
  cursorKey,
  wrapRow,
  rowStyle,
  empty,
  minWidth = 960,
}: {
  /** Accessible name for the table. */
  label: string;
  rows: R[];
  rowKey: (row: R) => string;
  columns: DenseColumn<R>[];
  lead?: DenseSlot<R>;
  trail?: DenseSlot<R>[];
  sort: DenseSort;
  /** A sortable header was clicked; the caller owns the cycle. */
  onSort: (key: string) => void;
  openKey: string | null;
  /** The row's expand button was clicked. */
  onActivate: (key: string) => void;
  renderPanel: (row: R) => ReactNode;
  /** Row the keyboard cursor rail sits on. */
  cursorKey: string | null;
  /** Wraps each row (e.g. in a hide collapse); defaults to none. */
  wrapRow?: (row: R, node: ReactNode, index: number) => ReactNode;
  rowStyle?: (row: R, index: number) => CSSProperties | undefined;
  /** Rendered as the only row when `rows` is empty; the header stays. */
  empty: ReactNode;
  minWidth?: number;
}) {
  const inner = columns.map((c) => c.track).join(" ");
  const outer = [lead?.track, "minmax(0,1fr)", ...trail.map((t) => t.track), CHEVRON_TRACK]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="overflow-x-auto rounded-lg border border-line-2 bg-surface">
      <div role="table" aria-label={label} aria-rowcount={rows.length + 1} style={{ minWidth }}>
        {/* header: same two-level grid as the rows */}
        <div
          role="row"
          className={cn(
            "grid items-center border-b border-l-[3px] border-b-line-2 border-l-transparent bg-bg py-1 pr-2",
            ROW_GAP
          )}
          style={{ gridTemplateColumns: outer }}
        >
          {lead && (
            <div role="columnheader" className={cn("pl-[9px]", HEAD_LABEL)}>
              {lead.label ? lead.label : <span className="sr-only">{lead.id}</span>}
            </div>
          )}
          <div className={cn("grid items-center", ROW_GAP)} style={{ gridTemplateColumns: inner }}>
            {columns.map((c) => {
              const active = sort?.key === c.id;
              const ariaSort = !c.sortable
                ? undefined
                : active
                  ? sort!.dir === "asc"
                    ? "ascending"
                    : "descending"
                  : "none";
              return (
                <div key={c.id} role="columnheader" aria-sort={ariaSort} className="min-w-0">
                  {c.sortable ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        blurOnPointerActivate(e);
                        onSort(c.id);
                      }}
                      className={cn(
                        "-ml-2 inline-flex min-h-9 cursor-pointer items-center rounded px-2 transition-colors",
                        HEAD_LABEL,
                        FOCUS_RING,
                        active ? "bg-chip text-ink" : "hover:text-ink"
                      )}
                    >
                      {c.label}
                      <span aria-hidden className="ml-1.5 opacity-90">
                        {active ? (sort!.dir === "asc" ? "↑" : "↓") : "↕"}
                      </span>
                    </button>
                  ) : (
                    <span className={cn("inline-flex min-h-9 items-center", HEAD_LABEL)}>
                      {c.label}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          {trail.map((t) => (
            <div key={t.id} role="columnheader" className={cn("py-2", HEAD_LABEL)}>
              {t.label ?? ""}
            </div>
          ))}
          <span aria-hidden />
        </div>

        <CursorRail cursorKey={cursorKey} openKey={openKey}>
          {rows.length === 0 ? (
            <div role="row" className="border-b border-line px-4 py-7 text-center text-[13px] text-ink-2">
              <div role="cell">{empty}</div>
            </div>
          ) : (
            rows.map((row, i) => {
              const key = rowKey(row);
              const open = key === openKey;
              const node = (
                <div key={key} role="row" style={rowStyle?.(row, i)}>
                  <div
                    data-cursor={key === cursorKey ? "1" : undefined}
                    className={cn(
                      "grid min-h-[44px] items-start border-b border-l-[3px] border-b-line pr-2 transition-colors",
                      ROW_GAP,
                      open ? "border-l-accent bg-bg" : "border-l-transparent"
                    )}
                    style={{ gridTemplateColumns: outer }}
                  >
                    {lead && (
                      <div role="cell" className={cn("pl-[9px]", lead.className)}>
                        {lead.render(row)}
                      </div>
                    )}
                    <div role="cell" aria-colspan={columns.length} className="min-w-0">
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={(e) => {
                          blurOnPointerActivate(e);
                          onActivate(key);
                        }}
                        className={cn(
                          "grid w-full cursor-pointer items-start py-[11px] text-left text-[13px] text-ink",
                          ROW_GAP,
                          FOCUS_RING
                        )}
                        style={{ gridTemplateColumns: inner }}
                      >
                        {columns.map((c) => (
                          <span key={c.id} className="min-w-0">
                            {c.render(row)}
                          </span>
                        ))}
                      </button>
                    </div>
                    {trail.map((t) => (
                      <div key={t.id} role="cell" className={t.className}>
                        {t.render(row)}
                      </div>
                    ))}
                    <span
                      aria-hidden
                      className="py-[11px] text-center font-mono text-[12px] text-ink-2"
                    >
                      {open ? "▾" : "▸"}
                    </span>
                  </div>
                  <div role="cell" aria-colspan={columns.length}>
                    <PresenceCollapse open={open}>
                      <div className="border-b border-l-[3px] border-b-line border-l-accent bg-bg pt-[18px] pr-5 pb-[22px] pl-8">
                        {renderPanel(row)}
                      </div>
                    </PresenceCollapse>
                  </div>
                </div>
              );
              return wrapRow ? wrapRow(row, node, i) : node;
            })
          )}
        </CursorRail>
      </div>
    </div>
  );
}

/**
 * The sliding cursor rail and its wash, over a list of rows.
 *
 * The rail is one absolutely-positioned element that translates to the
 * cursor row, instead of a border repainted on whichever row is current -
 * that is the whole point, since a repaint has no motion to read. Rows are
 * variable height (roles wrap, a panel opens above), so the position is
 * measured rather than computed: a ResizeObserver re-measures when the box
 * changes size, so the rail never drifts off its row. Appearing is instant;
 * only row-to-row moves animate, or the rail would slide in from the top.
 */
export function CursorRail({
  cursorKey,
  openKey,
  children,
}: {
  cursorKey: string | null;
  /** Re-measure when the open row changes, too. */
  openKey?: string | null;
  children: ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [rail, setRail] = useState<{ y: number; h: number } | null>(null);
  const [instant, setInstant] = useState(true);
  const wasShown = useRef(false);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => {
      const el = box.querySelector<HTMLElement>('[data-cursor="1"]');
      if (!el) {
        wasShown.current = false;
        setRail(null);
        return;
      }
      setInstant(!wasShown.current);
      wasShown.current = true;
      const boxTop = box.getBoundingClientRect().top;
      const rect = el.getBoundingClientRect();
      const y = Math.round(rect.top - boxTop);
      const h = Math.round(rect.height);
      // The observer fires every frame while a row collapses, which keeps the
      // rail glued to its row - but only re-render when it actually moved.
      setRail((prev) => (prev && prev.y === y && prev.h === h ? prev : { y, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [cursorKey, openKey]);

  const railStyle: CSSProperties = {
    transform: `translateY(${rail ? rail.y : 0}px)`,
    height: rail ? `${rail.h}px` : 0,
    opacity: rail ? 1 : 0,
    transition: instant
      ? "opacity .12s linear"
      : "transform var(--rail-ms) var(--ease-rail), height var(--rail-ms) var(--ease-rail), opacity .12s linear",
    willChange: "transform, height",
    pointerEvents: "none",
  };

  return (
    <div ref={boxRef} role="rowgroup" className="relative">
      {/* wash behind the rows (rows carry no background of their own) */}
      <span
        aria-hidden
        className="absolute top-0 left-0 w-full bg-[color-mix(in_srgb,var(--color-accent)_4%,transparent)]"
        style={railStyle}
      />
      {/* the rail itself */}
      <span
        aria-hidden
        className="absolute top-0 left-0 z-10 w-[3px] rounded-r-[2px] bg-accent"
        style={railStyle}
      />
      {children}
    </div>
  );
}
