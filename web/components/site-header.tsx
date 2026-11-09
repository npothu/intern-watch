"use client";

// The app shell header, shared by every screen: brand, the pill nav
// (nav/app-nav.tsx), the "Search or paste a URL" button that opens the
// command palette, then pipeline health, the freshness readout, theme,
// Settings and the user chip. It runs edge to edge (no content-width cap).
//
// Below 700px it folds to the phone layout: brand left, a round search button
// and the avatar right, then the hairline, and the nav below it as its own
// horizontally scrolling row. The
// freshness readout and the Settings link move into the avatar's menu there.
// Both layouts are server-rendered and CSS picks one, like the Matches table.
//
// It also mounts the two app-wide overlays the search box leads to: the
// shell's fallback command palette (navigation only; a surface's own palette
// takes over while one is mounted) and the one Add URL dialog.

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Moon, Search, Settings, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { UserChip } from "@/components/user-chip";
import { AppNav } from "@/components/nav/app-nav";
import { FreshnessReadout, useFreshness } from "@/components/refresh-control";
import { WatcherPulse } from "@/components/watcher-pulse";
import type { PulseRun } from "@/lib/watcher-pulse";
import {
  CommandPalette,
  openCommandPalette,
  type PaletteAction,
} from "@/components/command-palette";
import { AddUrlDialog } from "@/components/matches/add-url-dialog";
import { useSyncPulse } from "@/lib/sync-pulse";
import { VIEWS } from "@/lib/view";
import type { TrackerHealth } from "@/lib/convex";

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

/**
 * Pipeline health as a bare dot (the old header also printed the summary
 * word; the design's header has no room for it, so it rides the tooltip and
 * the popover). Kept because an empty Matches page means "nothing matched"
 * only while this dot is green.
 */
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
        title={`Pipeline health: ${word}`}
        aria-label={`Pipeline health: ${word}`}
        className="inline-flex size-7 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-chip"
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
      className="relative inline-flex size-9 cursor-pointer items-center justify-center rounded-full border border-line bg-surface text-ink-2 transition-colors hover:border-line-2 hover:text-ink"
    >
      <Sun className="h-[14px] w-[14px] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute h-[14px] w-[14px] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
      <span className="sr-only">Toggle theme</span>
    </button>
  );
}

function Brand() {
  return (
    <Link
      href="/"
      className="inline-flex shrink-0 items-center gap-2.5 font-semibold tracking-[-0.01em] text-ink"
    >
      <span aria-hidden className="size-2.5 rounded-full bg-accent" />
      intern-baddie
    </Link>
  );
}

/**
 * The design's search "input": really a button that opens the palette.
 *   700-1023   the header's second row, full width
 *   1024-1399  flex 1 1 200px, at most 320px, never under 200px
 *   1400+      the design's flex 1 1 240px, up to 420px
 * The label truncates and the keycap never shrinks, so the keycap always
 * paints inside the box.
 */
function SearchButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      aria-label="Search or paste a URL"
      aria-haspopup="dialog"
      aria-keyshortcuts="Control+K Meta+K"
      className={cn(
        "flex min-h-[38px] w-full min-w-0 cursor-pointer items-center justify-between gap-3 overflow-hidden rounded-lg border border-line bg-surface py-2 pr-2.5 pl-3.5 text-left text-[13px] text-ink-2 transition-colors hover:border-line-2 focus-visible:border-accent focus-visible:outline-none",
        "min-[1024px]:w-auto min-[1024px]:max-w-[320px] min-[1024px]:min-w-[200px] min-[1024px]:flex-[1_1_200px]",
        "min-[1400px]:max-w-[420px] min-[1400px]:flex-[1_1_240px]",
        className
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <Search aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">Search or paste a URL</span>
      </span>
      <kbd className="shrink-0 rounded border border-line bg-bg px-1.5 py-0.5 font-mono text-[11px] text-ink">
        ⌘K
      </kbd>
    </button>
  );
}

/**
 * Navigation-only palette for screens without one of their own (Inbox,
 * Profile, Settings), built from the view registry. Inert while the Matches,
 * Tracker or Referrals palette is mounted - those carry the same moves plus
 * their own jumps.
 */
