"use client";

import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { ariaSortFor } from "./matches-lib";
import { FOCUS_RING, PresenceCollapse, blurOnPointerActivate } from "./row-primitives";

/**
 * A dense, column-defined table with one expandable row at a time.
 *
 * Every row is one CSS grid whose role="row" element owns its cells
 * directly: [lead | columns... | trail... | expand]. Nothing is nested in a
 * button, so the table structure stays valid for assistive tech; the expand
 * control is a real button in the last cell (aria-expanded, aria-controls),
 * and a click anywhere non-interactive on the row does the same. The lead
 * and trail cells hold controls (ticks, a resume button) that act without
 * opening the row.
 *
 * role="table" rather than role="grid": a grid promises arrow-key movement
 * between cells, which this list does not do - rows are moved through with
 * j/k at the surface level, and cells hold ordinary buttons and links.
 *
 * Below 960px of frame width the frame scrolls horizontally. The header
 * scrolls in lockstep with the rows (it is part of the same scrolled box),
 * and the lead cell plus the first column stay pinned on the left so a row
 * keeps its name in view. Vertical pinning of the header is not possible
 * here: the horizontal scroll container is also the vertical one for its
 * sticky children, and it does not scroll vertically.
 *
 * Nothing in here knows about matches - columns, slots and the panel come in
 * as definitions, so another list (the Tracker) can adopt it.
 */

export type DenseSort<K extends string> = { key: K; dir: "asc" | "desc" } | null;

export type DenseColumn<R, K extends string> = {
  id: string;
  label: string;
  /** Grid track, e.g. "160px" or "minmax(0,2fr)". */
  track: string;
  /** Makes the header a sort button for this key. */
  sortKey?: K;
  className?: string;
  render: (row: R) => ReactNode;
};

export type DenseSlot<R> = {
  id: string;
  /** Header text; the id is read out (visually hidden) when absent. */
  label?: string;
  /** Grid track in px (the lead slot's width is the first pin offset). */
  track: string;
  className?: string;
  render: (row: R) => ReactNode;
};

const MIN_WIDTH = 960;
const GAP = 14;
const HEAD_LABEL = "font-mono text-[11px] tracking-[0.06em] uppercase text-ink-2";
/* Pinned cells only stick (and need an opaque fill) while the frame is
   narrower than the table, i.e. while it actually scrolls. */
const PIN = "@max-[960px]:sticky @max-[960px]:z-[1]";
/* Spelled out in full so Tailwind's scanner sees each class. */
const PIN_FILL = {
  bg: "@max-[960px]:bg-bg",
  surface: "@max-[960px]:bg-surface",
} as const;
type Fill = keyof typeof PIN_FILL;

/** True when a click began on something that handles its own clicks. */
function fromControl(e: MouseEvent<HTMLElement>): boolean {
  return Boolean((e.target as Element).closest("button, a, input, select, textarea, label"));
}

