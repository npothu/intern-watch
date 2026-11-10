"use client";

import Link from "next/link";
import { useClerk, useUser } from "@clerk/nextjs";
import { useTheme } from "next-themes";
import { Settings } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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

const THEMES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;

/**
 * The signed-in user in the header: initials in a round button, at every
 * width. Its menu holds everything about the account and the app's look that
 * used to take three header buttons: who is signed in, Settings, the theme
 * (the same next-themes preference Settings > Theme sets) and Sign out.
 */
export function UserChip({ trackerUser }: { trackerUser: string }) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const { theme, setTheme } = useTheme();
  const label = user?.firstName || trackerUser;
  const initials = initialsOf(user?.firstName, user?.lastName, label);
  const email = user?.primaryEmailAddress?.emailAddress;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          data-slot="user-chip"
          type="button"
          aria-label={`Account menu for ${label}`}
          className="inline-flex size-[34px] cursor-pointer items-center justify-center rounded-full border border-line-2 bg-surface font-mono text-[11px] font-medium text-ink transition-colors select-none hover:border-ink-2 min-[700px]:size-9"
        >
          {initials}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          {email ? `Signed in as ${email}` : "Signed in"}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Settings className="size-4 text-ink-2" />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-mono text-[10.5px] font-medium tracking-[0.08em] text-ink-2 uppercase">
          Theme
        </DropdownMenuLabel>
        {/* The menu only mounts once opened, on the client, so `theme` is
            already known here; picking one keeps the menu open so the change
            is seen. */}
        <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
          {THEMES.map((t) => (
            <DropdownMenuRadioItem key={t.value} value={t.value} onSelect={(e) => e.preventDefault()}>
              {t.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => signOut()}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
