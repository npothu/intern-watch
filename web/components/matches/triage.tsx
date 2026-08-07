"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { Check, Star, X, Undo2, FileText, Search, Command, Eye } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { writeTicks } from "@/app/(app)/matches-actions";
import type { TriageRow } from "@/app/(app)/page";
import type { TickWrite } from "@/lib/convex";

type StatusFilter = "all" | "todo" | "applied" | "saved" | "resume" | "hidden" | "stale";
type TermFilter = string;

const TERM_ORDER = ["Fall 2026", "Spring 2027", "Summer 2027"];
const UNKNOWN_TERM = "Unknown term";

const FLUSH_IDLE = 500;
const FLUSH_CAP = 50;
const BURST_MS = 6000;
const SWIPE_THRESHOLD = 70;

const STATLINE_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "matches" },
  { key: "applied", label: "applied" },
  { key: "saved", label: "saved" },
  { key: "resume", label: "resumes" },
  { key: "hidden", label: "hidden" },
];

function fmtDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function likelyClosed(r: TriageRow): boolean {
  if (typeof r.staleDays === "number") return r.staleDays >= 7;
  if (!r.added) return false;
  const d = new Date(r.added.length === 10 ? `${r.added}T00:00:00` : r.added);
  if (Number.isNaN(d.getTime())) return false;
  const days = (Date.now() - d.getTime()) / 864e5;
  return days >= 7;
}

