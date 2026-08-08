"use client";

// The three-way switch between the app's surfaces that change without the
// user asking - Matches (2h cron), Tracker (an employer reply), Inbox (a
// Gmail push). Resume deliberately has no cell: it only ever changes when the
// user edits it, so it moved to the command palette instead (see the "Open
// Resume" palette action in triage.tsx / tracker.tsx).
//
// Replaces the header's old four-tab nav (site-header.tsx used to own this
// sliding-chip indicator); the switch now travels with each surface instead,
// landing in whatever row already sits at the top of that surface so it costs
// no extra vertical space.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useAppView, VIEWS, type ViewId } from "@/lib/view";
import { useInboxPending } from "./view-counts";

export function ViewSwitch({
  active,
  count,
  className,
}: {
  /** The view this page is showing; null on Resume, which has no cell. */
  active: ViewId | null;
  /** The active view's own count, shown inline. Ignored for "inbox" - that
   *  cell always reads the shared pending count instead, so its active count
   *  and its inactive badge never disagree. */
  count?: number;
  className?: string;
}) {
  const pathname = usePathname();
  const { show } = useAppView();
  const inboxPending = useInboxPending();

  const railRef = useRef<HTMLElement>(null);
  const [rail, setRail] = useState<{ x: number; w: number } | null>(null);
  // No slide on first paint: the transition enables only after the first
  // measure, same gate the header's old indicator used.
  const [animate, setAnimate] = useState(false);

  useLayoutEffect(() => {
    const el = railRef.current?.querySelector<HTMLElement>('[data-active="1"]');
    setRail(el ? { x: el.offsetLeft, w: el.offsetWidth } : null);
    const id = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(id);
  }, [active]);

  return (
    <nav
      ref={railRef}
      aria-label="Views"
      className={cn(
        "relative inline-flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5",
        className
      )}
    >
      {/* Sliding bg-chip fill behind the active cell - same treatment and
          easing as the header's old tab indicator, just scoped to this
          control. The active cell is wider (icon + label + count vs. icon
          alone), so this animates width as well as position. */}
      <span
        aria-hidden
        className="absolute inset-y-0.5 left-0 rounded-md bg-chip"
        style={{
          width: rail ? `${rail.w}px` : 0,
          transform: `translateX(${rail ? rail.x : 0}px)`,
          opacity: rail ? 1 : 0,
          transition: animate
            ? "transform .2s var(--ease-spring), width .2s var(--ease-spring), opacity .15s"
            : "none",
        }}
      />
      {VIEWS.map((v) => {
        const isActive = active === v.id;
        const Icon = v.icon;
        const displayCount = v.id === "inbox" ? inboxPending : count;
        const badge = !isActive && v.id === "inbox" && inboxPending > 0;
        return (
          <Link
            key={v.id}
            href={v.href}
            data-active={isActive ? "1" : undefined}
            aria-current={isActive ? "page" : undefined}
            aria-label={isActive ? undefined : v.label}
            title={isActive ? undefined : v.label}
            onClick={(e) => {
              // Inbox is a real navigation - let Link do its thing. Matches
              // and Tracker switch in place while already on "/"; anywhere
              // else, and on any modified click, a real navigation is right.
              if (v.id === "inbox") return;
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              if (pathname !== "/") return;
              e.preventDefault();
              show(v.id);
            }}
            className={cn(
              "relative z-10 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] font-medium transition-colors",
              isActive ? "text-ink" : "text-ink-2 hover:text-ink"
            )}
          >
            <span className="relative flex shrink-0">
              <Icon className="size-4" />
              {badge && (
                <span
                  aria-hidden
                  className="absolute -top-1.5 -right-1.5 min-w-[13px] rounded-full bg-accent px-[3px] text-center text-[9px] leading-[13px] font-bold text-accent-ink tabular-nums"
                >
                  {inboxPending > 9 ? "9+" : inboxPending}
                </span>
              )}
            </span>
            {isActive && (
              <>
                <span>{v.label}</span>
                {typeof displayCount === "number" && (
                  <span className="text-ink-2 tabular-nums">{displayCount}</span>
                )}
              </>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
