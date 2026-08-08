"use client";

// The resume header: the block that renders above Education as the centered
// name, the contact line, an optional work-authorization prefix, and a row of
// links.
//
// This existed in the renderer from the start (convex/resume_docx.ts reads
// header.name, header.contact_line, header.citizen_prefix and header.links)
// but had NO editor, so every profile sat at {name: "", contact_line: ""} and
// the preview rendered the placeholder "Your name". That is why Personal info
// is pinned to the top of the rail rather than filed away: an unnamed resume
// is broken, and the user had no way to see it.
//
// It is deliberately NOT a Section. Sections are user-orderable and deletable;
// the header is neither, and it stores no entries.

import { Plus, X } from "lucide-react";
import type { ProfileV2 } from "@/lib/profile";

const INP =
  "w-full min-w-0 rounded-md border border-line-2 bg-bg px-2.5 py-1.5 text-[12.5px] text-ink outline-none transition-colors focus:border-accent placeholder:text-ink-2";
const LABEL = "mb-1 block text-[11.5px] font-medium text-ink-2";
const HINT = "mt-1 text-[11px] text-ink-2";

type Header = ProfileV2["header"];
type Link = { text: string; url: string };

export function HeaderEditor({
  header,
  onChange,
}: {
  header: Header;
  /** Receives a whole new header object; the editor never mutates in place. */
  onChange: (next: Header) => void;
}) {
  const links: Link[] = header.links ?? [];

  const set = (patch: Partial<Header>) => onChange({ ...header, ...patch });

  const setLink = (i: number, patch: Partial<Link>) =>
    set({ links: links.map((l, idx) => (idx === i ? { ...l, ...patch } : l)) });

  const addLink = () => set({ links: [...links, { text: "", url: "" }] });

  const removeLink = (i: number) => {
    const next = links.filter((_, idx) => idx !== i);
    // Drop the key entirely when the last link goes, so the stored profile
    // does not accumulate an empty array the renderer would have to guard.
    set({ links: next.length > 0 ? next : undefined });
  };

  return (
    <div className="min-w-0">
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <h2 className="text-[14px] font-semibold text-ink">Personal info</h2>
        <span className="rounded-full bg-chip px-2 py-0.5 text-[10.5px] font-semibold text-ink-2">
          top of every resume
        </span>
      </div>

      <div className="rounded-md border border-line bg-surface p-3">
        <label className="mb-3 block min-w-0">
          <span className={LABEL}>Full name</span>
          <input
            className={INP}
            value={header.name}
            placeholder="First Last"
            aria-label="Full name"
            onChange={(e) => set({ name: e.target.value })}
          />
          {!header.name.trim() && (
            <p className="mt-1 text-[11px] text-red">
              Without a name the resume renders a placeholder heading.
            </p>
          )}
        </label>

        <label className="mb-3 block min-w-0">
          <span className={LABEL}>Contact line</span>
          <input
            className={INP}
            value={header.contact_line}
            placeholder="Atlanta, GA | 000-000-0000 | you@example.com"
            aria-label="Contact line"
            onChange={(e) => set({ contact_line: e.target.value })}
          />
          <p className={HINT}>
            Rendered centered under your name, exactly as typed - separators and all.
          </p>
        </label>

        <label className="mb-3 block min-w-0">
          <span className={LABEL}>Work authorization</span>
          <input
            className={INP}
            value={header.citizen_prefix ?? ""}
            placeholder="US Citizen"
            aria-label="Work authorization"
            onChange={(e) =>
              // Store undefined rather than "" so an empty value drops the run
              // instead of rendering a stray separator before the links.
              set({ citizen_prefix: e.target.value.trim() ? e.target.value : undefined })
            }
          />
          <p className={HINT}>Optional. Renders at the start of the links line.</p>
        </label>

        <div className="min-w-0">
          <span className={LABEL}>Links</span>
          {links.length === 0 && (
            <p className={HINT}>No links yet - GitHub, LinkedIn, a portfolio.</p>
          )}
          {links.map((link, i) => (
            <div key={i} className="mt-1.5 rounded-md border border-line bg-bg px-2.5 py-2">
              <div className="flex items-start gap-2">
                <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
                  <input
                    className={INP}
                    value={link.text}
                    placeholder="github.com/you"
                    aria-label={`Link ${i + 1} text`}
                    onChange={(e) => setLink(i, { text: e.target.value })}
                  />
                  <input
                    className={INP}
                    value={link.url}
                    placeholder="https://github.com/you"
                    aria-label={`Link ${i + 1} URL`}
                    onChange={(e) => setLink(i, { url: e.target.value })}
                  />
                </div>
                <button
                  type="button"
                  className="mt-1.5 shrink-0 text-ink-2 transition-colors hover:text-red"
                  aria-label={`Remove link ${i + 1}`}
                  onClick={() => removeLink(i)}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={addLink}
            className="mt-2 inline-flex items-center gap-1 text-[12px] font-medium text-ink-2 transition-colors hover:text-accent"
          >
            <Plus className="size-3.5" /> Add link
          </button>
        </div>
      </div>
    </div>
  );
}
