"use client";

import { cn } from "@/lib/utils";

/**
 * The rounded-full filter pill row shared by the matches term filter and the
 * tracker status filter, so both surfaces stay one visual language: the active
 * pill is a filled accent chip with its paired ink, the rest are outlined and
 * muted on the surface colour.
 *
 * Counts are optional - a pill renders as "Label 4" when the caller supplies
 * one, and as a bare label when it does not. A pill whose count is zero drops
 * back a step in contrast so the row reads as "nothing here" rather than
 * broken; it stays clickable, and selecting it shows the empty state.
 */

export type PillOption = {
  key: string;
  label: string;
  count?: number;
};

export function FilterPills({
  options,
  value,
  onChange,
  label,
  className,
}: {
  options: PillOption[];
  value: string;
  onChange: (key: string) => void;
  /** Accessible name for the group (e.g. "Filter by term"). */
  label: string;
  className?: string;
}) {
  if (options.length <= 1) return null;
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex flex-wrap items-center gap-1.5", className)}
    >
      {options.map((o) => {
        const active = o.key === value;
        const empty = o.count === 0 && !active;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.key)}
            className={cn(
              "cursor-pointer rounded-full border px-3 py-[5px] text-[13px] leading-none whitespace-nowrap transition-colors",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              active
                ? "border-accent bg-accent font-medium text-accent-ink"
                : empty
                  ? "border-line bg-surface text-ink-2/55 hover:border-line-2 hover:text-ink-2"
                  : "border-line-2 bg-surface text-ink-2 hover:border-ink-2 hover:text-ink"
            )}
          >
            {o.label}
            {o.count !== undefined && (
              <span
                className={cn(
                  "ml-1.5 tabular-nums",
                  active ? "opacity-80" : "opacity-70"
                )}
              >
                {o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
