"use client";

import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The status filter that sits at the right end of the search row, restoring the
 * shape the Python web UI had (src/webui/static/index.html, the `#status`
 * select beside `#q`).
 *
 * A native <select> on purpose: it is one tap on mobile, keyboard accessible
 * for free, and the options are a plain single-choice list with no icons or
 * grouping to justify a custom popover.
 *
 * Two of the original options are deliberately absent. "Agent touched" filtered
 * on `item.artifacts`, built by the local server from `state/apply_artifacts/`
 * on disk, and "Likely closed" filtered on `item.stale_days`, computed in
 * src/webui/server.py. Neither field exists in the hosted app's data, so both
 * would render an option that always matches nothing.
 */

export type StatusFilter =
  | "all"
  | "todo"
  | "applied"
  | "saved"
  | "resumes"
  | "hidden";

const OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "todo", label: "To apply" },
  { value: "applied", label: "Applied" },
  { value: "saved", label: "Saved" },
  { value: "resumes", label: "Has resume" },
  { value: "hidden", label: "Hidden" },
];

export function StatusSelect({
  value,
  onChange,
  className,
}: {
  value: StatusFilter;
  onChange: (next: StatusFilter) => void;
  className?: string;
}) {
  return (
    <div className={cn("relative shrink-0", className)}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as StatusFilter)}
        aria-label="Filter matches by status"
        className={cn(
          "h-[34px] w-full cursor-pointer appearance-none rounded-[5px] border border-line-2 bg-surface py-1.5 pr-8 pl-2.5 text-[13px] text-ink transition-colors",
          "hover:border-ink-2 focus-visible:border-accent focus-visible:outline-none",
          value !== "all" && "border-accent text-accent"
        )}
      >
        {OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2",
          value === "all" ? "text-ink-2" : "text-accent"
        )}
      />
    </div>
  );
}
