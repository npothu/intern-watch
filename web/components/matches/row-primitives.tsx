"use client";

import { useEffect, useState, type MouseEvent, type ReactNode } from "react";

/* Small pieces shared by the matches surface (triage.tsx), the dense table
   shell (dense-table.tsx) and the Matches columns (matches-table.tsx). */

export const COLLAPSE_MS = 300;

/* Ring that only a keyboard focus can earn, in the house accent. It replaces
   Chrome's UA `:focus-visible { outline: auto }`, which the base layer's
   `outline-ring/50` tints accent - that pairing is what painted the stuck
   "thick light border" on a clicked tick. */
export const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * Drops DOM focus after a pointer-driven activation.
 *
 * A clicked button keeps focus, and Chrome promotes a merely-focused element
 * to `:focus-visible` the moment the user touches the keyboard - which on this
 * surface is immediately, since the next thing they do is press j/k/x. The ring
 * then paints long after the click and reads as a highlight stuck on that one
 * tick. Keyboard activation (Enter/Space) reports `detail === 0`, so it keeps
 * focus and keeps the ring; only a real click gives it up. Nothing is lost -
 * the triage shortcuts are bound on window, not on the focused element.
 */
export function blurOnPointerActivate(e: MouseEvent<HTMLElement>) {
  if (e.detail > 0) e.currentTarget.blur();
}

/* Collapse shell. `open=false` collapses its child (grid-template-rows 0fr +
   fade); `enter` mounts closed and opens on the next frame (restore / undo
   reverse animation, and a details panel opening). Class `collapse-shell`
   drives the first-child border/padding rules in globals.css. */
export function CollapseShell({
  open,
  enter = false,
  children,
}: {
  open: boolean;
  enter?: boolean;
  children: ReactNode;
}) {
  const [ready, setReady] = useState(!enter);
  useEffect(() => {
    if (!ready) {
      const id = requestAnimationFrame(() => setReady(true));
      return () => cancelAnimationFrame(id);
    }
  }, [ready]);
  const expanded = open && ready;
  return (
    <div
      className="collapse-shell"
      style={{
        display: "grid",
        gridTemplateRows: expanded ? "1fr" : "0fr",
        transition: `grid-template-rows ${COLLAPSE_MS}ms var(--ease-out-soft)`,
      }}
    >
      <div
        style={{
          overflow: "hidden",
          minHeight: 0,
          opacity: expanded ? 1 : 0,
          // Leads the collapse slightly, so the row reads as fading out of the
          // list rather than being physically squashed shut.
          transition: `opacity ${Math.round(COLLAPSE_MS * 0.7)}ms linear`,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * A CollapseShell that is only mounted while it matters: it mounts closed
 * and opens when `open` turns true, and after closing it stays for the
 * collapse before unmounting. Keeps one panel's worth of DOM alive instead
 * of one per row.
 */
export function PresenceCollapse({ open, children }: { open: boolean; children: ReactNode }) {
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true); // adjust during render, no flash
  useEffect(() => {
    if (open || !present) return;
    const t = window.setTimeout(() => setPresent(false), COLLAPSE_MS);
    return () => window.clearTimeout(t);
  }, [open, present]);
  if (!present) return null;
  return (
    <CollapseShell open={open} enter>
      {children}
    </CollapseShell>
  );
}
