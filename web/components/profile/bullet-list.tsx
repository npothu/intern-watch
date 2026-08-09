"use client";

// One flexible list of resume bullets (a single variant's array). Reusable by
// every entry kind with bullets. Reorder is native HTML5 drag plus a
// move-up/move-down keyboard fallback, mirroring the section rail. No drag
// library, and no beforeunload logic here - that lives in the top-level editor.

import { useEffect, useRef } from "react";
import { GripVertical, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const INPUT =
  "w-full min-w-0 rounded-md border border-line-2 bg-bg px-2.5 py-1.5 text-[12.5px] text-ink outline-none transition-colors focus:border-accent placeholder:text-ink-2";

const MOVE =
  "shrink-0 rounded p-0.5 text-ink-2 opacity-0 transition-opacity hover:text-ink focus:opacity-100 disabled:opacity-0 disabled:pointer-events-none group-hover:opacity-100";

/** Auto-growing bullet field: resizes to fit its content, no scrollbar. */
function BulletTextarea({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = el.scrollHeight + "px";
    }
  }, []);
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      placeholder="Bullet"
      className={cn(INPUT, "min-h-[30px] resize-none leading-snug")}
      onChange={(e) => onChange(e.target.value)}
      onInput={(e) => {
        const el = e.currentTarget;
        el.style.height = "auto";
        el.style.height = el.scrollHeight + "px";
      }}
    />
  );
}

export function BulletList(props: {
  bullets: string[];
  baseBullets: string[] | undefined;
  isBaseVariant: boolean;
  onChange: (index: number, value: string) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onCopyFromBase: () => void;
}) {
  const copyEmpty = !props.baseBullets || props.baseBullets.length === 0;

  return (
    <div>
      <div className="space-y-1.5">
        {props.bullets.map((b, i) => {
          const over = b.length > 105;
          return (
            <div
              key={i}
              className="group flex items-start gap-1.5"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", String(i));
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const from = Number(e.dataTransfer.getData("text/plain"));
                if (!Number.isNaN(from) && from !== i) props.onReorder(from, i);
              }}
            >
              <div className="mt-1 flex shrink-0 flex-col items-center gap-0.5">
                <GripVertical className="size-3.5 shrink-0 text-line-2" />
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() => props.onReorder(i, i - 1)}
                  className={MOVE}
                  aria-label={`Move bullet ${i + 1} up`}
                >
                  &#x2191;
                </button>
                <button
                  type="button"
                  disabled={i === props.bullets.length - 1}
                  onClick={() => props.onReorder(i, i + 1)}
                  className={MOVE}
                  aria-label={`Move bullet ${i + 1} down`}
                >
                  &#x2193;
                </button>
              </div>

              <div className="min-w-0 flex-1">
                <BulletTextarea value={b} onChange={(v) => props.onChange(i, v)} />
              </div>

              <div className="mt-1 flex shrink-0 items-center gap-1">
                <span
                  className={cn(
                    "text-[10.5px] tabular-nums",
                    over ? "text-amber" : "text-ink-2"
                  )}
                >
                  {b.length}
                </span>
                <button
                  type="button"
                  onClick={() => props.onRemove(i)}
                  aria-label="Remove bullet"
                  className="rounded p-0.5 text-ink-2 hover:text-red"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={props.onAdd}>
          <Plus className="size-3.5" />
          Bullet
        </Button>
        {!props.isBaseVariant && (
          <Button
            size="sm"
            variant="ghost"
            onClick={props.onCopyFromBase}
            disabled={copyEmpty}
            title={
              copyEmpty
                ? "No base bullets to copy yet"
                : "Replace this variant's bullets with the base list"
            }
          >
            Copy from base
          </Button>
        )}
      </div>
    </div>
  );
}
