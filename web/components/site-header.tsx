"use client";

// Sliding chip indicator behind the nav tabs, plus a one-pass sync sweep along
// the header's bottom edge each time the server hands over fresh data.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { UserChip } from "@/components/user-chip";
import { useAppView, viewHref, type AppView } from "@/lib/view";
import { useSyncPulse } from "@/lib/sync-pulse";

const NAV: { view: AppView; label: string }[] = [
  { view: "matches", label: "Matches" },
  { view: "tracker", label: "Tracker" },
];

function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const active = theme === "system" ? resolvedTheme : theme;
  const isDark = active === "dark";
  // The button's name and tooltip stay constant, because the server cannot
  // know the visitor's theme: deriving them from `resolvedTheme` renders
  // "Switch to dark mode" on the server and "Switch to light mode" on the
  // client, and React reports that as a hydration mismatch it will not patch.
  // The icons may still swap on state - they are driven by the `dark` class
  // next-themes sets before hydration, so they never disagree.
  return (
    <button
      type="button"
      title="Toggle theme"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="relative inline-flex h-7 w-7 items-center justify-center rounded-md border border-line bg-surface text-ink-2 transition-colors hover:bg-chip hover:text-ink"
    >
      <Sun className="h-[14px] w-[14px] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute h-[14px] w-[14px] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
      <span className="sr-only">Toggle theme</span>
    </button>
  );
}

export function SiteHeader({ trackerUser }: { trackerUser: string }) {
  const pathname = usePathname();
  const { view, show } = useAppView();
  const syncPulse = useSyncPulse();
  const navRef = useRef<HTMLElement>(null);
  const [ind, setInd] = useState<{ x: number; w: number } | null>(null);
  // No slide on first paint: transitions enable only after the first measure.
  const [animate, setAnimate] = useState(false);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const el = nav.querySelector<HTMLElement>('[data-active="1"]');
    if (el) setInd({ x: el.offsetLeft, w: el.offsetWidth });
    else setInd(null);
    const id = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(id);
  }, [pathname, view]);

  return (
    <header className="bg-surface">
      <div className="mx-auto flex w-full max-w-[1060px] flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
        <Link
          href="/"
          className="text-[17px] font-semibold tracking-[-0.01em] text-ink"
        >
          intern-watch{" "}
          <span className="font-normal text-ink-2">/ {trackerUser}</span>
        </Link>
        <nav ref={navRef} className="relative flex items-center gap-1">
          {/* sliding indicator (replaces the per-link bg-chip active fill) */}
          <span
            aria-hidden
            className="absolute top-0 left-0 h-full rounded-md bg-chip"
            style={{
              width: ind ? `${ind.w}px` : 0,
              transform: `translateX(${ind ? ind.x : 0}px)`,
              opacity: ind ? 1 : 0,
              transition: animate
                ? "transform .24s var(--ease-spring), width .24s var(--ease-spring), opacity .15s"
                : "none",
            }}
          />
          {NAV.map((n) => {
            // Both views live on "/", so nothing is active anywhere else (the
            // dev-only motion lab), same as before this became one route.
            const active = pathname === "/" && view === n.view;
            return (
              <Link
                key={n.view}
                href={viewHref(n.view)}
                data-active={active ? "1" : undefined}
                onClick={(e) => {
                  // Let the browser have modified clicks (new tab, new window)
                  // and let Link do a real navigation from anywhere that isn't
                  // the app route. Everything else switches in place.
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  if (pathname !== "/") return;
                  e.preventDefault();
                  show(n.view);
                }}
                className={cn(
                  "relative rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors",
                  active ? "text-ink" : "text-ink-2 hover:text-ink"
                )}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <UserChip trackerUser={trackerUser} />
        </div>
      </div>
      {/* Sync sweep: a 2px track standing in for the header's border-b, keyed
          by the sync counter so one pass runs per data load - the first paint
          and every refresh after it - and then it sits still as a plain rule.
          Swapping views syncs nothing, so it no longer replays there. */}
      <div className="relative h-[2px] overflow-hidden bg-line">
        <span
          key={syncPulse}
          aria-hidden
          className="absolute inset-y-0 left-0 w-[18%]"
          style={{
            background:
              "linear-gradient(90deg, transparent, var(--color-accent), transparent)",
            animation: "sweep 1.4s ease-in-out .1s 1 both",
          }}
        />
      </div>
    </header>
  );
}
