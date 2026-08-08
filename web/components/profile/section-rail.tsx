"use client";

// Left rail of the resume editor: the ordered list of resume sections, one row
// per section. Order is data (an array), so it is user-reorderable by dragging
// or by the move-up/move-down buttons. This is deliberately independent - it
// only knows about Section/SectionKind via the props, never about the editor.

import { useRef, useState } from "react";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { Section, SectionKind } from "@/lib/profile";
import { SECTION_KINDS } from "@/lib/profile";

const RAIL_ITEM =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-ink-2 min-w-0";
const RAIL_ITEM_ACTIVE = "bg-chip text-ink font-semibold";

const MOVE =
  "shrink-0 rounded p-0.5 text-ink-2 opacity-0 transition-opacity hover:text-ink focus:opacity-100 disabled:opacity-0 disabled:pointer-events-none group-hover:opacity-100";

/**
 * One section row: a draggable grip, the section label, an entry-count badge
 * (skipped for the skills kind - it holds no entries), move-up/move-down for
 * keyboard reorder, and a delete control. The label is double-click editable
 * inline. Rows are HTML5-draggable with no drag library.
 */
function RailRow({
  section,
  index,
  count,
  active,
  isOnly,
  onSelect,
  onRename,
  onDelete,
  onMove,
}: {
  section: Section;
  index: number;
  count: number;
  active: boolean;
  isOnly: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
  onMove: (toIndex: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(section.title);
  const inputRef = useRef<HTMLInputElement>(null);

  const showCount = section.kind !== "skills";

  const commit = () => {
    const t = draft.trim();
    if (t && t !== section.title) onRename(t);
    setEditing(false);
  };

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(index));
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData("text/plain"));
        if (!Number.isNaN(from) && from !== index) onMove(from);
      }}
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group cursor-pointer select-none outline-none focus-visible:ring-2 focus-visible:ring-accent/50 rounded-md",
        RAIL_ITEM,
        active && RAIL_ITEM_ACTIVE
      )}
    >
      <GripVertical className="size-3.5 shrink-0 text-line-2" />

      {/* Move controls - keyboard reorder fallback. Hidden until hover/focus
          but always reachable by Tab. */}
      <button
        type="button"
        disabled={index === 0}
        onClick={(e) => {
          e.stopPropagation();
          if (index > 0) onMove(index - 1);
        }}
        className={MOVE}
        aria-label={`Move ${section.title} up`}
      >
        &#x2191;
      </button>
      <button
        type="button"
        disabled={index === count - 1}
        onClick={(e) => {
          e.stopPropagation();
          if (index < count - 1) onMove(index + 1);
        }}
        className={MOVE}
        aria-label={`Move ${section.title} down`}
      >
        &#x2193;
      </button>

      <span className="min-w-0 truncate flex-1">
        {editing ? (
          <input
            ref={inputRef}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.target.select()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                setDraft(section.title);
                setEditing(false);
              }
            }}
            onBlur={commit}
            className="w-full min-w-0 rounded border border-line-2 bg-bg px-1 py-0.5 text-[12.5px] text-ink outline-none focus:border-accent"
          />
        ) : (
          <span
            className="min-w-0 truncate"
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(true);
              setDraft(section.title);
            }}
          >
            {section.title}
          </span>
        )}
      </span>

      {showCount && (
        <span className="chip shrink-0 rounded-full bg-chip px-2 py-0.5 text-[10.5px] font-semibold text-ink-2">
          {section.entries.length}
        </span>
      )}

      {/* Delete is only safe when more than one section exists; disabling it
          here too (the caller also enforces) keeps the UI honest. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (window.confirm(`Delete the "${section.title}" section and all of its entries?`)) {
            onDelete();
          }
        }}
        disabled={isOnly}
        title={
          isOnly
            ? "Cannot delete the last section"
            : `Delete ${section.title}`
        }
        aria-label="Delete section"
        className="shrink-0 rounded p-0.5 text-ink-2 hover:text-red disabled:opacity-40 disabled:pointer-events-none"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}

export function SectionRail(props: {
  sections: Section[];
  activeId: string;
  onSelect: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onAdd: (kind: SectionKind, title?: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const isOnly = props.sections.length === 1;

  return (
    <div className="flex flex-col gap-0.5">
      <h5 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-2">
        Sections
      </h5>

      {props.sections.map((section, i) => (
        <RailRow
          key={section.id}
          section={section}
          index={i}
          count={props.sections.length}
          active={section.id === props.activeId}
          isOnly={isOnly}
          onSelect={() => props.onSelect(section.id)}
          onRename={(title) => props.onRename(section.id, title)}
          onDelete={() => props.onDelete(section.id)}
          onMove={(toIndex) => props.onReorder(i, toIndex)}
        />
      ))}

      {/* "+ Add section" with a plain positioned menu of section kinds plus
          Custom. */}
      <div className="relative mt-1">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start px-2 text-[12.5px] text-ink-2"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <Plus className="size-3.5" />
          Add section
        </Button>
        {menuOpen && (
          <>
            <div
              className="fixed inset-0 z-30"
              onClick={() => setMenuOpen(false)}
            />
            <div className="absolute left-0 top-full z-40 mt-1 min-w-[180px] rounded-md border border-line bg-surface p-1 shadow-lg">
              {SECTION_KINDS.map((k) => (
                <button
                  key={k.kind}
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    props.onAdd(k.kind, k.defaultTitle);
                  }}
                  className="flex w-full items-center rounded px-2 py-1.5 text-left text-[12.5px] text-ink hover:bg-chip"
                >
                  {k.label}
                </button>
              ))}
              <div className="my-1 h-px bg-line" />
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  const title = window.prompt("Section title");
                  if (title && title.trim()) {
                    props.onAdd("custom", title.trim());
                  }
                }}
                className="flex w-full items-center rounded px-2 py-1.5 text-left text-[12.5px] text-ink hover:bg-chip"
              >
                Custom...
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
