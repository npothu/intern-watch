"use client";

import Link from "next/link";
import { useClerk, useUser } from "@clerk/nextjs";
import { RefreshCw, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Freshness } from "@/components/refresh-control";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** "NP" from a first/last name, else the first two letters of the fallback. */
function initialsOf(first: string | null | undefined, last: string | null | undefined, fallback: string) {
  const a = first?.trim()?.[0];
  const b = last?.trim()?.[0];
  if (a && b) return `${a}${b}`.toUpperCase();
  return (a ?? fallback.trim().slice(0, 2)).toUpperCase() || "?";
}

/**
 * The signed-in user chip in the header: initials in a 24px circle plus the
 * Clerk first name (or the tracker user key) in a 36px pill. On phones
 * (`compact`) it is the initials alone in a round button, and the menu also
 * carries what the phone header has no room for: the freshness readout and
 * its refresh, and the Settings link.
 */
export function UserChip({
  trackerUser,
  compact = false,
  freshness,
}: {
  trackerUser: string;
  compact?: boolean;
  /** Shown as a menu row when given (the phone header passes it). */
  freshness?: Freshness;
}) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const label = user?.firstName || trackerUser;
  const initials = initialsOf(user?.firstName, user?.lastName, label);
  const email = user?.primaryEmailAddress?.emailAddress;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          data-slot="user-chip"
          type="button"
          aria-label={compact ? `Account menu for ${label}` : undefined}
          className={cn(
            "inline-flex cursor-pointer items-center select-none transition-colors",
            compact
              ? "size-[34px] justify-center rounded-full bg-chip text-[11px] font-semibold text-ink hover:bg-line"
              : "h-9 gap-2 rounded-full border border-line bg-surface py-[5px] pr-2.5 pl-[5px] text-[13px] text-ink hover:border-line-2"
          )}
        >
          {compact ? (
            initials
          ) : (
            <>
              <span
                aria-hidden
                className="inline-flex size-6 items-center justify-center rounded-full bg-chip text-[11px] font-semibold text-ink"
              >
                {initials}
              </span>
              <span className="max-w-[12ch] truncate">{label}</span>
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          {email ? `Signed in as ${email}` : "Signed in"}
        </DropdownMenuLabel>
        {freshness && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={freshness.pending}
              onSelect={(e) => {
                e.preventDefault();
                freshness.refresh();
              }}
            >
              <RefreshCw className={cn("size-4 text-ink-2", freshness.pending && "animate-spin")} />
              <span className={cn("font-mono text-[11px] tracking-[0.06em] uppercase", freshness.stale ? "text-amber" : "text-ink-2")}>
                {freshness.label || "refresh"}
              </span>
              <span className="ml-auto text-xs text-ink-2">Refresh</span>
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Settings className="size-4 text-ink-2" />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => signOut()}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
