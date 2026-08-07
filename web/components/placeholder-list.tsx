"use client";

import { Skeleton } from "@/components/ui/skeleton";

/**
 * Placeholder skeleton row list for the stub / and /tracker pages. The
 * scaffolding agents drop in the real row rendering in a later pass.
 */
export function PlaceholderList({ rows = 8 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-md border border-line bg-surface">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-start gap-3 border-t border-line px-3 py-2.5 first:border-t-0"
        >
          <Skeleton className="mt-1 h-[17px] w-[17px] shrink-0" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="mt-1.5 h-3 w-full" />
            <Skeleton className="mt-1.5 h-2.5 w-2/3" />
          </div>
          <Skeleton className="h-6 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}
