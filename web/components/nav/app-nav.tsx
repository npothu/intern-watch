"use client";

// The header's pill nav: the `nav` entries of the view registry (lib/view.ts
// VIEWS - Matches, Tracker, Inbox, Profile, Referrals) in one bordered rounded
// container, the active pill filled ink. The header owns navigation on every
// screen; no surface renders its own switch any more.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAppView, VIEWS, type AppView, type DestId } from "@/lib/view";
import { useViewCounts } from "./view-counts";

const NAV = VIEWS.filter((v) => v.nav);

function activeDest(pathname: string, view: AppView): DestId | null {
  if (pathname === "/") return view;
  // Longest-prefix match against the registry's routes (Settings has no pill,
  // so it simply never matches one).
  const hit = NAV.find((v) => v.href !== "/" && !v.href.includes("?") && pathname.startsWith(v.href));
  return hit?.id ?? null;
}

export function AppNav({
  variant = "group",
  className,
}: {
  /** "group": one bordered container (desktop). "row": separate bordered
   *  pills in a horizontally scrolling row with no visible bar (phones). */
  variant?: "group" | "row";
  className?: string;
}) {
  const row = variant === "row";
  const pathname = usePathname();
  const { view, show } = useAppView();
  const counts = useViewCounts();
  const active = activeDest(pathname, view);

  return (
    <nav
      aria-label="Views"
      className={cn(
        row
          ? "no-scrollbar flex items-center gap-1.5 overflow-x-auto px-4 pt-2.5 pb-1"
          : "flex items-center gap-0.5 rounded-full border border-line bg-surface p-[3px]",
        className
      )}
    >
      {NAV.map((item) => {
        const isActive = item.id === active;
        const count = item.count?.(counts);
        return (
          <Link
            key={item.id}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            onClick={(e) => {
              // Matches and Tracker switch in place while already on "/";
              // anywhere else, and on any modified click, navigate for real.
              if (item.id !== "matches" && item.id !== "tracker") return;
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              if (pathname !== "/") return;
              e.preventDefault();
              show(item.id);
            }}
            className={cn(
              "inline-flex min-h-[30px] shrink-0 items-center gap-2 rounded-full px-3 py-1.5 text-[13px] whitespace-nowrap transition-colors",
              "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
              row && "border",
              isActive
                ? "border-ink bg-ink font-medium text-bg"
                : cn("text-ink hover:bg-chip", row && "border-line bg-surface")
            )}
          >
            {item.label}
            {typeof count === "number" && (
              <span
                className={cn(
                  "font-mono text-[11px] tabular-nums",
                  isActive ? "opacity-80" : item.countTone === "amber" ? "text-amber" : "text-ink-2"
                )}
              >
                {count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
