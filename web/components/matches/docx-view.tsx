"use client";

// A real rendering of the built .docx - the same file Word would open, laid out
// with its actual page geometry (US Letter, 0.5" margins, Times New Roman, the
// right-hand tab stops on dated lines).
//
// Why not the outline: the report's `outline` is one plain string per rendered
// paragraph. It is exact about CONTENT and says nothing about LAYOUT, so it
// cannot answer the question a user actually has in front of a tailored resume -
// "does this still fit on one page, and does the header look right". This
// renders the stored artifact instead and draws the page-1 boundary across it.
//
// docx-preview is loaded dynamically: it pulls in a DOCX/OOXML parser plus
// jszip, which has no business in the initial bundle of a page that mostly
// shows a job list.
//
// Fidelity caveat, stated in the UI too: the browser does the line breaking,
// not Word. Metrics agree closely for Times New Roman at these sizes, but treat
// a document that lands within ~a line of the boundary as "check it in Word".

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** US Letter at CSS 96dpi - docx-preview emits inches, the browser maps 1in to 96px. */
const PAGE_W_PX = 8.5 * 96;
const PAGE_H_PX = 11 * 96;

/** Content within a couple of millimetres of the boundary is called a fit. */
const OVERFLOW_SLOP_PX = 4;

/** How long docx-preview's own deferred tab-stop pass takes before ours runs. */
const TAB_SETTLE_MS = 600;

type Layout = { pages: number; overflowIn: number };

/**
 * Right-align the text after each tab stop against the page's right text edge.
 *
 * docx-preview ships its own solver behind `experimental`, but it rounds the
 * gap to whole points and re-measures against an ALREADY-WRAPPED line, so the
 * dated lines - every heading in this resume - overshoot the edge, wrap, and
 * then stay wrong. Measuring it directly is both simpler and exact: collapse
 * the tab, measure the text on either side of it, and give the tab exactly the
 * leftover width (less a pixel of slack, so rounding can never force a wrap).
 *
 * `scale` undoes the fit-to-width transform: getBoundingClientRect reports
 * scaled pixels but `width` is set in unscaled ones.
 */
function alignTabStops(host: HTMLElement, scale: number) {
  const s = scale || 1;
  for (const p of Array.from(host.querySelectorAll<HTMLElement>("p"))) {
    const tab = p.querySelector<HTMLElement>(".docx-tab-stop");
    if (!tab || !p.lastChild) continue;

    // Collapse first: everything below must be measured on ONE line, which is
    // exactly what docx-preview's own pass fails to do.
    tab.textContent = "";
    tab.style.wordSpacing = "0";
    tab.style.display = "inline-block";
    tab.style.width = "0px";

    const cs = getComputedStyle(p);
    const pRect = p.getBoundingClientRect();
    const contentRight =
      pRect.right -
      parseFloat(cs.paddingRight || "0") -
      parseFloat(cs.borderRightWidth || "0");

    const before = document.createRange();
    before.setStart(p, 0);
    before.setEndBefore(tab);
    const after = document.createRange();
    after.setStartAfter(tab);
    after.setEndAfter(p.lastChild);

    const gap =
      (contentRight -
        before.getBoundingClientRect().right -
        after.getBoundingClientRect().width) /
        s -
      1;
    // A heading + date that genuinely cannot share a line keeps a token gap and
    // is allowed to wrap, rather than being crushed to nothing.
    tab.style.width = `${Math.max(4, gap)}px`;
  }
}

/**
 * Mark where page 1 ends, but only when something actually runs past it: on a
 * one-page resume the rule would sit on the bottom edge and read as a stray
 * border. Idempotent - re-running replaces the previous rule.
 */
function markPageBoundary(host: HTMLElement, show: boolean) {
  host.querySelector("[data-page-rule]")?.remove();
  const first = host.querySelector<HTMLElement>("section");
  if (!first || !show) return;
  first.style.position = "relative";
  const rule = document.createElement("div");
  rule.dataset.pageRule = "1";
  rule.style.cssText = [
    "position:absolute",
    "left:0",
    "right:0",
    `top:${PAGE_H_PX}px`,
    "border-top:1px dashed #c2410c",
    "pointer-events:none",
  ].join(";");
  first.appendChild(rule);
}

type Phase =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

