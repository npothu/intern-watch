"use client";

// The app shell header, shared by every screen: brand, the pill nav
// (nav/app-nav.tsx), the "Search or paste a URL" button that opens the
// command palette, then pipeline health, the freshness readout, theme,
// Settings and the user chip. It runs edge to edge (no content-width cap).
//
// Below 700px it folds to the phone layout: brand left, a round search button
// and the avatar right, and the nav as its own horizontally scrolling row. The
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
import {
  FileText,
  LayoutList,
  ListChecks,
  Mail,
  Moon,
  Search,
  Settings,
  Sun,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { UserChip } from "@/components/user-chip";
import { AppNav } from "@/components/nav/app-nav";
import { FreshnessReadout, useFreshness } from "@/components/refresh-control";
import {
  CommandPalette,
  openCommandPalette,
  type PaletteAction,
} from "@/components/command-palette";
import { AddUrlDialog } from "@/components/matches/add-url-dialog";
import { useSyncPulse } from "@/lib/sync-pulse";
import { viewHref } from "@/lib/view";
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

/** The design's search "input": really a button that opens the palette. */
function SearchButton() {
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      aria-label="Search or paste a URL"
      aria-keyshortcuts="Control+K Meta+K"
      className="flex min-h-[38px] max-w-[420px] flex-[1_1_240px] cursor-pointer items-center justify-between gap-3 rounded-lg border border-line bg-surface py-2 pr-2.5 pl-3.5 text-left text-[13px] text-ink-2 transition-colors hover:border-line-2 focus-visible:border-accent focus-visible:outline-none"
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
 * Profile, Referrals, Settings). Inert while Matches or Tracker is mounted -
 * those palettes carry the same moves plus their row jumps.
 */
function ShellPalette() {
  const router = useRouter();
  const go = (href: string) => () => router.push(href);
  const actions: PaletteAction[] = [
    { id: "matches", label: "Go to Matches", icon: <LayoutList className="size-4" />, run: go(viewHref("matches")) },
    { id: "tracker", label: "Go to Tracker", icon: <ListChecks className="size-4" />, run: go(viewHref("tracker")) },
    { id: "inbox", label: "Go to Inbox", icon: <Mail className="size-4" />, run: go(viewHref("inbox")) },
    { id: "profile", label: "Go to Profile", icon: <FileText className="size-4" />, run: go("/profile") },
    { id: "referrals", label: "Go to Referrals", icon: <Users className="size-4" />, run: go(viewHref("referrals")) },
    { id: "settings", label: "Open Settings", icon: <Settings className="size-4" />, run: go("/settings") },
  ];
  return <CommandPalette fallback jumps={[]} onJump={() => {}} actions={actions} />;
}

export function SiteHeader({
  trackerUser,
  health = null,
}: {
  trackerUser: string;
  health?: TrackerHealth | null;
}) {
  const syncPulse = useSyncPulse();
  const freshness = useFreshness();

  return (
    <header className="relative bg-bg">
      {/* Desktop and tablet: one wrapping row, edge to edge. */}
      <div className="hidden flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3 min-[700px]:flex">
        <div className="min-w-[140px]">
          <Brand />
        </div>
        <AppNav />
        <SearchButton />
        <div className="ml-auto flex items-center gap-2">
          <HealthDot health={health} />
          <FreshnessReadout freshness={freshness} className="mr-1.5" />
          <ThemeToggle />
          <Link
            href="/settings"
            className="inline-flex min-h-9 items-center rounded-full border border-line px-3 font-mono text-[11px] tracking-[0.06em] text-ink-2 uppercase transition-colors hover:border-line-2 hover:text-ink"
          >
            Settings
          </Link>
          <UserChip trackerUser={trackerUser} />
        </div>
      </div>

      {/* Phones: brand + round search + avatar, then the nav as a row. */}
      <div className="min-[700px]:hidden">
        <div className="flex items-center justify-between gap-2 px-4 py-2.5">
          <Brand />
          <div className="flex items-center gap-2">
            <HealthDot health={health} />
            <button
              type="button"
              onClick={openCommandPalette}
              aria-label="Search or paste a URL"
              className="inline-flex size-[34px] cursor-pointer items-center justify-center rounded-full border border-line bg-surface text-ink-2"
            >
              <Search aria-hidden className="size-3.5" />
            </button>
            <UserChip trackerUser={trackerUser} compact freshness={freshness} />
          </div>
        </div>
        <AppNav variant="row" />
      </div>

      {/* Sync sweep: a hairline track standing in for the header's bottom
          border, keyed by the sync counter so one pass runs per data load -
          the first paint and every refresh after it - and then it sits
          still as a plain rule. */}
      <div className="relative h-px overflow-hidden bg-line">
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

      <ShellPalette />
      <AddUrlDialog />
    </header>
  );
}
