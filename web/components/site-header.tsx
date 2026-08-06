"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { UserChip } from "@/components/user-chip";

const NAV = [
  { href: "/", label: "Matches" },
  { href: "/tracker", label: "Tracker" },
];

/** Identity-styled app header: brand + nav tabs + signed-in user chip. */
export function SiteHeader({ trackerUser }: { trackerUser: string }) {
  const pathname = usePathname();

  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex w-full max-w-[1060px] flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
        <Link
          href="/"
          className="text-[17px] font-semibold tracking-[-0.01em] text-ink"
        >
          intern-watch{" "}
          <span className="font-normal text-ink-2">/ {trackerUser}</span>
        </Link>
        <nav className="flex items-center gap-1">
          {NAV.map((n) => {
            const active =
              n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={cn(
                  "rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors",
                  active
                    ? "bg-chip text-ink"
                    : "text-ink-2 hover:bg-chip/60 hover:text-ink"
                )}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto">
          <UserChip trackerUser={trackerUser} />
        </div>
      </div>
    </header>
  );
}
