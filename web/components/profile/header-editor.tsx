"use client";

// Header editor for the resume's top block: full name, the single contact
// line that renders centered under the name, an optional work-authorization
// prefix, and a repeatable list of links. This is a controlled component - the
// only way data flows up is `onChange` with a brand-new header object; nothing
// here holds persistent state beyond the current input value (so it stays in
// sync when the user switches profiles or variants).

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ProfileV2 } from "@/lib/profile";
import { PERSONAL_INFO_ID } from "@/components/profile/section-rail";

const INPUT =
  "w-full min-w-0 rounded-md border border-line-2 bg-bg px-2.5 py-1.5 text-[12.5px] text-ink outline-none transition-colors focus:border-accent placeholder:text-ink-2";
const FIELD_LABEL = "mb-1 block text-[11px] font-medium text-ink-2";

/** One link row: label (text) and url, styled like the education degree
 *  blocks (a bordered mini-card with a remove control). */
function LinkRow({
  link,
  index,
  onChange,
  onRemove,
}: {
  link: { text: string; url: string };
  index: number;
  onChange: (next: { text: string; url: string }) => void;
  onRemove: () => void;
}) {
  return (
    <div className="mt-2 rounded-md border border-line bg-bg px-2.5 py-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">
          Link {index + 1}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove link ${index + 1}`}
          className="rounded p-0.5 text-[13px] leading-none text-ink-2 hover:text-red"
        >
          &times;
        </button>
      </div>
      {/* Stacks on narrow screens: two inputs side by side at 375px leaves
          each too narrow to read a URL in. */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block min-w-0">
          <span className={FIELD_LABEL}>Text</span>
          <input
            value={link.text}
            onChange={(e) => onChange({ ...link, text: e.target.value })}
            placeholder="GitHub"
            className={INPUT}
          />
        </label>
        <label className="block min-w-0">
          <span className={FIELD_LABEL}>URL</span>
          <input
            value={link.url}
            onChange={(e) => onChange({ ...link, url: e.target.value })}
            placeholder="https://github.com/you"
            className={INPUT}
          />
        </label>
      </div>
    </div>
  );
}

export function HeaderEditor(props: {
  header: ProfileV2["header"];
  onChange: (header: ProfileV2["header"]) => void;
}) {
  const { header, onChange } = props;
  const links = header.links ?? [];

  return (
    // PERSONAL_INFO_ID keys this root so the editor can carry the pseudo-row's
    // stable identifier down to the centre column (the "personal info" rail
    // row is not a real Section, so it has no id of its own to key against).
    <div key={PERSONAL_INFO_ID} className="space-y-3">
      <label className="block min-w-0">
        <span className={FIELD_LABEL}>Full name</span>
        <input
          value={header.name}
          onChange={(e) => onChange({ ...header, name: e.target.value })}
          placeholder="Your Name"
          className={INPUT}
        />
      </label>

      <label className="block min-w-0">
        <span className={FIELD_LABEL}>Contact line</span>
        <input
          value={header.contact_line}
          onChange={(e) => onChange({ ...header, contact_line: e.target.value })}
          placeholder="City, ST | 000-000-0000 | you@example.com"
          className={INPUT}
        />
        <span className="mt-1 block text-[11px] text-ink-2">
          Renders centered under the name exactly as typed
        </span>
      </label>

      <label className="block min-w-0">
        <span className={FIELD_LABEL}>Work authorization</span>
        <input
          value={header.citizen_prefix ?? ""}
          onChange={(e) => {
            const v = e.target.value;
            // Write back `undefined` when emptied, matching how entry-card.tsx
            // treats other optional string fields (concentration/gpa stay
            // undefined when blank rather than an empty string).
            onChange({
              ...header,
              citizen_prefix: v === "" ? undefined : v,
            });
          }}
          placeholder="US Citizen"
          className={INPUT}
        />
        <span className="mt-1 block text-[11px] text-ink-2">
          Renders at the start of the links line; the separator is added for you
        </span>
      </label>

      <div>
        <span className={FIELD_LABEL}>Links</span>
        {links.length === 0 && (
          <p className="text-[11.5px] text-ink-2">
            No links yet - add one, e.g. your GitHub or personal site.
          </p>
        )}
        {links.map((link, i) => (
          <LinkRow
            key={i}
            link={link}
            index={i}
            onChange={(next) => {
              const nextLinks = [...links];
              nextLinks[i] = next;
              onChange({ ...header, links: nextLinks });
            }}
            onRemove={() =>
              onChange({ ...header, links: links.filter((_, idx) => idx !== i) })
            }
          />
        ))}
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() =>
            onChange({ ...header, links: [...links, { text: "", url: "" }] })
          }
        >
          <Plus className="size-3.5" />
          Add link
        </Button>
      </div>
    </div>
  );
}