function visibleRows(rows: TriageRow[], status: StatusFilter, term: TermFilter, query: string): TriageRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (status === "hidden" ? !r.dismissed : r.dismissed) return false;
    if (term !== "All" && (r.term || UNKNOWN_TERM) !== term) return false;
    if (status === "todo" && r.applied) return false;
    if (status === "applied" && !r.applied) return false;
    if (status === "saved" && !r.saved) return false;
    if (status === "resume" && !r.resumeUrl) return false;
    if (status === "stale" && !likelyClosed(r)) return false;
    if (q) {
      const hay = `${r.company} ${r.title} ${r.location} ${r.short}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function groupByTerm(rows: TriageRow[]): { term: string; rows: TriageRow[] }[] {
  const groups = new Map<string, TriageRow[]>();
  for (const r of rows) {
    const t = r.term || UNKNOWN_TERM;
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t)!.push(r);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => (b.added || "").localeCompare(a.added || "") || a.company.localeCompare(b.company));
  }
  const order = [
    ...TERM_ORDER.filter((t) => groups.has(t)),
    ...[...groups.keys()].filter((t) => !TERM_ORDER.includes(t) && t !== UNKNOWN_TERM).sort(),
    ...(groups.has(UNKNOWN_TERM) ? [UNKNOWN_TERM] : []),
  ];
  return order.map((t) => ({ term: t, rows: groups.get(t)! }));
}

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState<boolean>(() => typeof window !== "undefined" && window.matchMedia("(max-width: 699px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 699px)");
    const onChange = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return mobile;
}

function Tags({ tag }: { tag: string }) {
  if (!tag) return null;
  const raw = tag.replace(/[\[\]*]/g, "").toLowerCase();
  const cls = raw.includes("top") ? "border border-[color-mix(in_srgb,var(--color-accent)_38%,transparent)] text-accent" : raw.includes("gone") ? "bg-[color-mix(in_srgb,var(--color-amber)_13%,transparent)] text-amber" : "bg-chip text-ink-2";
  return <span title={tag} className={cn("ml-1.5 inline-block rounded-full px-1.5 py-[1px] align-[2px] text-[10.5px] font-medium leading-none", cls)}>{raw}</span>;
}

function Divider({ className }: { className?: string }) { return <span className={cn("h-5 w-px self-center bg-line", className)} />; }

export function Triage({ rows: initialRows }: { rows: TriageRow[] }) {
  const [rows, setRows] = useState<TriageRow[]>(initialRows);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [term, setTerm] = useState<TermFilter>("All");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [peek, setPeek] = useState<string | null>(null);
  const [showPalette, setShowPalette] = useState(false);
  const [burst, setBurst] = useState<{ visible: boolean; count: number }>({ visible: false, count: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pendingDismiss = useRef<Map<string, boolean>>(new Map());
  const flushTimer = useRef<number | null>(null);
  const flushBusy = useRef(false);
  const burstShorts = useRef<Set<string>>(new Set());
  const burstTimer = useRef<number | null>(null);
  const isMobile = useIsMobile();

  const updateRow = useCallback((short: string, patch: Partial<TriageRow>) => { setRows((prev) => prev.map((r) => (r.short === short ? { ...r, ...patch } : r))); }, []);
  const visible = useMemo(() => visibleRows(rows, status, term, query), [rows, status, term, query]);
  const groups = useMemo(() => groupByTerm(visible), [visible]);
  const ordered = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
  const stats = useMemo(() => {
    const active = rows.filter((r) => !r.dismissed);
    return { matches: active.length, applied: active.filter((r) => r.applied).length, togo: active.filter((r) => !r.applied).length, saved: active.filter((r) => r.saved).length, resumes: active.filter((r) => r.resumeUrl).length, hidden: rows.length - active.length, stale: active.filter((r) => likelyClosed(r)).length };
  }, [rows]);
  const termOptions = useMemo(() => {
    const inData = [...new Set(rows.map((r) => r.term || UNKNOWN_TERM))];
    const ordered = TERM_ORDER.filter((tt) => inData.includes(tt));
    const rest = inData.filter((tt) => !TERM_ORDER.includes(tt) && tt !== UNKNOWN_TERM).sort();
    const tail = inData.includes(UNKNOWN_TERM) ? [UNKNOWN_TERM] : [];
    return ["All", ...ordered, ...rest, ...tail.filter((x) => !ordered.includes(x) && !rest.includes(x))];
  }, [rows]);

  const cursorIndex = cursor ? ordered.findIndex((r) => r.short === cursor) : -1;
  const currentRow = cursorIndex >= 0 ? ordered[cursorIndex] : null;
  useEffect(() => { if (!cursor) return; const el = rootRef.current?.querySelector?.('[data-cursor="1"]'); el?.scrollIntoView?.({ block: "nearest" }); }, [cursor]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setShowPalette((v) => !v); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  function sealBurst() { if (burstTimer.current) { window.clearTimeout(burstTimer.current); burstTimer.current = null; } burstShorts.current.clear(); setBurst({ visible: false, count: 0 }); }
  function undoBurst() {
    if (!burstShorts.current.size) return;
    const shorts = [...burstShorts.current];
    let needsFlush = false;
    for (const s of shorts) {
      const v = pendingDismiss.current.get(s);
      if (v === true) pendingDismiss.current.delete(s);
      else if (v === false) {}
      else { pendingDismiss.current.set(s, false); needsFlush = true; }
      updateRow(s, { dismissed: false });
    }
    sealBurst();
    if (needsFlush) scheduleFlush();
  }
  async function flush() {
    if (flushTimer.current) { window.clearTimeout(flushTimer.current); flushTimer.current = null; }
    const queue = pendingDismiss.current;
    if (!queue.size || flushBusy.current) return;
    const writes: TickWrite[] = [];
    for (const [short, value] of queue) writes.push({ short, field: "dismissed", value });
    flushBusy.current = true;
    try { await writeTicks(writes); for (const w of writes) if (queue.get(w.short) === w.value) queue.delete(w.short); } catch { for (const w of writes) { if (queue.get(w.short) === w.value) queue.delete(w.short); updateRow(w.short, { dismissed: !w.value }); } toast.error("Couldn't sync hides - reverted."); } finally { flushBusy.current = false; if (queue.size) scheduleFlush(); }
  }
  function scheduleFlush() {
    const queue = pendingDismiss.current;
    if (!queue.size || flushBusy.current) return;
    if (queue.size >= FLUSH_CAP) { if (flushTimer.current) window.clearTimeout(flushTimer.current); flushTimer.current = null; void flush(); return; }
    if (flushTimer.current) window.clearTimeout(flushTimer.current);
    flushTimer.current = window.setTimeout(() => { flushTimer.current = null; void flush(); }, FLUSH_IDLE);
  }
  function queueDismiss(short: string, dismissed: boolean) {
    const queue = pendingDismiss.current;
    if (queue.get(short) === dismissed) return;
    queue.set(short, dismissed);
    updateRow(short, { dismissed });
    if (dismissed) { burstShorts.current.add(short); setBurst({ visible: true, count: burstShorts.current.size }); if (burstTimer.current) window.clearTimeout(burstTimer.current); burstTimer.current = window.setTimeout(sealBurst, BURST_MS); }
    scheduleFlush();
  }
  function hideShort(short: string) { const i = ordered.findIndex((r) => r.short === short); const next = ordered[i + 1] || ordered[i - 1]; setCursor(next ? next.short : null); queueDismiss(short, true); }
  function restoreShort(short: string) { queueDismiss(short, false); }
  function toggleApplied(short: string) { const r = rows.find((x) => x.short === short); if (!r) return; const value = !r.applied; updateRow(short, { applied: value }); void writeTicks([{ short, field: "applied", value }]).catch(() => { updateRow(short, { applied: r.applied }); toast.error("Couldn't sync applied state."); }); }
  function toggleSaved(short: string) { const r = rows.find((x) => x.short === short); if (!r) return; const value = !r.saved; updateRow(short, { saved: value }); void writeTicks([{ short, field: "saved", value }]).catch(() => { updateRow(short, { saved: r.saved }); toast.error("Couldn't sync saved state."); }); }
  function move(d: number) { if (!ordered.length) return; let i = cursorIndex; if (i < 0) i = d > 0 ? 0 : ordered.length - 1; else i = Math.max(0, Math.min(ordered.length - 1, i + d)); setCursor(ordered[i].short); }
  function openRow(row?: TriageRow) { const r = row ?? currentRow; if (r?.url) window.open(r.url, "_blank", "noopener"); }
  function actOnCurrent(kind: "applied" | "saved" | "hide") { if (!currentRow) return; if (kind === "applied") { toggleApplied(currentRow.short); move(1); } else if (kind === "saved") { toggleSaved(currentRow.short); move(1); } else hideShort(currentRow.short); }
  const keyboardActions = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    keyboardActions.current = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      if (k === "j" || k === "ArrowDown") { e.preventDefault(); move(1); } else if (k === "k" || k === "ArrowUp") { e.preventDefault(); move(-1); } else if (k === "/") { e.preventDefault(); searchRef.current?.focus(); } else if (k === "x") { e.preventDefault(); actOnCurrent("applied"); } else if (k === "s") { e.preventDefault(); actOnCurrent("saved"); } else if (k === "h") { e.preventDefault(); actOnCurrent("hide"); } else if (k === "u") { e.preventDefault(); undoBurst(); } else if (k === "Enter") { e.preventDefault(); openRow(); }
    };
  });
  useEffect(() => { const onKey = (e: KeyboardEvent) => keyboardActions.current(e); window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, []);
  const hasAnyRows = rows.length > 0;
  const emptyFilter = hasAnyRows && groups.length === 0;

  return (
    <div ref={rootRef} className="mx-auto w-full max-w-[1060px] px-5 py-5 pb-32">
      <style>{`@keyframes rowIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}} @media(prefers-reduced-motion:reduce){*{animation-duration:0.01ms!important;transition-duration:0.01ms!important}}`}</style>
      <div className="mb-3 text-[13px] text-ink-2 tabular-nums">
        {STATLINE_FILTERS.map((s, i) => {
          const n = s.key === "all" ? stats.matches : s.key === "applied" ? stats.applied : s.key === "saved" ? stats.saved : s.key === "resume" ? stats.resumes : stats.hidden;
          const active = status === s.key;
          return (<span key={s.key}>{i > 0 && <span className="mx-1">·</span>}<button type="button" onClick={() => setStatus((f) => (f === s.key ? "all" : s.key))} className={cn("cursor-pointer rounded-sm px-0.5 transition-colors", active ? "text-accent underline decoration-dashed underline-offset-[3px]" : "hover:text-accent hover:underline hover:decoration-dashed hover:underline-offset-[3px]")}><b className="font-semibold text-ink">{n}</b> <span className="text-ink-2">{s.label}</span></button></span>);
        })}
        <span className="mx-1">·</span><button type="button" onClick={() => setStatus((f) => (f === "todo" ? "all" : "todo"))} className={cn("cursor-pointer rounded-sm px-0.5 transition-colors", status === "todo" ? "text-accent underline decoration-dashed underline-offset-[3px]" : "hover:text-accent hover:underline hover:decoration-dashed hover:underline-offset-[3px]")}><b className="font-semibold text-ink">{stats.togo}</b> <span className="text-ink-2">to go</span></button>
        {stats.stale > 0 && (<><span className="mx-1">·</span><button type="button" onClick={() => setStatus((f) => (f === "stale" ? "all" : "stale"))} className={cn("cursor-pointer rounded-sm px-0.5 transition-colors", status === "stale" ? "text-accent underline decoration-dashed underline-offset-[3px]" : "hover:text-accent hover:underline hover:decoration-dashed hover:underline-offset-[3px]")}><b className="font-semibold text-ink">{stats.stale}</b> <span className="text-ink-2">likely closed</span></button></>)}
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-2" />
          <input ref={searchRef} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search company, title, location, short…" autoComplete="off" aria-label="Search matches" className="w-full rounded-[5px] border border-line-2 bg-surface py-1.5 pl-8 pr-3 text-[13px] text-ink placeholder:text-ink-2/70 focus:border-accent focus:outline-none" />
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Status filter" className="rounded-[5px] border border-line-2 bg-surface px-2.5 py-1.5 text-[13px] text-ink focus:border-accent focus:outline-none"><option value="all">All</option><option value="todo">To apply</option><option value="applied">Applied</option><option value="saved">Saved</option><option value="resume">Has resume</option><option value="stale">Likely closed</option><option value="hidden">Hidden</option></select>
        <button onClick={() => setShowPalette(true)} className="inline-flex items-center gap-1.5 rounded-md border border-line-2 bg-surface px-2.5 py-1.5 text-xs hover:bg-chip"><Command className="size-3.5" /> ⌘K</button>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {termOptions.map((tt) => (<button key={tt} type="button" onClick={() => setTerm(tt)} aria-pressed={term === tt} className={cn("rounded-full border px-2.5 py-1 text-[12.5px] font-medium leading-none transition-colors", term === tt ? "border-accent bg-accent text-accent-ink" : "border-line-2 bg-surface text-ink-2 hover:border-line hover:text-ink")}>{tt}</button>))}
      </div>
      {!hasAnyRows ? (<div className="rounded-md border border-line bg-surface"><div className="px-4 py-20 text-center"><div className="text-[13.5px] font-medium text-ink">No matches yet.</div><p className="mt-1 text-[12.5px] text-ink-2">Matches will land here as the watcher finds them.</p></div></div>) : emptyFilter ? (<div className="rounded-md border border-line bg-surface"><div className="px-4 py-7 text-center text-[13px] text-ink-2">Nothing matches the current filters.<button type="button" onClick={() => { setStatus("all"); setTerm("All"); setQuery(""); }} className="ml-2 font-medium text-accent underline decoration-dashed underline-offset-2">clear filters</button></div></div>) : (groups.map((g) => (
        <section key={g.term} className="mb-5 last:mb-0">
          <h2 className="sticky top-2 z-10 mb-1.5 flex items-baseline gap-1.5 bg-bg/80 py-1 text-[11.5px] font-semibold tracking-[0.09em] text-ink-2 uppercase backdrop-blur">{g.term}<span className="font-normal not-italic tracking-normal normal-case text-ink-2/80">· {g.rows.length}</span></h2>
          <div className="overflow-hidden rounded-md border border-line bg-surface">{g.rows.map((r, idx) => (<div key={r.short} style={{ transitionDelay: `${idx * 35}ms` }} onMouseEnter={() => setPeek(r.short)} onMouseLeave={() => setPeek((p) => (p === r.short ? null : p))} className="animate-[rowIn_220ms_ease-out_both]"><RowView row={r} isCursor={r.short === cursor} peek={peek === r.short} onSelect={() => setCursor(r.short)} onToggleApplied={() => toggleApplied(r.short)} onToggleSaved={() => toggleSaved(r.short)} onHide={() => hideShort(r.short)} onRestore={() => restoreShort(r.short)} /></div>))}</div>
        </section>
      )))}
      {showPalette && (
        <div className="fixed inset-0 z-50 bg-ink/40 backdrop-blur-sm" onClick={() => setShowPalette(false)}>
          <div onClick={(e) => e.stopPropagation()} className="mx-auto mt-[14vh] w-[min(560px,92vw)] overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
            <div className="flex items-center gap-2 border-b border-line px-3 py-2"><Search className="size-4 text-ink-2" /><input autoFocus placeholder="Type company, term, or filter…" className="w-full bg-transparent py-1.5 text-sm outline-none placeholder:text-ink-2/60" /><span className="rounded border border-line-2 bg-chip px-1.5 py-0.5 font-mono text-[11px]">ESC</span></div>
            <div className="max-h-[42vh] overflow-auto p-2 text-sm">
              <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-ink-2">Filters</div>
              <button onClick={() => { setTerm("All"); setStatus("all"); setQuery(""); setShowPalette(false); }} className="flex w-full rounded-md px-2 py-1.5 text-left hover:bg-chip">Clear filters</button>
              <button onClick={() => { setStatus("stale"); setShowPalette(false); }} className="flex w-full rounded-md px-2 py-1.5 text-left hover:bg-chip">Likely closed</button>
              <button onClick={() => { setTerm("Fall 2026"); setShowPalette(false); }} className="flex w-full rounded-md px-2 py-1.5 text-left hover:bg-chip">Fall 2026</button>
            </div>
          </div>
        </div>
      )}
      <Dock onNav={(d) => move(d)} onAct={(kind) => actOnCurrent(kind)} onOpen={() => openRow()} />
      {burst.visible && (<div className="fixed right-4 bottom-[76px] z-[60] flex items-center gap-3 rounded-md bg-ink px-3.5 py-2.5 text-[13px] text-bg shadow-[0_4px_16px_color-mix(in_srgb,var(--color-ink)_22%,transparent)]">Hidden {burst.count}<button type="button" onClick={undoBurst} className="cursor-pointer font-medium text-amber">Undo</button></div>)}
    </div>
  );
}

function RowView({ row, isCursor, peek, onSelect, onToggleApplied, onToggleSaved, onHide, onRestore }: { row: TriageRow; isCursor: boolean; peek: boolean; onSelect: () => void; onToggleApplied: () => void; onToggleSaved: () => void; onHide: () => void; onRestore: () => void }) {
  return (
    <div data-cursor={isCursor ? "1" : undefined} onClick={(e) => { const t = e.target as HTMLElement; if (t.closest("[data-applied-tick]") || t.closest("[data-saved-tick]") || t.closest("[data-hide]") || t.closest("[data-restore]") || t.closest("[data-open]")) return; onSelect(); }} className={cn("grid cursor-default grid-cols-[46px_minmax(0,1fr)_auto] items-start gap-x-3 border-t border-line px-3 py-2.5 first:border-t-0 transition-all select-none", isCursor && "bg-[color-mix(in_srgb,var(--color-accent)_4%,transparent)] shadow-[inset_3px_0_0_var(--color-accent)]", peek && "ring-1 ring-line bg-[color-mix(in_srgb,var(--color-accent)_3%,var(--color-surface))]")} >
      <div className="flex gap-1.5 pt-0.5">
        <button type="button" data-applied-tick aria-label={row.applied ? "Mark as not applied" : "Mark as applied"} aria-pressed={row.applied} onClick={onToggleApplied} className={cn("flex h-[17px] w-[17px] items-center justify-center rounded-[5px] border-[1.5px] transition-all active:scale-90", row.applied ? "border-accent bg-accent text-accent-ink" : "border-line-2 bg-surface text-transparent hover:border-ink-2 hover:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_14%,transparent)]")}><Check className="size-3" strokeWidth={3.5} /></button>
        <button type="button" data-saved-tick aria-label={row.saved ? "Unsave" : "Save"} aria-pressed={row.saved} onClick={onToggleSaved} className={cn("flex h-[17px] w-[17px] items-center justify-center rounded-[5px] border-[1.5px] transition-all active:scale-90", row.saved ? "border-amber bg-[color-mix(in_srgb,var(--color-amber)_16%,var(--color-surface))] text-amber" : "border-line-2 bg-surface text-transparent hover:border-ink-2 hover:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_14%,transparent)]")}><Star className="size-3" strokeWidth={2} fill={row.saved ? "currentColor" : "none"} /></button>
      </div>
      <div className="min-w-0">
        <span className={cn("text-[13.5px] font-semibold", row.applied && "opacity-55")}>{row.company}</span><Tags tag={row.tag} />{peek && <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-chip px-1.5 py-0.5 text-[10.5px]"><Eye className="size-3" /> peek</span>}
        <div className={cn("truncate text-[12.5px] text-ink-2", row.applied && "opacity-55")} title={row.title}>{row.title}</div>
        <div className="mt-0.5 text-[11.5px] text-ink-2 tabular-nums">{row.location}{row.salary ? ` · ${row.salary}` : ""} · seen {fmtDate(row.added)} · <span className="font-mono text-[10.5px]">{row.short}</span>{peek && <span className="ml-2 hidden text-ink-2 md:inline">— {row.title} at {row.company}</span>}</div>
      </div>
      <div className="flex items-center gap-1.5 self-center">
        {row.resumeUrl && (<a data-open href={row.resumeUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1.5 rounded-[5px] border border-[color-mix(in_srgb,var(--color-accent)_42%,transparent)] bg-surface px-2 py-[5px] text-[12px] font-medium whitespace-nowrap text-accent transition-colors hover:border-ink-2"><FileText className="size-3.5" /> resume</a>)}
        {row.dismissed ? (<button type="button" data-restore title="restore" onClick={onRestore} className="flex h-[26px] w-[26px] items-center justify-center rounded-[5px] text-ink-2 transition-colors hover:bg-[color-mix(in_srgb,var(--color-amber)_12%,transparent)] hover:text-amber"><Undo2 className="size-3.5" /></button>) : (<button type="button" data-hide title="hide" onClick={onHide} className="flex h-[26px] w-[26px] items-center justify-center rounded-[5px] text-ink-2 transition-colors hover:bg-[color-mix(in_srgb,var(--color-red)_12%,transparent)] hover:text-red"><X className="size-3.5" /></button>)}
      </div>
    </div>
  );
}

function MobileCard(_props: unknown) { return null; }
function Dock(props: { onNav: (d: number) => void; onAct: (kind: "applied" | "saved" | "hide") => void; onOpen: () => void }) {
  const kbd = "rounded border border-line-2 bg-surface px-1 py-px font-mono text-[10.5px] font-medium text-ink-2";
  const db = "inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-transparent bg-transparent px-2 py-1.5 text-[12.5px] font-medium text-ink transition-colors select-none active:translate-y-px hover:bg-chip";
  const label = "hidden min-[701px]:inline";
  return (<div className="fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100vw-24px)] translate-x-[-50%] items-center gap-1 rounded-[9px] border border-line-2 bg-surface px-1.5 py-1 shadow-[0_6px_24px_color-mix(in_srgb,var(--color-ink)_16%,transparent)]" onClick={(e) => { const t = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null; if (!t) return; const act = t.dataset.act as any; if (act === "up" || act === "down") props.onNav(act === "up" ? -1 : 1); else if (act === "open") props.onOpen(); else if (act) props.onAct(act); }}><button type="button" data-act="up" className={cn(db, "text-ink-2")}><span className={kbd}>k</span></button><button type="button" data-act="down" className={cn(db, "text-ink-2")}><span className={kbd}>j</span></button><span className="h-5 w-px self-center bg-line" /><button type="button" data-act="applied" className={cn(db, "text-accent")}><span className={kbd}>x</span> <span className={label}>applied</span></button><button type="button" data-act="saved" className={cn(db, "text-amber")}><span className={kbd}>s</span> <span className={label}>save</span></button><button type="button" data-act="hide" className={cn(db, "text-red")}><span className={kbd}>h</span> <span className={label}>hide</span></button><span className="h-5 w-px self-center bg-line" /><button type="button" data-act="open" className={db}><span className={kbd}>↵</span> <span className={label}>open</span></button></div>);
}
