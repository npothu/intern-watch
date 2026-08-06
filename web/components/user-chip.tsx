"use client";

import { useClerk, useUser } from "@clerk/nextjs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The signed-in user chip in the header: shows the resolved tracker user key
 * (or the Clerk first name), with a dropdown to see the email and sign out.
 * Deliberately not an avatar - the identity forbids avatars.
 */
export function UserChip({ trackerUser }: { trackerUser: string }) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const label = user?.firstName || trackerUser;
  const email = user?.primaryEmailAddress?.emailAddress;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          data-slot="user-chip"
          type="button"
          className="inline-flex items-center rounded-md border border-line-2 px-2.5 py-1 text-xs font-medium text-ink-2 transition-colors hover:border-ink-2 hover:text-ink select-none"
        >
          {label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          {email ? `Signed in as ${email}` : "Signed in"}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => signOut()}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