export function DocxView({
  url,
  onFailed,
}: {
  url: string;
  /** Told once when rendering is impossible, so the caller can fall back. */
  onFailed?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [layout, setLayout] = useState<Layout | null>(null);
  const [fit, setFit] = useState(true);
  const [scale, setScale] = useState(1);
  const [frameHeight, setFrameHeight] = useState(0);

  // Measure the rendered pages.
  //
  // docx-preview gives each page a `section` fixed to the page box with
  // `overflow: hidden`, and puts the paragraphs in an `article` inside it. So
  // the section's own height is ALWAYS one page and says nothing: a resume that
  // runs long is simply clipped at the bottom edge, which would make this view
  // claim "fits on one page" about a document that does not. The content height
  // has to come from the article, whose scrollHeight is unaffected by the
  // clipping. (The CSS below also un-clips the section so the spill is visible,
  // but the measurement must not depend on that.)
  const measure = useCallback((host: HTMLElement): Layout => {
    const sections = Array.from(host.querySelectorAll<HTMLElement>("section"));
    if (!sections.length) return { pages: 0, overflowIn: 0 };
    const contentHeight = (s: HTMLElement): number => {
      const article = s.querySelector<HTMLElement>("article") ?? s;
      const cs = getComputedStyle(s);
      const padV =
        parseFloat(cs.paddingTop || "0") + parseFloat(cs.paddingBottom || "0");
      return article.scrollHeight + padV;
    };
    let pages = 0;
    for (const s of sections) {
      pages += Math.max(
        1,
        Math.ceil(contentHeight(s) / (PAGE_H_PX + OVERFLOW_SLOP_PX)),
      );
    }
    const over = contentHeight(sections[sections.length - 1]) - PAGE_H_PX;
    return { pages, overflowIn: over > OVERFLOW_SLOP_PX ? over / 96 : 0 };
  }, []);

  /**
   * Scale to the dialog's width, re-align the tab stops for that scale, and
   * re-measure. The zoom transform keeps the document's real geometry intact
   * (unlike reflowing it into the container), which is the entire point - a
   * page that fits only because it was squeezed would be a lie.
   *
   * The transform is applied imperatively rather than through state so that
   * alignment and measurement can run against the final layout in one pass,
   * with no render in between.
   */
  const applyLayout = useCallback(() => {
    const frame = frameRef.current;
    const host = hostRef.current;
    if (!frame || !host) return;
    const s = fit ? Math.min(1, frame.clientWidth / PAGE_W_PX) : 1;
    host.style.transform = `scale(${s})`;
    alignTabStops(host, s);
    const next = measure(host);
    markPageBoundary(host, next.overflowIn > 0);
    setScale(s);
    setFrameHeight(host.scrollHeight * s);
    setLayout(next);
  }, [fit, measure]);

  // Held in a ref so the render effect below does not depend on it: applyLayout
  // is rebuilt whenever `fit` flips, and depending on it directly made the zoom
  // toggle re-fetch and re-render the entire document.
  const applyLayoutRef = useRef(applyLayout);
  useEffect(() => {
    applyLayoutRef.current = applyLayout;
  }, [applyLayout]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setPhase({ kind: "loading" });
    setLayout(null);

    void (async () => {
      try {
        const [{ renderAsync }, resp] = await Promise.all([
          import("docx-preview"),
          fetch(url),
        ]);
        if (!resp.ok) throw new Error(`could not fetch the document (HTTP ${resp.status})`);
        const blob = await resp.blob();
        if (cancelled) return;
        host.replaceChildren();
        await renderAsync(blob, host, undefined, {
          // Leave `className` at its default ("docx") so the wrapper is
          // `.docx-wrapper` and the overrides below actually bind.
          inWrapper: true,
          breakPages: true,
          ignoreWidth: false,
          ignoreHeight: false,
          renderHeaders: true,
          renderFooters: true,
          // Needed for the `docx-tab-stop` spans alignTabStops works on.
          experimental: true,
        });
        if (cancelled) return;
        // docx-preview's own tab pass is deferred; let it land first so ours is
        // the one that sticks.
        timer = setTimeout(() => {
          if (cancelled) return;
          applyLayoutRef.current();
          setPhase({ kind: "ready" });
        }, TAB_SETTLE_MS);
      } catch (err) {
        if (cancelled) return;
        setPhase({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        onFailed?.();
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [url, onFailed]);

  // Re-fit on container resize and on the zoom toggle.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || phase.kind !== "ready") return;
    applyLayout();
    const ro = new ResizeObserver(() => applyLayout());
    ro.observe(frame);
    return () => ro.disconnect();
  }, [applyLayout, phase.kind]);

  const overflows = (layout?.pages ?? 1) > 1;

  return (
    <div>
      <style>{`
        .docx-host .docx-wrapper { background: transparent; padding: 0; display: block; }
        /* overflow: visible undoes docx-preview's clipping so content that runs
           past the page boundary is actually shown, below the dashed rule,
           instead of disappearing. */
        .docx-host .docx-wrapper > section {
          margin: 0 0 14px; box-shadow: 0 2px 16px rgb(0 0 0 / 0.3);
          overflow: visible;
        }
      `}</style>

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        {phase.kind === "loading" && (
          <span className="text-[11.5px] text-ink-2">Rendering the document...</span>
        )}
        {phase.kind === "ready" && layout && (
          <span
            className={cn(
              "inline-block rounded-full px-2 py-px text-[10.5px] font-semibold",
              overflows
                ? "bg-[color-mix(in_srgb,var(--color-amber)_13%,transparent)] text-amber"
                : "bg-[color-mix(in_srgb,var(--color-accent)_13%,transparent)] text-accent",
            )}
          >
            {overflows
              ? `${layout.pages} pages - ${layout.overflowIn.toFixed(2)}" past page 1`
              : "Fits on one page"}
          </span>
        )}
        {phase.kind !== "error" && (
          <button
            type="button"
            onClick={() => setFit((f) => !f)}
            className="cursor-pointer rounded-md border border-line px-2 py-0.5 text-[11.5px] text-ink-2 transition-colors hover:text-ink"
          >
            {fit ? `Fit (${Math.round(scale * 100)}%)` : "Actual size"}
          </button>
        )}
      </div>

      {phase.kind === "error" && (
        <p className="mb-2 rounded-md border border-amber/45 bg-amber/10 px-3 py-2 text-[12px] text-amber">
          Could not render the .docx here ({phase.message}). Download it to
          check the layout.
        </p>
      )}

      <div ref={frameRef} className={cn("w-full", !fit && "overflow-x-auto")}>
        <div style={{ height: frameHeight ? `${frameHeight}px` : undefined }}>
          <div
            ref={hostRef}
            className="docx-host"
            style={{ width: `${PAGE_W_PX}px`, transformOrigin: "top left" }}
          />
        </div>
      </div>

      {phase.kind === "ready" && (
        <p className="mt-1 text-center text-[11px] text-ink-2">
          Rendered from the stored .docx. Line breaking is the browser&apos;s,
          not Word&apos;s - if it lands within a line of the boundary, confirm
          in Word.
        </p>
      )}
    </div>
  );
}
