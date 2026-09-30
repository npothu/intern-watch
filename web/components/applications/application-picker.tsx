"use client";

import { useState } from "react";
import { Check, ChevronsUpDown, Plus, Search } from "lucide-react";

import type { ApplicationOption } from "@/lib/convex";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { orderedApplications } from "./application-picker-lib";

export function ApplicationPicker({
  applications,
  suggestedShorts,
  value,
  onChange,
  onCreate,
  disabled = false,
}: {
  applications: ApplicationOption[];
  suggestedShorts: string[];
  value: string;
  onChange: (short: string) => void;
  onCreate: (company: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = applications.find((application) => application.short === value);
  const ordered = orderedApplications(applications, suggestedShorts, query);

  function choose(short: string) {
    onChange(short);
    setOpen(false);
    setQuery("");
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        aria-label="Choose application"
        className="inline-flex h-7 max-w-[300px] items-center gap-1.5 rounded-full border border-line-2 bg-surface px-3 text-[12px] text-ink transition-colors hover:border-accent disabled:opacity-40"
      >
        <span className="truncate">
          {selected
            ? `${selected.company}${selected.title ? ` - ${selected.title}` : ""}`
            : "Search applications"}
        </span>
        <ChevronsUpDown className="size-3 shrink-0 text-ink-2" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[560px] gap-3 p-0">
          <DialogHeader className="px-4 pt-4">
            <DialogTitle>Choose an application</DialogTitle>
          </DialogHeader>
          <div className="relative px-4">
            <Search className="pointer-events-none absolute top-1/2 left-7 size-4 -translate-y-1/2 text-ink-2" />
            <input
              autoFocus
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search company, role, location, or link"
              aria-label="Search all applications"
              className="h-9 w-full rounded-md border border-line-2 bg-bg pr-3 pl-9 text-[13px] text-ink outline-none placeholder:text-ink-2/70 focus:border-accent"
            />
          </div>
          <div className="max-h-[52vh] overflow-y-auto border-y border-line">
            {ordered.length ? (
              ordered.map((application) => (
                <button
                  type="button"
                  key={application.short}
                  onClick={() => choose(application.short)}
                  className={cn(
                    "flex w-full items-start gap-3 border-t border-line px-4 py-2.5 text-left first:border-t-0 hover:bg-chip/70",
                    application.short === value && "bg-chip/50",
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-2 text-[13.5px] font-semibold text-ink">
                      {application.company}
                      {application.suggested && !query.trim() && (
                        <span className="rounded-full bg-accent/10 px-2 py-px text-[10px] font-medium text-accent">
                          suggested
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-[12px] text-ink-2">
                      {[application.title, application.location]
                        .filter(Boolean)
                        .join(" · ") || "Company only"}
                    </span>
                  </span>
                  {application.short === value && (
                    <Check className="mt-0.5 size-4 shrink-0 text-accent" />
                  )}
                </button>
              ))
            ) : (
              <p className="px-4 py-7 text-center text-[13px] text-ink-2">
                No applications match this search.
              </p>
            )}
          </div>
          <div className="flex items-center justify-between gap-3 px-4 pb-4">
            <p className="text-[11.5px] text-ink-2">
              {applications.length} application{applications.length === 1 ? "" : "s"} in your tracker
            </p>
            <Button
              size="sm"
              onClick={() => {
                setOpen(false);
                onCreate(query.trim());
              }}
            >
              <Plus className="size-3.5" />
              Add application
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
