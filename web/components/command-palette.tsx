"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Cmd/Ctrl+K command palette, shared by the matches and tracker surfaces.
 *
 * The visual design is carried over from the lavish prototype (scrim + blur, a
 * 560px card at 14vh, search row with an ESC keycap, Jump section over a
 * divided action list). The prototype was a mock - its input had no value and
 * the Jump list was a hardcoded slice - so everything below the chrome is new:
 * the query actually filters, results come from the host surface's real rows,
 * and the highlight is keyboard-driven (Up/Down move it, Enter runs it, Esc
 * closes).
 *
 * The host owns nothing but the data: it hands over the jump targets and the
 * actions, and the palette owns its open state and every key it needs.
 */

/** One jumpable record (a match row, a tracked application). */
export type PaletteJump = {
  id: string;
  /** Primary text - the company. */
  title: string;
  /** Secondary text - the job title. */
  subtitle: string;
};

/** One non-jump command, rendered below the divider. */
export type PaletteAction = {
  id: string;
  label: string;
  icon: ReactNode;
  run: () => void;
};

const MAX_JUMPS = 6;

type Entry =
  | { kind: "jump"; id: string; item: PaletteJump }
  | { kind: "action"; id: string; item: PaletteAction };

function matches(haystack: string, q: string): boolean {
  return haystack.toLowerCase().includes(q);
}

export function CommandPalette({
  jumps,
  onJump,
  actions,
}: {
  jumps: PaletteJump[];
  /** Called with the chosen jump id; the host moves its own cursor. */
  onJump: (id: string) => void;
  actions: PaletteAction[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Ctrl/Cmd+K toggles. Registered in the capture phase so it wins over the
  // triage surface's own window-level key handling, whatever the focus is.
  // Every open starts from a clean query at the top of the list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
        setQuery("");
        setActive(0);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const q = query.trim().toLowerCase();

  const entries = useMemo<Entry[]>(() => {
    const jumpHits = (
      q ? jumps.filter((j) => matches(`${j.title} ${j.subtitle}`, q)) : jumps
    ).slice(0, MAX_JUMPS);
    const actionHits = q
      ? actions.filter((a) => matches(a.label, q))
      : actions;
    return [
      ...jumpHits.map((item): Entry => ({ kind: "jump", id: `j:${item.id}`, item })),
      ...actionHits.map((item): Entry => ({ kind: "action", id: `a:${item.id}`, item })),
    ];
  }, [jumps, actions, q]);

  const jumpCount = entries.filter((e) => e.kind === "jump").length;

  // Typing shortens the list, so the highlight is clamped on read rather than
  // written back - the stored index is only ever a hint.
  const clamped = entries.length === 0 ? 0 : Math.min(active, entries.length - 1);

  useLayoutEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="1"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [open, clamped, entries.length]);

  const close = useCallback(() => setOpen(false), []);

  const run = useCallback(
    (entry: Entry | undefined) => {
      if (!entry) return;
      setOpen(false);
      if (entry.kind === "jump") onJump(entry.item.id);
      else entry.item.run();
    },
    [onJump]
  );

  if (!open) return null;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive(entries.length ? (clamped + 1) % entries.length : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive(
        entries.length ? (clamped - 1 + entries.length) % entries.length : 0
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(entries[clamped]);
    }
  }

  const rowBase =
    "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors";

  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 backdrop-blur-sm"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="mx-auto mt-[14vh] w-[min(560px,92vw)] overflow-hidden rounded-xl border border-line bg-surface shadow-xl"
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <Search className="size-4 shrink-0 text-ink-2" />
          <input
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            aria-label="Search commands"
            placeholder="Type a company, term, or page…"
            className="w-full bg-transparent py-1.5 text-sm text-ink outline-none placeholder:text-ink-2/60"
          />
          <button
            type="button"
            onClick={close}
            aria-label="Close command palette"
            className="shrink-0 cursor-pointer rounded border border-line-2 bg-chip px-1.5 py-0.5 font-mono text-[11px] text-ink-2"
          >
            ESC
          </button>
        </div>
        <div ref={listRef} className="max-h-[42vh] overflow-auto p-2 text-sm">
          {entries.length === 0 && (
            <div className="px-2 py-6 text-center text-[13px] text-ink-2">
              Nothing matches “{query.trim()}”.
            </div>
          )}
          {jumpCount > 0 && (
            <div className="px-2 py-1 text-xs font-semibold tracking-wide text-ink-2 uppercase">
              Jump
            </div>
          )}
          {entries.map((entry, i) => {
            const isActive = i === clamped;
            const dividerAbove = entry.kind === "action" && i === jumpCount && jumpCount > 0;
            return (
              <div
                key={entry.id}
                className={cn(dividerAbove && "mt-2 border-t border-line pt-2")}
              >
                <button
                  type="button"
                  data-active={isActive ? "1" : undefined}
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(entry)}
                  className={cn(rowBase, isActive ? "bg-chip" : "hover:bg-chip")}
                >
                  {entry.kind === "jump" ? (
                    <>
                      <span className="size-2 shrink-0 rounded-full bg-accent" />
                      <span className="truncate text-ink">{entry.item.title}</span>
                      <span className="truncate text-ink-2">
                        - {entry.item.subtitle}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="shrink-0 text-ink-2">{entry.item.icon}</span>
                      <span className="text-ink">{entry.item.label}</span>
                    </>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
