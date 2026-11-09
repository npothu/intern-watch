"use client";

// The header's pill nav: Matches, Tracker, Inbox, Profile, Referrals in one
// bordered rounded container, the active pill filled ink. Replaces the old
// icon view switch (view-switch.tsx), which every surface used to render in
// its own first row; the header now owns navigation on every screen.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAppView, viewHref, type AppView } from "@/lib/view";
import { useInboxPending, useViewCounts } from "./view-counts";

type NavId = AppView | "inbox" | "profile" | "referrals";

const NAV: { id: NavId; label: string; href: string }[] = [
  { id: "matches", label: "Matches", href: viewHref("matches") },
  { id: "tracker", label: "Tracker", href: viewHref("tracker") },
  { id: "inbox", label: "Inbox", href: viewHref("inbox") },
  { id: "profile", label: "Profile", href: "/profile" },
  { id: "referrals", label: "Referrals", href: viewHref("referrals") },
];

function activeNav(pathname: string, view: AppView): NavId | null {
  if (pathname === "/") return view;
  if (pathname.startsWith("/inbox")) return "inbox";
  if (pathname.startsWith("/profile")) return "profile";
  if (pathname.startsWith("/referrals")) return "referrals";
  return null; // Settings and the dev pages have no pill
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
  const inboxPending = useInboxPending();
  const active = activeNav(pathname, view);

  return (
    <nav
      aria-label="Views"
      className={cn(
        row
          ? "no-scrollbar flex items-center gap-1.5 overflow-x-auto px-4 pt-0.5 pb-2.5"
          : "flex items-center gap-0.5 rounded-full border border-line bg-surface p-[3px]",
        className
      )}
    >
      {NAV.map((item) => {
        const isActive = item.id === active;
        const count =
          item.id === "matches"
            ? counts.matches
            : item.id === "tracker"
              ? counts.tracker
              : item.id === "inbox" && inboxPending > 0
                ? inboxPending
                : undefined;
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
                  isActive
                    ? "opacity-80"
                    : item.id === "inbox"
                      ? "text-amber"
                      : "text-ink-2"
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
