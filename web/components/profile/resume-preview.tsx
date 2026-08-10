"use client";

// Live one-page resume preview for the editor's right column. It is a pure
// function of the current draft (profile + variant): it renders an outline
// sheet from outlineLines() and a line-usage meter that answers "will this
// still be one page?" as the user types, rather than only at build time.
//
// The ONE literal color in the whole profile feature lives here:
// `dark:bg-[#26241d]` on the .page sheet. Nowhere else is a raw hex allowed -
// everything else uses the identity tokens (bg-surface, bg-line-2, ...) so it
// colors correctly in both light and dark mode. The mock's .page drew a paper
// sheet, so dark mode uses a warm paper-like tone instead of the panel surface.

import { cn } from "@/lib/utils";
import type { ProfileV2, Variant } from "@/lib/profile";
import { outlineLines, PAGE_LINE_BUDGET } from "@/lib/profile";

/**
 * Line-bar widths, cycling like the mock's .ln.b / .ln.m / .ln.s (narrow,
 * medium, wide). Content only varies the width class for visual variety, so
 * we key off the line index (% 3) not the text length - cheap and predictable.
 */
const LINE_WIDTHS = ["w-1/3", "w-1/2", "w-3/4"];

export function ResumePreview(props: { profile: ProfileV2; variant: Variant }) {
  const { profile, variant } = props;
  const entries = outlineLines(profile, variant);
  // Total count includes the synthetic "header" entry (name, contact, links)
  // - that matches the meter's "N of 59 lines used" wording.
  const used = entries.reduce((n, s) => n + s.lines.length, 0);

  const over = used > PAGE_LINE_BUDGET;
  const fillPct = Math.min(100, (used / PAGE_LINE_BUDGET) * 100);
  const left = PAGE_LINE_BUDGET - used;

  const links = (profile.header.links ?? [])
    .map((l) => l.text)
    .filter(Boolean)
    .join(" \u00b7 ");

  return (
    <div className="min-w-0">
      <Sheet profile={profile} entries={entries} links={links} />

      <div className="mt-2.5 text-[11px] text-ink-2">
        <div className="min-w-0 tabular-nums">
          {used} of {PAGE_LINE_BUDGET} lines used
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded bg-chip">
          <div
            className={cn("h-full rounded", over ? "bg-amber" : "bg-accent")}
            style={{ width: `${fillPct}%` }}
          />
        </div>
        <div
          className={cn(
            "mt-1.5 min-w-0 tabular-nums",
            over ? "font-medium text-amber" : "text-ink-2"
          )}
        >
          {over
            ? `${left * -1} lines over one page`
            : `${left} lines of room left`}
        </div>
      </div>
    </div>
  );
}

function Sheet({
  profile,
  entries,
  links,
}: {
  profile: ProfileV2;
  entries: ReturnType<typeof outlineLines>;
  links: string;
}) {
  return (
    <div className="aspect-[8.5/11] overflow-hidden rounded border border-line-2 bg-white px-3 py-3.5 shadow-lg dark:bg-[#26241d]">
      <div className="text-center text-[13px] font-bold text-ink">
        {profile.header.name || "Your name"}
      </div>
      {profile.header.contact_line && (
        <div className="mt-0.5 text-center text-[9px] text-ink-2">
          {profile.header.contact_line}
        </div>
      )}
      {links && (
        <div className="mt-0.5 text-center text-[9px] text-ink-2">{links}</div>
      )}

      <div className="mt-2.5 min-w-0 space-y-1.5">
        {entries
          .filter((e) => e.section !== "header")
          .map((entry) => (
            <div key={entry.id} className="min-w-0">
              <div className="border-b border-line-2 pb-0.5 text-[8px] font-bold uppercase tracking-wide text-ink">
                {entry.section}
              </div>
              <div className="mt-1 min-w-0 space-y-[3px]">
                {entry.lines.map((_line, i) => (
                  <div
                    key={i}
                    className={cn(
                      "h-[3px] rounded bg-line-2",
                      LINE_WIDTHS[i % LINE_WIDTHS.length]
                    )}
                  />
                ))}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
