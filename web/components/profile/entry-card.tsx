"use client";

// A single resume entry card. Collapsed it shows the grip, a composed
// heading/subheading line, a shown/hidden pill, and action buttons. Expanded
// it shows the kind-specific fields. Education supports multiple degrees and
// free extras (honors, study abroad). All edits go through the pure `onChange`
// updater; nothing here mutates `entry` in place.

import { useState } from "react";
import { ChevronDown, Eye, EyeOff, GripVertical, Plus, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { Degree, Entry, SectionKind, Variant } from "@/lib/profile";
import { bulletsFor } from "@/lib/profile";
import { BulletList } from "@/components/profile/bullet-list";

const INPUT =
  "w-full min-w-0 rounded-md border border-line-2 bg-bg px-2.5 py-1.5 text-[12.5px] text-ink outline-none transition-colors focus:border-accent placeholder:text-ink-2";
const CHIP =
  "rounded-full bg-chip px-2 py-0.5 text-[10.5px] font-semibold text-ink-2";
const DEGLINE = "mt-2 rounded-md border border-line bg-bg px-2.5 py-2.5";

const FIELD_LABEL =
  "mb-1 block text-[11px] font-medium text-ink-2";

/**
 * WHY THIS HELPER EXISTS
 * ----------------------
 * Bullets live at `entry.bullets[variant]`, falling back to "base". The bug
 * this fixes: editing a targeted-resume (non-base) bullet used to corrupt the
 * base variant, because the edit grabbed `entry.bullets[variant]` which was
 * `undefined` and then wrote back over the base array.
 *
 * The fix: on the FIRST edit of a non-base variant that has no array yet, we
 * SEED `bullets[variant]` by COPYING `bullets.base` into a brand-new array,
 * then apply the edit to that copy. `bullets.base` itself is never touched.
 * `bulletsForEdit` returns that seeded copy so every edit below builds on it,
 * and the writeback is always `{ ...e.bullets, [variant]: nextArray }`, which
 * by construction leaves `bullets.base` as the same original reference unless
 * `variant === "base"`. "Copy from base" in <BulletList> is a separate,
 * explicit user action, distinct from this implicit seed-on-first-edit.
 */
function bulletsForEdit(entry: Entry, variant: Variant): string[] {
  return entry.bullets[variant] ?? [...(entry.bullets.base ?? [])];
}

// Compose the muted second line of the collapsed header, joining whichever
// fields apply for this kind with the \u00b7 (middle dot) separator, mirroring
// the mock (e.g. "Atlanta, GA · B.S. + M.S. · 2023 - 2028").
function headerSub(entry: Entry, kind: SectionKind): string {
  const parts: string[] = [];
  if (entry.location) parts.push(entry.location);
  if (kind === "education") {
    if (entry.subheading) parts.push(entry.subheading);
    const degrees = (entry.degrees ?? [])
      .map((d) => d.degree)
      .filter(Boolean)
      .join(" + ");
    if (degrees) parts.push(degrees);
  } else if (entry.heading && entry.subheading) {
    // experience: org and role share the heading line per the mock.
    // The heading line is composed by the caller; here we only add location/date.
  }
  if (entry.date) parts.push(entry.date);
  return parts.join(" \u00b7 ");
}

/** One degree block with its own "Degree N / x" header and four fields. */
function DegreeBlock({
  degree,
  index,
  onChange,
  onRemove,
}: {
  degree: Degree;
  index: number;
  onChange: (d: Degree) => void;
  onRemove: () => void;
}) {
  return (
    <div className={DEGLINE}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">
          Degree {index + 1}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove degree ${index + 1}`}
          className="rounded p-0.5 text-[13px] leading-none text-ink-2 hover:text-red"
        >
          &times;
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block min-w-0">
          <span className={FIELD_LABEL}>Degree</span>
          <input
            value={degree.degree}
            onChange={(e) => onChange({ ...degree, degree: e.target.value })}
            placeholder="B.S. Computer Science"
            className={INPUT}
          />
        </label>
        <label className="block min-w-0">
          <span className={FIELD_LABEL}>Concentration</span>
          <input
            value={degree.concentration ?? ""}
            onChange={(e) =>
              onChange({ ...degree, concentration: e.target.value })
            }
            placeholder="Optional"
            className={INPUT}
          />
        </label>
        <label className="block min-w-0">
          <span className={FIELD_LABEL}>Graduation</span>
          <input
            value={degree.grad_date}
            onChange={(e) => onChange({ ...degree, grad_date: e.target.value })}
            placeholder="Expected May 2027"
            className={INPUT}
          />
        </label>
        <label className="block min-w-0">
          <span className={FIELD_LABEL}>GPA</span>
          <input
            value={degree.gpa ?? ""}
            onChange={(e) => onChange({ ...degree, gpa: e.target.value })}
            placeholder="Optional"
            className={INPUT}
          />
        </label>
      </div>
    </div>
  );
}

/** A simple label + (optional) date input pair, for honors / study abroad. */
function ExtraBlock({
  extra,
  label,
  onChange,
  onRemove,
}: {
  extra: { text: string; date?: string };
  label: string;
  onChange: (next: { text: string; date?: string }) => void;
  onRemove: () => void;
}) {
  return (
    <div className={DEGLINE}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">
          {label}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          className="rounded p-0.5 text-[13px] leading-none text-ink-2 hover:text-red"
        >
          &times;
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block min-w-0">
          <span className={FIELD_LABEL}>{label}</span>
          <input
            value={extra.text}
            onChange={(e) => onChange({ ...extra, text: e.target.value })}
            placeholder={label}
            className={INPUT}
          />
        </label>
        <label className="block min-w-0">
          <span className={FIELD_LABEL}>{label} date</span>
          <input
            value={extra.date ?? ""}
            onChange={(e) => onChange({ ...extra, date: e.target.value })}
            placeholder="Optional"
            className={INPUT}
          />
        </label>
      </div>
    </div>
  );
}

/** A labeled single text field. */
function Field({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block min-w-0">
      <span className={FIELD_LABEL}>{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={INPUT}
      />
    </label>
  );
}

/** Chip editor for projects `tags` (port of the old editor's TagsEditor). */
function TagsEditor({
  tags,
  onAdd,
  onRemove,
}: {
  tags: string[];
  onAdd: (t: string) => void;
  onRemove: (t: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const t = draft.trim();
    if (t && !tags.includes(t)) onAdd(t);
    setDraft("");
  };
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap gap-1.5">
        {tags.map((t) => (
          <span key={t} className={cn(CHIP, "flex items-center gap-1")}>
            {t}
            <button
              type="button"
              onClick={() => onRemove(t)}
              className="text-ink-2 hover:text-red"
              aria-label={`Remove tag ${t}`}
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
      </div>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        placeholder="Add tag"
        className={INPUT}
      />
    </div>
  );
}

export function EntryCard(props: {
  entry: Entry;
  kind: SectionKind;
  variant: Variant;
  isOpen: boolean;
  onToggleOpen: () => void;
  onChange: (updater: (e: Entry) => Entry) => void;
  onDelete: () => void;
  onToggleHidden: () => void;
  isHiddenInVariant: boolean;
  dragHandleProps?: { draggable: boolean; onDragStart: (e: React.DragEvent) => void };
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  moveUp?: () => void;
  moveDown?: () => void;
}) {
  const { entry, kind, variant } = props;
  const [techText, setTechText] = useState((entry.tech ?? []).join(", "));
  // Education bullets are hidden until the user asks for them (or there are
  // any to show - including ones inherited from the base variant).
  const [showBullets, setShowBullets] = useState(
    kind === "education" ? bulletsFor(entry, variant).length > 0 : true
  );

  // Route every bullet edit through this so the variant-write seed rule above
  // is applied consistently. It derives the next array from bulletsForEdit,
  // never from entry.bullets[variant] directly (which may be undefined).
  const writeBullets = (
    next: (arr: string[]) => string[]
  ) =>
    props.onChange((e) => {
      const arr = bulletsForEdit(e, variant);
      return {
        ...e,
        bullets: { ...e.bullets, [variant]: next(arr) },
      };
    });

  const setField = (patch: Partial<Entry>) =>
    props.onChange((e) => ({ ...e, ...patch }));

  const headingLine =
    kind === "experience" && entry.subheading
      ? entry.heading
        ? `${entry.heading} \u00b7 ${entry.subheading}`
        : entry.subheading
      : entry.heading;

  const sub = headerSub(entry, kind);

  const rightActions = (
    <>
      <span
        className={cn(
          "max-w-[130px] shrink-0 truncate rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
          props.isHiddenInVariant
            ? "bg-chip text-ink-2"
            : "bg-accent/15 text-accent"
        )}
        title={props.isHiddenInVariant ? `hidden on ${variant}` : "shown"}
      >
        {props.isHiddenInVariant ? `hidden on ${variant}` : "shown"}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          props.onToggleHidden();
        }}
        aria-label={props.isHiddenInVariant ? "Show entry" : "Hide entry"}
        className="shrink-0 rounded p-0.5 text-ink-2 hover:text-accent"
      >
        {props.isHiddenInVariant ? (
          <EyeOff className="size-3.5" />
        ) : (
          <Eye className="size-3.5" />
        )}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          props.onDelete();
        }}
        aria-label="Delete entry"
        className="shrink-0 rounded p-0.5 text-ink-2 hover:text-red"
      >
        <Trash2 className="size-3.5" />
      </button>
    </>
  );

  const moveButtons = (props.moveUp || props.moveDown) && (
    <div className="flex shrink-0 flex-col items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
      <button
        type="button"
        disabled={!props.moveUp}
        onClick={(e) => {
          e.stopPropagation();
          props.moveUp?.();
        }}
        aria-label="Move entry up"
        className="shrink-0 rounded p-0.5 text-ink-2 hover:text-ink disabled:opacity-0 disabled:pointer-events-none"
      >
        &#x2191;
      </button>
      <button
        type="button"
        disabled={!props.moveDown}
        onClick={(e) => {
          e.stopPropagation();
          props.moveDown?.();
        }}
        aria-label="Move entry down"
        className="shrink-0 rounded p-0.5 text-ink-2 hover:text-ink disabled:opacity-0 disabled:pointer-events-none"
      >
        &#x2193;
      </button>
    </div>
  );

  const educationBody = (
    <div>
      <div className="grid grid-cols-2 gap-2">
        <Field
          label="Institution"
          value={entry.heading}
          placeholder="School"
          onChange={(v) => setField({ heading: v })}
        />
        <Field
          label="Location"
          value={entry.location ?? ""}
          placeholder="City, ST"
          onChange={(v) => setField({ location: v })}
        />
      </div>

      {(entry.degrees ?? []).map((degree, i) => (
        <DegreeBlock
          key={i}
          degree={degree}
          index={i}
          onChange={(d) =>
            props.onChange((e) => {
              const degrees = [...(e.degrees ?? [])];
              degrees[i] = d;
              return { ...e, degrees };
            })
          }
          onRemove={() =>
            props.onChange((e) => ({
              ...e,
              degrees: (e.degrees ?? []).filter((_, idx) => idx !== i),
            }))
          }
        />
      ))}

      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() =>
          props.onChange((e) => ({
            ...e,
            degrees: [...(e.degrees ?? []), { degree: "", grad_date: "" }],
          }))}
        >
          <Plus className="size-3.5" />
          Degree
        </Button>
        <Button size="sm" variant="ghost" onClick={() =>
          props.onChange((e) => ({
            ...e,
            extras: [...(e.extras ?? []), { text: "", date: undefined }],
          }))}
        >
          <Plus className="size-3.5" />
          Honors
        </Button>
        <Button size="sm" variant="ghost" onClick={() =>
          props.onChange((e) => ({
            ...e,
            extras: [...(e.extras ?? []), { text: "", date: "" }],
          }))}
        >
          <Plus className="size-3.5" />
          Study abroad
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setShowBullets(true);
            // Seed the variant bullet list (empty string) on first reveal.
            writeBullets((arr) => [...arr, ""]);
          }}
        >
          <Plus className="size-3.5" />
          Bullet
        </Button>
      </div>

      {(entry.extras ?? []).map((extra, i) => (
        <ExtraBlock
          key={i}
          extra={extra}
          label="Extra"
          onChange={(next) =>
            props.onChange((e) => {
              const extras = [...(e.extras ?? [])];
              extras[i] = next;
              return { ...e, extras };
            })
          }
          onRemove={() =>
            props.onChange((e) => ({
              ...e,
              extras: (e.extras ?? []).filter((_, idx) => idx !== i),
            }))
          }
        />
      ))}

      {showBullets && (
        <div className="mt-3">
          <BulletList
            bullets={bulletsFor(entry, variant)}
            baseBullets={entry.bullets.base}
            isBaseVariant={variant === "base"}
            onChange={(i, v) => writeBullets((arr) => arr.map((b, idx) => (idx === i ? v : b)))}
            onRemove={(i) => writeBullets((arr) => arr.filter((_, idx) => idx !== i))}
            onAdd={() => writeBullets((arr) => [...arr, ""])}
            onReorder={(fi, ti) =>
              writeBullets((arr) => {
                const next = [...arr];
                const [moved] = next.splice(fi, 1);
                next.splice(ti, 0, moved);
                return next;
              })
            }
            onCopyFromBase={() => props.onChange((e) => ({
              ...e,
              bullets: { ...e.bullets, [variant]: [...(e.bullets.base ?? [])] },
            }))}
          />
        </div>
      )}
    </div>
  );

  const bulletsBody = (
    <div className="mt-1">
      <BulletList
        bullets={bulletsFor(entry, variant)}
        baseBullets={entry.bullets.base}
        isBaseVariant={variant === "base"}
        onChange={(i, v) => writeBullets((arr) => arr.map((b, idx) => (idx === i ? v : b)))}
        onRemove={(i) => writeBullets((arr) => arr.filter((_, idx) => idx !== i))}
        onAdd={() => writeBullets((arr) => [...arr, ""])}
        onReorder={(fi, ti) =>
          writeBullets((arr) => {
            const next = [...arr];
            const [moved] = next.splice(fi, 1);
            next.splice(ti, 0, moved);
            return next;
          })
        }
        onCopyFromBase={() =>
          props.onChange((e) => ({
            ...e,
            bullets: { ...e.bullets, [variant]: [...(e.bullets.base ?? [])] },
          }))
        }
      />
    </div>
  );

  const experienceCustomBody = (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Organization" value={entry.heading} placeholder="Company"
          onChange={(v) => setField({ heading: v })} />
        <Field label="Role" value={entry.subheading ?? ""} placeholder="Title"
          onChange={(v) => setField({ subheading: v })} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Location" value={entry.location ?? ""} placeholder="City, ST"
          onChange={(v) => setField({ location: v })} />
        <Field label="Dates" value={entry.date} placeholder="May - Aug 2026"
          onChange={(v) => setField({ date: v })} />
      </div>
      {bulletsBody}
    </div>
  );

  const projectsBody = (
    <div className="space-y-2">
      <Field label="Project name" value={entry.heading} placeholder="Project"
        onChange={(v) => setField({ heading: v })} />
      <Field label="Tech" value={techText} placeholder="React, TypeScript"
        onChange={(v) => {
          setTechText(v);
          const tech = v.split(",").map((t) => t.trim()).filter(Boolean);
          setField({ tech });
        }} />
      <Field label="Dates" value={entry.date} placeholder="2026"
        onChange={(v) => setField({ date: v })} />
      <div>
        <span className={FIELD_LABEL}>Tags</span>
        <TagsEditor
          tags={entry.tags ?? []}
          onAdd={(t) => setField({ tags: [...(entry.tags ?? []), t] })}
          onRemove={(t) =>
            setField({ tags: (entry.tags ?? []).filter((x) => x !== t) })
          }
        />
      </div>
      {bulletsBody}
    </div>
  );

  const communityBody = (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Organization" value={entry.heading} placeholder="Organization"
          onChange={(v) => setField({ heading: v })} />
        <Field label="Dates" value={entry.date} placeholder="2024 - 2026"
          onChange={(v) => setField({ date: v })} />
      </div>
      {bulletsBody}
    </div>
  );

  return (
    <div
      className={cn(
        "rounded-md border border-line bg-surface",
        props.onDragOver && "cursor-grab"
      )}
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
    >
      <div
        className={cn(
          "group flex items-center gap-2.5 px-3 py-2.5 min-w-0",
          props.isOpen && "border-b border-line"
        )}
        role="button"
        tabIndex={0}
        aria-expanded={props.isOpen}
        onClick={props.onToggleOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            props.onToggleOpen();
          }
        }}
      >
        {props.dragHandleProps ? (
          <span
            {...props.dragHandleProps}
            className="shrink-0 cursor-grab text-line-2"
          >
            <GripVertical className="size-3.5" />
          </span>
        ) : (
          <GripVertical className="size-3.5 shrink-0 text-line-2" />
        )}
        {moveButtons}

        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-ink">
            {headingLine || "Untitled"}
          </div>
          {sub && (
            <div className="truncate text-[11.5px] text-ink-2">
              {sub}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">{rightActions}</div>

        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-ink-2 transition-transform",
            props.isOpen && "rotate-180"
          )}
        />
      </div>

      {props.isOpen && (
        <div className="p-3">
          {kind === "education" && educationBody}
          {(kind === "experience" || kind === "custom") && experienceCustomBody}
          {kind === "projects" && projectsBody}
          {kind === "community" && communityBody}
        </div>
      )}
    </div>
  );
}


