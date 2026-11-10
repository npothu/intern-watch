"use client";

// The top of the Matches page: the title with its "new today" line, the
// stage tabs, and one row of narrowing controls (the list filter, the chips,
// the term menu). Each kind of control has its own form on purpose:
//
//   tabs       exactly one is on        which pile (To apply / Applied / ...)
//   chips      checkboxes, any number   narrow the pile (Priority, Saved ...)
//   term menu  one of a list            narrow it to a season
//
// so nothing here reads as "seven pills that might or might not combine".
// All counts come from matches-lib composeFilters; this file only draws.

import type { Ref } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ALL_TERMS, FLAGS, STAGES, type Flag, type Stage } from "./matches-lib";

export type TermOption = { key: string; label: string; count: number };

const COUNT = "font-mono text-[11px] tabular-nums opacity-80";
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const fmt = (n: number) => n.toLocaleString("en-US");

export function MatchesToolbar({
  newLine,
  stage,
  stageCounts,
  onStage,
  flags,
  flagCounts,
  onToggleFlag,
  terms,
  term,
  onTerm,
  query,
  onQuery,
  searchRef,
  filtered,
  onClear,
}: {
  /** "12 new today, 7 from priority companies" (lib/headline composeNewToday). */
  newLine: string;
  stage: Stage;
  stageCounts: Record<Stage, number>;
  onStage: (stage: Stage) => void;
  flags: readonly Flag[];
  flagCounts: Record<Flag, number>;
  onToggleFlag: (flag: Flag) => void;
  /** ALL_TERMS first, then the terms on offer. */
  terms: TermOption[];
  term: string;
  onTerm: (term: string) => void;
  query: string;
  onQuery: (query: string) => void;
  searchRef: Ref<HTMLInputElement>;
  /** A chip, a term or a query is narrowing the stage. */
  filtered: boolean;
  onClear: () => void;
}) {
  return (
    <div className="mb-3.5">
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="m-0 text-[24px] leading-[1.1] font-semibold tracking-[-0.02em] text-ink">
          Matches
        </h1>
        <p className="m-0 text-[13px] text-ink-2">{newLine}</p>
      </div>

      {/* Stage tabs. Toggle buttons rather than ARIA tabs: they filter one
          list, and the arrow keys already belong to the term menu. The rule
          under them is an inset shadow so the scroll container (phones) does
          not clip the active tab's underline. */}
      <div
        role="group"
        aria-label="Stage"
        className="no-scrollbar flex items-end gap-6 overflow-x-auto shadow-[inset_0_-1px_0_var(--color-line)]"
      >
        {STAGES.map((s) => {
          const active = s.key === stage;
          return (
            <button
              key={s.key}
              type="button"
              aria-pressed={active}
              onClick={() => onStage(s.key)}
              className={cn(
                "relative inline-flex shrink-0 cursor-pointer items-baseline gap-[7px] pt-2 pb-[11px] text-[14px] whitespace-nowrap transition-colors",
                FOCUS,
                // Hidden is not part of All, so it stands apart at the end.
                s.key === "hidden" && "ml-auto",
                active
                  ? "font-medium text-ink after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-ink"
                  : "text-ink-2 hover:text-ink"
              )}
            >
              {s.label}
              <span className={COUNT}>{fmt(stageCounts[s.key])}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-3">
        <label className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg border border-line bg-surface pr-[7px] pl-2.5 text-ink-2 focus-within:border-accent min-[700px]:w-[250px]">
          <Search aria-hidden className="size-3.5 shrink-0" />
          <input
            ref={searchRef}
            type="search"
            name="filter-matches"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Filter this list"
            autoComplete="off"
            aria-label="Filter this list"
            aria-keyshortcuts="/"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink placeholder:text-ink-2 focus:outline-none"
          />
          <kbd className="hidden shrink-0 rounded border border-line-2 bg-bg px-1.5 py-0.5 font-mono text-[10.5px] leading-none text-ink-2 min-[700px]:inline">
            /
          </kbd>
        </label>

        <div role="group" aria-label="Show only" className="contents">
          {FLAGS.map((f) => {
            const on = flags.includes(f.key);
            const count = flagCounts[f.key];
            return (
              <button
                key={f.key}
                type="button"
                aria-pressed={on}
                onClick={() => onToggleFlag(f.key)}
                className={cn(
                  "inline-flex h-8 shrink-0 cursor-pointer items-center gap-[7px] rounded-lg border px-2.5 text-[13px] whitespace-nowrap transition-colors",
                  FOCUS,
                  on
                    ? "border-accent bg-accent/15 text-ink"
                    : cn(
                        "border-line hover:border-line-2 hover:text-ink",
                        count === 0 ? "text-ink-2/60" : "text-ink-2"
                      )
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "inline-flex size-[13px] items-center justify-center rounded-[3px] border",
                    on ? "border-accent bg-accent text-accent-ink" : "border-line-2"
                  )}
                >
                  {on && <Check className="size-2.5" strokeWidth={3} />}
                </span>
                {f.label}
                <span className={COUNT}>{fmt(count)}</span>
              </button>
            );
          })}
        </div>

        {terms.length > 1 && (
          // The rule travels with the menu, so a wrap never strands it at the
          // end of the chips' line.
          <span className="inline-flex shrink-0 items-center gap-2">
            <span aria-hidden className="mx-1 hidden h-[18px] w-px bg-line-2 min-[700px]:block" />
            <TermMenu terms={terms} term={term} onTerm={onTerm} />
          </span>
        )}

        {filtered && (
          <button
            type="button"
            onClick={onClear}
            className={cn(
              "ml-1 cursor-pointer text-[12.5px] text-accent underline decoration-dashed underline-offset-[3px]",
              FOCUS
            )}
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

function TermMenu({
  terms,
  term,
  onTerm,
}: {
  terms: TermOption[];
  term: string;
  onTerm: (term: string) => void;
}) {
  const current = terms.find((t) => t.key === term);
  const picked = term !== ALL_TERMS;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Term: ${picked && current ? current.label : "any"}`}
          className={cn(
            "inline-flex h-8 shrink-0 cursor-pointer items-center gap-[7px] rounded-lg border px-2.5 text-[13px] whitespace-nowrap text-ink transition-colors",
            FOCUS,
            picked ? "border-accent bg-accent/15" : "border-line hover:border-line-2"
          )}
        >
          <span className="font-mono text-[10.5px] font-medium tracking-[0.08em] text-ink-2 uppercase">
            Term
          </span>
          {picked && current ? current.label : "Any"}
          <ChevronDown aria-hidden className="size-3 text-ink-2" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-[220px]">
        <DropdownMenuRadioGroup value={term} onValueChange={onTerm}>
          {terms.map((t) => (
            <DropdownMenuRadioItem key={t.key} value={t.key} className="gap-4">
              <span className={cn("flex-1", t.count === 0 && "text-ink-2")}>{t.label}</span>
              <span className={COUNT}>{fmt(t.count)}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