function ShellPalette() {
  const router = useRouter();
  const actions: PaletteAction[] = VIEWS.map((v) => ({
    id: v.id,
    label: v.paletteLabel,
    icon: <v.icon className="size-4" />,
    run: () => router.push(v.href),
  }));
  return <CommandPalette fallback jumps={[]} onJump={() => {}} actions={actions} />;
}

/**
 * The header's bottom rule, doubling as the sync sweep: keyed by the sync
 * counter so one pass runs per data load - the first paint and every refresh
 * after it - and then it sits still as a plain hairline.
 */
function SweepRule({ pulse, className }: { pulse: number; className?: string }) {
  return (
    <div className={cn("relative h-px overflow-hidden bg-line", className)}>
      <span
        key={pulse}
        aria-hidden
        className="absolute inset-y-0 left-0 w-[18%]"
        style={{
          background: "linear-gradient(90deg, transparent, var(--color-accent), transparent)",
          animation: "sweep 1.4s ease-in-out .1s 1 both",
        }}
      />
    </div>
  );
}

export function SiteHeader({
  trackerUser,
  health = null,
  runs,
}: {
  trackerUser: string;
  health?: TrackerHealth | null;
  /** The watcher's last day of runs for the sparkline, streamed (never rejects). */
  runs?: Promise<PulseRun[]>;
}) {
  const syncPulse = useSyncPulse();
  const freshness = useFreshness();

  return (
    <header className="relative bg-bg">
      {/* Desktop and tablet, edge to edge, in deliberate bands:
            700-1023   a two-row grid: brand, nav (scrolls sideways if it
                       must) and the tools right-aligned; then the search
                       button full width
            1024+      one row; the search keeps at least 200px
          Below 1200 the gaps are 12px, the freshness text hides behind its
          refresh button's tooltip and the user chip is initials only; below
          1400 Settings is icon-only. */}
      <div className="hidden grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 px-6 py-3 min-[700px]:grid min-[1024px]:flex min-[1024px]:flex-nowrap min-[1200px]:gap-x-4 min-[1400px]:gap-x-6">
        <div className="col-start-1 row-start-1 shrink-0 min-[1400px]:min-w-[140px]">
          <Brand />
        </div>
        <AppNav className="no-scrollbar col-start-2 row-start-1 max-w-full shrink-0 justify-self-start overflow-x-auto" />
        <SearchButton className="col-span-3 row-start-2" />
        <div className="col-start-3 row-start-1 flex shrink-0 items-center gap-2 justify-self-end min-[1024px]:ml-auto">
          <HealthDot health={health} />
          {runs && <WatcherPulse runs={runs} className="mr-1" />}
          <FreshnessReadout freshness={freshness} className="min-[1200px]:mr-1.5" />
          <ThemeToggle />
          <Link
            href="/settings"
            aria-label="Settings"
            title="Settings"
            className="inline-flex size-9 items-center justify-center rounded-full border border-line text-ink-2 transition-colors hover:border-line-2 hover:text-ink min-[1400px]:w-auto min-[1400px]:px-3"
          >
            <Settings aria-hidden className="size-3.5 min-[1400px]:hidden" />
            <span aria-hidden className="hidden font-mono text-[11px] tracking-[0.06em] uppercase min-[1400px]:inline">
              Settings
            </span>
          </Link>
          <UserChip trackerUser={trackerUser} />
        </div>
      </div>
      <SweepRule pulse={syncPulse} className="hidden min-[700px]:block" />

      {/* Phones (MobileCards.dc.html): brand + round search + avatar, the
          hairline, then the nav as its own scrolling row below it. */}
      <div className="min-[700px]:hidden">
        <div className="flex items-center justify-between gap-2 px-4 py-2.5">
          <Brand />
          <div className="flex items-center gap-2">
            <HealthDot health={health} />
            <button
              type="button"
              onClick={openCommandPalette}
              aria-label="Search or paste a URL"
              aria-haspopup="dialog"
              aria-keyshortcuts="Control+K Meta+K"
              className="inline-flex size-[34px] cursor-pointer items-center justify-center rounded-full border border-line bg-surface text-ink-2"
            >
              <Search aria-hidden className="size-3.5" />
            </button>
            <UserChip trackerUser={trackerUser} compact freshness={freshness} />
          </div>
        </div>
        <SweepRule pulse={syncPulse} />
        <AppNav variant="row" />
      </div>

      <ShellPalette />
      <AddUrlDialog />
    </header>
  );
}