export function DenseTable<R, K extends string>({
  label,
  rows,
  rowKey,
  rowLabel,
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
}: {
  /** Accessible name for the table. */
  label: string;
  rows: R[];
  rowKey: (row: R) => string;
  /** Names the row for its expand button ("Stripe, Software Engineer Intern"). */
  rowLabel: (row: R) => string;
  columns: DenseColumn<R, K>[];
  lead: DenseSlot<R>;
  trail?: DenseSlot<R>[];
  sort: DenseSort<K>;
  /** A sortable header was clicked; the caller owns the cycle. */
  onSort: (key: K) => void;
  openKey: string | null;
  /** The row's expand button (or the row itself) was clicked. */
  onActivate: (key: string) => void;
  renderPanel: (row: R) => ReactNode;
  /** Row the keyboard cursor rail sits on. */
  cursorKey: string | null;
  /** Wraps each row (e.g. in a hide collapse); defaults to none. */
  wrapRow?: (row: R, node: ReactNode) => ReactNode;
  rowStyle?: (index: number) => CSSProperties | undefined;
  /** Rendered as the only row when `rows` is empty; the header stays. */
  empty: ReactNode;
}) {
  const idBase = useId();
  const tracks = [lead.track, ...columns.map((c) => c.track), ...trail.map((t) => t.track), "36px"];
  const grid: CSSProperties = { gridTemplateColumns: tracks.join(" "), columnGap: GAP };
  const colCount = tracks.length;
  const pinLeft = parseFloat(lead.track) || 0;
  const orderKey = rows.map(rowKey).join("\n");

  /* The lead cell pins at the frame's left edge; the first column pins just
     after it, reaching back over the gap so nothing shows through. */
  const leadPin = (fill: Fill) => cn(PIN, "left-0", PIN_FILL[fill]);
  const firstPin = (fill: Fill) => cn(PIN, "-ml-[14px] pl-[14px]", PIN_FILL[fill]);

  return (
    <div className="@container overflow-x-auto rounded-lg border border-line-2 bg-surface">
      <div role="table" aria-label={label} aria-rowcount={rows.length + 1} style={{ minWidth: MIN_WIDTH }}>
        <div role="rowgroup">
          <div
            role="row"
            className="grid items-center border-b border-l-[3px] border-b-line-2 border-l-transparent bg-bg py-1 pr-2"
            style={grid}
          >
            <div role="columnheader" className={cn(leadPin("bg"), "self-stretch")}>
              <span className="sr-only">{lead.label ?? lead.id}</span>
            </div>
            {columns.map((c, i) => (
              <div
                key={c.id}
                role="columnheader"
                aria-sort={c.sortKey ? ariaSortFor(sort, c.sortKey) : undefined}
                className={cn("min-w-0", i === 0 && cn(firstPin("bg"), "self-stretch"))}
                style={i === 0 ? { left: pinLeft } : undefined}
              >
                {c.sortKey ? (
                  <button
                    type="button"
                    onClick={(e) => {
                      blurOnPointerActivate(e);
                      onSort(c.sortKey!);
                    }}
                    className={cn(
                      "-ml-2 inline-flex min-h-9 cursor-pointer items-center rounded px-2 transition-colors",
                      HEAD_LABEL,
                      FOCUS_RING,
                      sort?.key === c.sortKey ? "bg-chip text-ink" : "hover:text-ink"
                    )}
                  >
                    {c.label}
                    <span aria-hidden className="ml-1.5 opacity-90">
                      {sort?.key === c.sortKey ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}
                    </span>
                  </button>
                ) : (
                  <span className={cn("inline-flex min-h-9 items-center", HEAD_LABEL)}>{c.label}</span>
                )}
              </div>
            ))}
            {trail.map((t) => (
              <div key={t.id} role="columnheader" className={HEAD_LABEL}>
                {t.label ?? <span className="sr-only">{t.id}</span>}
              </div>
            ))}
            <div role="columnheader">
              <span className="sr-only">Details</span>
            </div>
          </div>
        </div>

        <CursorRail cursorKey={cursorKey} watch={`${openKey}\n${orderKey}`}>
          {rows.length === 0 ? (
            <div role="row" className="border-b border-line px-4 py-7 text-center text-[13px] text-ink-2">
              <div role="cell" aria-colspan={colCount}>
                {empty}
              </div>
            </div>
          ) : (
            rows.map((row, i) => {
              const key = rowKey(row);
              const open = key === openKey;
              const panelId = `${idBase}-panel-${key}`;
              const fill: Fill = open ? "bg" : "surface";
              const node = (
                <div key={key} data-row={key} style={rowStyle?.(i)}>
                  <div
                    role="row"
                    data-cursor={key === cursorKey ? "1" : undefined}
                    onClick={(e) => {
                      if (!fromControl(e)) onActivate(key);
                    }}
                    className={cn(
                      "grid min-h-[44px] cursor-pointer items-start border-b border-l-[3px] border-b-line pr-2 text-[13px] text-ink transition-colors",
                      open ? "border-l-accent bg-bg" : "border-l-transparent"
                    )}
                    style={grid}
                  >
                    <div role="cell" className={cn(leadPin(fill), "self-stretch", lead.className)}>
                      {lead.render(row)}
                    </div>
                    {columns.map((c, ci) => (
                      <div
                        key={c.id}
                        role="cell"
                        className={cn(
                          "min-w-0 py-[11px]",
                          ci === 0 && cn(firstPin(fill), "self-stretch"),
                          c.className
                        )}
                        style={ci === 0 ? { left: pinLeft } : undefined}
                      >
                        {c.render(row)}
                      </div>
                    ))}
                    {trail.map((t) => (
                      <div key={t.id} role="cell" className={t.className}>
                        {t.render(row)}
                      </div>
                    ))}
                    <div role="cell" className="flex justify-center pt-2">
                      <button
                        type="button"
                        data-expand={key}
                        aria-expanded={open}
                        aria-controls={panelId}
                        aria-label={rowLabel(row)}
                        onClick={(e) => {
                          blurOnPointerActivate(e);
                          onActivate(key);
                        }}
                        className={cn(
                          "flex size-7 cursor-pointer items-center justify-center rounded font-mono text-[12px] text-ink-2 hover:bg-chip hover:text-ink",
                          FOCUS_RING
                        )}
                      >
                        <span aria-hidden>{open ? "▾" : "▸"}</span>
                      </button>
                    </div>
                  </div>
                  <div role="row">
                    <div role="cell" aria-colspan={colCount}>
                      <PresenceCollapse open={open}>
                        <div
                          id={panelId}
                          role="region"
                          aria-label={rowLabel(row)}
                          className="border-b border-l-[3px] border-b-line border-l-accent bg-bg pt-[18px] pr-5 pb-[22px] pl-8"
                        >
                          {renderPanel(row)}
                        </div>
                      </PresenceCollapse>
                    </div>
                  </div>
                </div>
              );
              return wrapRow ? wrapRow(row, node) : node;
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
 * measured rather than computed: it re-measures when the cursor moves, when
 * `watch` changes (the row order, the open row) and whenever the box
 * resizes. A hidden box (the phone layout) measures nothing. Appearing is
 * instant; only row-to-row moves animate.
 */
export function CursorRail({
  cursorKey,
  watch,
  children,
}: {
  cursorKey: string | null;
  /** Anything whose change can move rows without resizing the box. */
  watch?: string;
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
      if (!el || box.getClientRects().length === 0) {
        wasShown.current = false;
        setRail(null);
        return;
      }
      setInstant(!wasShown.current);
      wasShown.current = true;
      const y = Math.round(el.getBoundingClientRect().top - box.getBoundingClientRect().top);
      const h = Math.round(el.getBoundingClientRect().height);
      // The observer fires every frame while a row collapses, which keeps the
      // rail glued to its row - but only re-render when it actually moved.
      setRail((prev) => (prev && prev.y === y && prev.h === h ? prev : { y, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [cursorKey, watch]);

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
      {/* the rail itself, above the pinned cells */}
      <span
        aria-hidden
        className="absolute top-0 left-0 z-10 w-[3px] rounded-r-[2px] bg-accent"
        style={railStyle}
      />
      {children}
    </div>
  );
}
