"use client";

// The app shell header, shared by every screen. Four things, left to right:
// where you are (brand, the pill nav in nav/app-nav.tsx), the "Search, jump,
// or paste a job URL" button that opens the command palette, one status chip
// (watcher-status.tsx: is the data fresh, and Refresh), and you (the avatar
// menu in user-chip.tsx: Settings, theme, Sign out). It runs edge to edge
// (no content-width cap).
//
// Below 700px it folds to the phone layout: brand left, the status chip, a
// round search button and the avatar right, then the hairline, and the nav
// below it as its own horizontally scrolling row. Both layouts are
// server-rendered and CSS picks one, like the Matches table.
//
// While the watcher is stalled a one-line banner sits under the header on
// every screen: it is the one state where the lists look normal and are not.
//
// It also mounts the two app-wide overlays the search box leads to: the
// shell's fallback command palette (navigation only; a surface's own palette
// takes over while one is mounted) and the one Add URL dialog.

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { UserChip } from "@/components/user-chip";
import { AppNav } from "@/components/nav/app-nav";
import { useFreshness } from "@/components/refresh-control";
import { STATUS_SELECTOR, StatusDot, WatcherStatusChip } from "@/components/watcher-status";
import type { PulseRun } from "@/lib/watcher-pulse";
import { stalledNotice, watcherStatus } from "@/lib/watcher-status";
import { useClock } from "@/lib/use-minute";
import {
  CommandPalette,
  openCommandPalette,
  type PaletteAction,
} from "@/components/command-palette";
import { AddUrlDialog } from "@/components/matches/add-url-dialog";
import { useSyncPulse } from "@/lib/sync-pulse";
import { VIEWS } from "@/lib/view";
import type { TrackerHealth } from "@/lib/convex";

/**
 * The wordmark with a square "ib" mark. Not a dot: a green dot beside the
 * name read as a second status light next to the real one.
 */
function Brand() {
  return (
    <Link
      href="/"
      className="inline-flex shrink-0 items-center gap-[9px] font-semibold tracking-[-0.01em] text-ink"
    >
      <span
        aria-hidden
        className="inline-flex size-[22px] items-center justify-center rounded-md bg-accent font-mono text-[10.5px] leading-none font-medium tracking-[-0.02em] text-accent-ink"
      >
        ib
      </span>
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
      aria-label="Search, jump, or paste a job URL"
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
        <span className="truncate">Search, jump, or paste a job URL</span>
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
  renderedAt,
}: {
  trackerUser: string;
  health?: TrackerHealth | null;
  /** The watcher's last day of runs for the sparkline, streamed (never rejects). */
  runs?: Promise<PulseRun[]>;
  /** The layout's server render time: "now" for the first paint, and the end
   *  of the sparkline's window. */
  renderedAt: number;
}) {
  const syncPulse = useSyncPulse();
  const freshness = useFreshness();
  // Server time on first paint, the visitor's minute tick after, so the
  // chip's "38m ago" hydrates to the same text the server sent.
  const clock = useClock(renderedAt);
  const status = watcherStatus(health, clock, freshness.stale);
  const notice = stalledNotice(health, clock);

  // One open state for both layouts' chips. Click-away and Escape close it;
  // the popover is glanceable, not modal.
  const [statusOpen, setStatusOpen] = useState(false);
  useEffect(() => {
    if (!statusOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.(STATUS_SELECTOR)) setStatusOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setStatusOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [statusOpen]);

  const chip = (compact: boolean) => (
    <WatcherStatusChip
      status={status}
      open={statusOpen}
      onOpenChange={setStatusOpen}
      health={health}
      runs={runs}
      renderedAt={renderedAt}
      clock={clock}
      freshness={freshness}
      compact={compact}
    />
  );

  return (
    <header className="relative bg-bg">
      {/* Desktop and tablet, edge to edge, in deliberate bands:
            700-1023   a two-row grid: brand, nav (scrolls sideways if it
                       must) and the tools right-aligned; then the search
                       button full width
            1024+      one row; the search keeps at least 200px
          Below 1200 the gaps are 12px and the status chip shows its short
          label ("38m ago" rather than "Checked 38m ago"). */}
      <div className="hidden grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-3 px-6 py-3 min-[700px]:grid min-[1024px]:flex min-[1024px]:flex-nowrap min-[1200px]:gap-x-4 min-[1400px]:gap-x-6">
        <div className="col-start-1 row-start-1 shrink-0 min-[1400px]:min-w-[140px]">
          <Brand />
        </div>
        <AppNav className="no-scrollbar col-start-2 row-start-1 max-w-full shrink-0 justify-self-start overflow-x-auto" />
        <SearchButton className="col-span-3 row-start-2" />
        <div className="col-start-3 row-start-1 flex shrink-0 items-center gap-2 justify-self-end min-[1024px]:ml-auto">
          {chip(false)}
          <UserChip trackerUser={trackerUser} />
        </div>
      </div>
      <SweepRule pulse={syncPulse} className="hidden min-[700px]:block" />

      {/* Phones (MobileCards.dc.html): brand, then the status chip, a round
          search button and the avatar, the hairline, then the nav as its own
          scrolling row below it. */}
      <div className="min-[700px]:hidden">
        <div className="flex items-center justify-between gap-2 px-4 py-2.5">
          <Brand />
          <div className="flex items-center gap-1.5">
            {chip(true)}
            <button
              type="button"
              onClick={openCommandPalette}
              aria-label="Search, jump, or paste a job URL"
              aria-haspopup="dialog"
              aria-keyshortcuts="Control+K Meta+K"
              className="inline-flex size-[34px] cursor-pointer items-center justify-center rounded-full border border-line bg-surface text-ink-2"
            >
              <Search aria-hidden className="size-3.5" />
            </button>
            <UserChip trackerUser={trackerUser} />
          </div>
        </div>
        <SweepRule pulse={syncPulse} />
        <AppNav variant="row" />
      </div>

      {notice && (
        <div
          role="status"
          className="flex items-center gap-2.5 border-b border-line bg-red/10 px-4 py-2 text-[12.5px] text-ink min-[700px]:px-6"
        >
          <StatusDot level="bad" />
          <span className="min-w-0">{notice}</span>
          <button
            type="button"
            data-watcher-status
            onClick={() => setStatusOpen(true)}
            className="ml-auto shrink-0 cursor-pointer underline underline-offset-[3px]"
          >
            See details
          </button>
        </div>
      )}

      <ShellPalette />
      <AddUrlDialog />
    </header>
  );
}
