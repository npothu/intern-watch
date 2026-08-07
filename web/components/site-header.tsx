"use client";

// Sliding chip indicator behind the nav tabs, plus a one-pass sync sweep along
// the header's bottom edge each time the server hands over fresh data. Also
// carries the two smallest pieces of app chrome: the inbox pending badge and
// the pipeline-health dot (one dot + two words; everything else lives in a
// click popover so a degraded pipeline never costs more header space than a
// healthy one).
//
// Matches and Tracker are two views of the app route (lib/view.ts) - their
// tabs switch in place. Inbox and Resume are real routes and navigate.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { UserChip } from "@/components/user-chip";
import { useAppView, viewHref, type AppView } from "@/lib/view";
import { useSyncPulse } from "@/lib/sync-pulse";
import type { TrackerHealth } from "@/lib/convex";

type NavEntry =
  | { view: AppView; label: string }
  | { href: string; label: string };

const NAV: NavEntry[] = [
  { view: "matches", label: "Matches" },
  { view: "tracker", label: "Tracker" },
  { href: "/inbox", label: "Inbox" },
  { href: "/profile", label: "Resume" },
];

/** "47m" / "3h" / "2d" - compact age for the health line. */
function fmtAgo(ts: number | null | undefined): string {
  if (!ts) return "never";
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/** Fold the health payload to one dot color and a two-word summary. */
function summarize(h: TrackerHealth | null): {
  level: "ok" | "warn" | "bad";
  word: string;
} {
  if (!h) return { level: "warn", word: "no data" };
  const age = h.watcherPushedAt ? Date.now() - h.watcherPushedAt : Infinity;
  if (age > 48 * 3600_000) return { level: "bad", word: "watcher stalled" };
  if (h.mail?.lastError) return { level: "warn", word: "mail failing" };
  if (h.mail?.watchExpiration && h.mail.watchExpiration < Date.now()) {
    return { level: "warn", word: "mail watch expired" };
  }
  if (h.stuckBuilds > 0) return { level: "warn", word: "build stuck" };
  if (age > 6 * 3600_000) return { level: "warn", word: `quiet ${fmtAgo(h.watcherPushedAt)}` };
  return { level: "ok", word: `synced ${fmtAgo(h.watcherPushedAt)}` };
}

const DOT_TONE = {
  ok: "bg-accent",
  warn: "bg-amber",
  bad: "bg-red",
} as const;

function HealthDot({ health }: { health: TrackerHealth | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { level, word } = summarize(health);

  // Click-away + Escape both close; the popover is glanceable, not modal.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Pipeline health"
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] text-ink-2 tabular-nums transition-colors hover:bg-chip hover:text-ink"
      >
        <span className="relative flex h-2 w-2">
          {level !== "ok" && (
            <span
              className={cn(
                "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
                DOT_TONE[level]
              )}
              style={{ animationDuration: "2.4s" }}
            />
          )}
          <span className={cn("relative inline-flex h-2 w-2 rounded-full", DOT_TONE[level])} />
        </span>
        <span className="hidden sm:inline">{word}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-[calc(100%+8px)] z-50 w-[290px] origin-top-right animate-in fade-in-0 zoom-in-95 rounded-[10px] border border-line-2 bg-surface p-3.5 text-[12.5px] shadow-lg duration-150">
          <HealthRow k="Watcher" ok={level !== "bad"}>
            {health?.watcherPushedAt
              ? `ran ${fmtAgo(health.watcherPushedAt)} ago`
              : "no matches pushed yet"}
          </HealthRow>
          <HealthRow
            k="Mail sync"
            ok={!health?.mail?.lastError}
          >
            {health?.mail
              ? health.mail.lastError
                ? `failing: ${health.mail.lastError.slice(0, 60)}`
                : `push ${fmtAgo(health.mail.lastPushAt)} ago`
              : "not connected"}
          </HealthRow>
          <HealthRow k="Resume builds" ok={!health?.stuckBuilds}>
            {health?.stuckBuilds
              ? `${health.stuckBuilds} stuck >15m`
              : "none stuck"}
          </HealthRow>
          <HealthRow k="Inbox queue" ok>
            {health ? `${health.pendingInbox} pending` : "-"}
          </HealthRow>
          <p className="mt-2 border-t border-dashed border-line pt-2 text-[11.5px] leading-snug text-ink-2">
            An empty matches page with a green dot means no matches - with an
            amber or red dot it means the pipeline needs attention, not that
            nothing matched.
          </p>
        </div>
      )}
    </div>
  );
}

function HealthRow({
  k,
  ok,
  children,
}: {
  k: string;
  ok: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-dashed border-line py-1.5 first:border-t-0 first:pt-0">
      <span className="shrink-0 text-ink-2">{k}</span>
      <span className={cn("text-right font-medium tabular-nums", ok ? "text-ink" : "text-amber")}>
        {children}
      </span>
    </div>
  );
}

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

export function SiteHeader({
  trackerUser,
  inboxCount = 0,
  health = null,
}: {
  trackerUser: string;
  inboxCount?: number;
  health?: TrackerHealth | null;
}) {
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
            const isView = "view" in n;
            // Both views live on "/", so neither view tab is active anywhere
            // else; route tabs match on their own path prefix.
            const active = isView
              ? pathname === "/" && view === n.view
              : pathname.startsWith(n.href);
            return (
              <Link
                key={n.label}
                href={isView ? viewHref(n.view) : n.href}
                data-active={active ? "1" : undefined}
                onClick={(e) => {
                  // View tabs switch in place; let the browser have modified
                  // clicks (new tab, new window), and let Link do a real
                  // navigation from anywhere that isn't the app route.
                  if (!isView) return;
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
                {!isView && n.href === "/inbox" && inboxCount > 0 && (
                  <span
                    className="ml-1.5 inline-block min-w-[16px] rounded-full bg-accent px-1 text-center align-[1px] text-[10px] font-bold leading-[15px] text-accent-ink tabular-nums"
                    aria-label={`${inboxCount} pending inbox actions`}
                  >
                    {inboxCount > 9 ? "9+" : inboxCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <HealthDot health={health} />
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
