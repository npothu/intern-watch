"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Star, X, Undo2, Search, Command, Eye, Layers, Zap, Ghost, Bell, Sparkles, FileText, ChevronDown } from "lucide-react";

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------
type MockRow = {
  short: string;
  company: string;
  title: string;
  location: string;
  term: string;
  tag: string;
  added: string;
  dismissed: boolean;
  saved: boolean;
  applied: boolean;
  status: "applied" | "oa" | "phone_screen" | "interview" | "offer" | "rejected" | "withdrawn";
};

const MOCK_ROWS: MockRow[] = [
  { short: "a1b2c3d4e5f6", company: "Stripe", title: "Software Engineer Intern", location: "Seattle, WA", term: "Fall 2026", tag: "top", added: "2026-08-01", dismissed: false, saved: true, applied: false, status: "applied" },
  { short: "b2c3d4e5f6a7", company: "Figma", title: "Product Engineer Intern", location: "New York, NY", term: "Fall 2026", tag: "top", added: "2026-07-28", dismissed: false, saved: false, applied: true, status: "interview" },
  { short: "c3d4e5f6a7b8", company: "Delta Air Lines", title: "Data Science Intern", location: "Atlanta, GA", term: "Spring 2027", tag: "atlanta", added: "2026-07-30", dismissed: false, saved: false, applied: false, status: "oa" },
  { short: "d4e5f6a7b8c9", company: "Universal Creative", title: "Software Developer Intern", location: "Orlando, FL", term: "Summer 2027", tag: "", added: "2026-07-29", dismissed: false, saved: false, applied: false, status: "applied" },
  { short: "e5f6a7b8c9d0", company: "Notion", title: "Frontend Intern", location: "Remote", term: "Fall 2026", tag: "remote", added: "2026-08-02", dismissed: false, saved: true, applied: false, status: "phone_screen" },
  { short: "f6a7b8c9d0e1", company: "Linear", title: "SWE Intern, Growth", location: "Remote", term: "Spring 2027", tag: "", added: "2026-08-03", dismissed: false, saved: false, applied: false, status: "rejected" },
  { short: "a7b8c9d0e1f2", company: "Retool", title: "PM Intern (SWE-adjacent)", location: "San Francisco, CA", term: "Summer 2027", tag: "top", added: "2026-08-04", dismissed: false, saved: false, applied: true, status: "offer" },
];

const STATUS_LABELS: Record<string, string> = {
  applied: "Applied",
  oa: "OA",
  phone_screen: "Phone Screen",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};
const STATUS_ORDER: MockRow["status"][] = ["applied", "oa", "phone_screen", "interview", "offer", "rejected", "withdrawn"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function TagPill({ tag }: { tag: string }) {
  if (!tag) return null;
  const cls =
    tag === "top"
      ? "border border-[color-mix(in_srgb,var(--color-accent)_38%,transparent)] text-accent"
      : tag === "remote" || tag === "atlanta"
        ? "bg-[color-mix(in_srgb,var(--color-amber)_13%,transparent)] text-amber"
        : "bg-chip text-ink-2";
  return <span className={`ml-1.5 inline-block rounded-full px-1.5 py-[1px] text-[10.5px] font-medium leading-none ${cls}`}>{tag}</span>;
}

// ---------------------------------------------------------------------------
// Main demo
// ---------------------------------------------------------------------------
export default function LavishDemo() {
  const [rows, setRows] = useState<MockRow[]>(MOCK_ROWS);
  const [filter, setFilter] = useState<"all" | "applied" | "saved" | "hidden">("all");
  const [query, setQuery] = useState("");
  const [showPalette, setShowPalette] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [skeletonOn, setSkeletonOn] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<MockRow["status"]>("applied");
  const [peek, setPeek] = useState<string | null>(null);
  const [burst, setBurst] = useState<number>(0);
  const searchRef = useRef<HTMLInputElement>(null);

  // listen for cmd+k
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowPalette((v) => !v);
      }
      if (e.key === "/") {
        const ae = document.activeElement as HTMLElement | null;
        if (ae?.tagName !== "INPUT") {
          e.preventDefault();
          searchRef.current?.focus();
        }
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // toast autohide
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "hidden") return r.dismissed;
      if (r.dismissed) return false;
      if (filter === "applied" && !r.applied) return false;
      if (filter === "saved" && !r.saved) return false;
      if (q && !`${r.company} ${r.title} ${r.location}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, filter, query]);

  const grouped = useMemo(() => {
    const m = new Map<string, MockRow[]>();
    for (const r of filtered) {
      const k = r.term || "Unknown term";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    const order = ["Fall 2026", "Spring 2027", "Summer 2027"].filter((t) => m.has(t));
    const rest = [...m.keys()].filter((k) => !order.includes(k)).sort();
    return [...order, ...rest].map((t) => ({ term: t, rows: m.get(t)! }));
  }, [filtered]);

  const stats = useMemo(() => {
    const active = rows.filter((r) => !r.dismissed);
    return {
      total: active.length,
      applied: active.filter((r) => r.applied).length,
      saved: active.filter((r) => r.saved).length,
      hidden: rows.length - active.length,
    };
  }, [rows]);

  const toggle = (short: string, field: "applied" | "saved" | "dismissed") => {
    setRows((prev) => prev.map((r) => (r.short === short ? { ...r, [field]: !r[field] } : r)));
    if (field === "dismissed") {
      setBurst((n) => n + 1);
      setToast("Hidden — undo with U");
      setTimeout(() => setBurst(0), 900);
    } else if (field === "applied") {
      setToast("Toggled applied ✓");
    } else if (field === "saved") {
      setToast("Toggled saved ★");
    }
  };

  const restoreLast = () => {
    setRows((prev) => prev.map((r) => (r.dismissed ? { ...r, dismissed: false } : r)));
    setToast("Restored hidden");
  };

  return (
    <div className="min-h-dvh bg-bg text-ink">
      <style>{`@media(prefers-reduced-motion:reduce){*{animation-duration:0.01ms!important;transition-duration:0.01ms!important}}`}</style>

      {/* top bar */}
      <header className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1120px] items-center gap-3 px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="rounded-md bg-ink px-2 py-1 text-[11px] font-semibold tracking-wide text-bg">LAVISH</span>
            <span className="text-[16px] font-semibold tracking-tight">intern-watch motion lab</span>
            <span className="hidden text-xs text-ink-2 md:inline">— interactive overview of every proposed animation & UI addition</span>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-ink-2">
              <input type="checkbox" checked={reduced} onChange={(e) => setReduced(e.target.checked)} className="accent-accent" /> reduced motion
            </label>
            <a href="/" className="rounded-md border border-line bg-chip px-3 py-1.5 text-xs font-medium hover:bg-line">← Matches</a>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1120px] px-5 py-6 pb-24">
        {/* hero strip */}
        <div className="rounded-xl border border-line bg-surface p-5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[22px] font-semibold tracking-tight">Every motion earns its keep.</h1>
            <span className="rounded-full bg-chip px-2.5 py-1 text-xs text-ink-2">Fern &amp; Paper · Switzer · no purple gradients · no bento · no glassmorphism</span>
          </div>
          <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-ink-2">
            Press <kbd className="rounded border border-line-2 bg-chip px-1.5 py-0.5 font-mono text-[11px]">⌘K</kbd> for the palette, <kbd className="rounded border border-line-2 bg-chip px-1 py-0.5 font-mono text-[11px]">/</kbd> to focus search,
            <kbd className="rounded border border-line-2 bg-chip px-1 py-0.5 font-mono text-[11px]">U</kbd> to restore hidden. Hover a row for the JD peek. Toggle filters — rows FLIP with a 40ms stagger.
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className="inline-flex items-center gap-1 rounded-full border border-line-2 bg-bg px-2.5 py-1"><Layers className="size-3" /> Term groups are sticky &amp; scroll-spied</span>
            <span className="inline-flex items-center gap-1 rounded-full border border-line-2 bg-bg px-2.5 py-1"><Zap className="size-3" /> Funnel animates flex-basis 450ms spring</span>
            <span className="inline-flex items-center gap-1 rounded-full border border-line-2 bg-bg px-2.5 py-1"><Ghost className="size-3" /> Skeletons, not spinners</span>
          </div>
        </div>

        {/* statline as toggle-group (demo) */}
        <div className="mt-6 flex flex-wrap items-center gap-2">
          {(
            [
              ["all", `matches ${stats.total}`],
              ["applied", `applied ${stats.applied}`],
              ["saved", `saved ${stats.saved}`],
              ["hidden", `hidden ${stats.hidden}`],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setFilter(k)}
              className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${filter === k ? "border-accent bg-accent text-accent-ink shadow-sm" : "border-line-2 bg-surface text-ink hover:border-ink-2"}`}
            >
              {label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-2" />
              <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by company, title, location" className="w-[280px] rounded-md border border-line-2 bg-surface py-1.5 pl-8 pr-3 text-sm placeholder:text-ink-2/60 focus:border-accent focus:outline-none" />
            </div>
            <button onClick={() => setShowPalette(true)} className="inline-flex items-center gap-1.5 rounded-md border border-line-2 bg-surface px-2.5 py-1.5 text-xs hover:bg-chip">
              <Command className="size-3.5" /> ⌘K
            </button>
          </div>
        </div>

        {/* 1 — skeleton toggle demo */}
        <section className="mt-8 rounded-xl border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h2 className="text-[13px] font-semibold tracking-wide uppercase text-ink-2">01 · Skeletons, not spinners</h2>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={skeletonOn} onChange={(e) => setSkeletonOn(e.target.checked)} /> show skeleton state
            </label>
          </div>
          <div className="p-4">
            {skeletonOn ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="animate-pulse rounded-md border border-line bg-bg p-3">
                    <div className="h-3 w-28 rounded bg-line" />
                    <div className="mt-2 h-2 w-48 rounded bg-line" />
                    <div className="mt-2 h-2 w-32 rounded bg-chip" />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-ink-2">Toggle on to see the paper shimmer we use while <code className="rounded bg-chip px-1">getMatches/getTicks</code> resolves. Single-color, no gradient, respects <code>prefers-reduced-motion</code>.</p>
            )}
          </div>
        </section>

        {/* 2 — triage rows with FLIP + dismiss spring */}
        <section className="mt-6 rounded-xl border border-line bg-surface">
          <div className="flex items-center gap-2 border-b border-line px-4 py-3">
            <h2 className="text-[13px] font-semibold tracking-wide uppercase text-ink-2">02 · Triage rows — FLIP, stagger, dismiss spring + undo burst</h2>
            <span className="ml-auto text-xs text-ink-2">{filtered.length} visible</span>
            <button onClick={restoreLast} className="inline-flex items-center gap-1 rounded-md border border-line-2 bg-bg px-2 py-1 text-xs hover:bg-chip">
              <Undo2 className="size-3" /> Restore
            </button>
          </div>
          <div className="divide-y divide-line">
            {grouped.map((g) => (
              <div key={g.term} className="p-3">
                <div className="sticky top-[52px] z-10 -mx-3 flex items-center gap-2 bg-surface/90 px-3 py-1.5 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-ink-2 backdrop-blur">
                  {g.term} <span className="font-normal normal-case tracking-normal text-ink-2/70">— {g.rows.length}</span>
                </div>
                <div className="mt-2 space-y-2">
                  {g.rows.map((r, idx) => (
                    <div
                      key={r.short}
                      style={{ transitionDelay: reduced ? "0ms" : `${idx * 40}ms` }}
                      onMouseEnter={() => setPeek(r.short)}
                      onMouseLeave={() => setPeek((p) => (p === r.short ? null : p))}
                      className={`grid grid-cols-[46px_minmax(0,1fr)_auto] items-start gap-3 rounded-md border px-3 py-2.5 transition-all ${r.applied ? "border-accent/30 bg-[color-mix(in_srgb,var(--color-accent)_6%,var(--color-surface))]" : "border-line bg-bg"} ${peek === r.short ? "shadow-sm ring-1 ring-line" : ""} ${!reduced ? "data-[enter]:animate-[rowIn_220ms_ease-out]" : ""}`}
                    >
                      <div className="flex gap-1.5 pt-0.5">
                        <button
                          onClick={() => toggle(r.short, "applied")}
                          aria-label="toggle applied"
                          className={`flex size-[18px] items-center justify-center rounded-[5px] border-[1.5px] transition-all active:scale-90 ${r.applied ? "border-accent bg-accent text-accent-ink" : "border-line-2 bg-surface hover:border-ink-2"}`}
                        >
                          <Check className="size-3" strokeWidth={3.5} />
                        </button>
                        <button
                          onClick={() => toggle(r.short, "saved")}
                          aria-label="toggle saved"
                          className={`flex size-[18px] items-center justify-center rounded-[5px] border-[1.5px] transition-all active:scale-90 ${r.saved ? "border-amber bg-amber text-white" : "border-line-2 bg-surface hover:border-ink-2"}`}
                        >
                          <Star className="size-3" fill={r.saved ? "currentColor" : "none"} />
                        </button>
                      </div>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-baseline gap-1">
                          <span className={`text-[13.5px] font-semibold ${r.applied ? "opacity-60 line-through decoration-ink-2 decoration-dotted" : ""}`}>{r.company}</span>
                          <TagPill tag={r.tag} />
                          {peek === r.short && <span className="inline-flex items-center gap-1 rounded-full bg-chip px-2 py-0.5 text-[10.5px]"><Eye className="size-3" /> peek</span>}
                        </div>
                        <div className={`truncate text-[13px] ${r.applied ? "text-ink-2" : "text-ink"}`}>{r.title} · {r.location}</div>
                        <div className="text-[11.5px] tabular-nums text-ink-2">{r.added} · {r.short}</div>
                      </div>
                      <div className="flex items-center gap-1 self-center">
                        <a href="#" onClick={(e) => e.preventDefault()} className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-surface px-2 py-1 text-xs font-medium text-accent hover:border-ink-2"><FileText className="size-3.5" /> Apply</a>
                        <button onClick={() => toggle(r.short, "dismissed")} className="flex size-7 items-center justify-center rounded-md text-ink-2 transition-colors hover:bg-[color-mix(in_srgb,var(--color-red)_12%,transparent)] hover:text-red"><X className="size-3.5" /></button>
                      </div>
                    </div>
                  ))}
                </div>
                {peek && (
                  <div className="mt-2 rounded-md border border-line-2 bg-bg p-3 text-xs leading-relaxed text-ink-2">
                    <span className="font-semibold text-ink">JD peek</span> — {grouped.flatMap((g) => g.rows).find((r) => r.short === peek)?.title} at {grouped.flatMap((g) => g.rows).find((r) => r.short === peek)?.company}. Two-line, paper, no Glass.
                  </div>
                )}
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="px-4 py-16 text-center">
                <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-chip"><Ghost className="size-5 text-ink-2" /></div>
                <div className="mt-3 text-sm font-medium">No matches for that filter</div>
                <p className="mx-auto mt-1 max-w-md text-xs text-ink-2">Try clearing search or switching to <button onClick={() => { setQuery(""); setFilter("all"); }} className="underline decoration-dashed underline-offset-2">All matches</button>.</p>
              </div>
            )}
          </div>
          <div className={`mx-3 mb-3 rounded-md bg-ink px-3 py-2 text-xs text-bg transition-all ${burst ? "scale-[1.01] shadow" : ""}`}>Undo burst: {burst ? `${burst} hidden — press U` : "hidden rows are batched; this bar is the ink-slab aggregate"}</div>
        </section>

        {/* 3 — funnel */}
        <section className="mt-6 rounded-xl border border-line bg-surface p-4">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-ink-2">03 · Funnel — flex-basis 450ms spring</h2>
          <FunnelDemo />
        </section>

        {/* 4 — status pills with check-draw */}
        <section className="mt-6 rounded-xl border border-line bg-surface p-4">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-ink-2">04 · Status pills — check-draw 180ms</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {STATUS_ORDER.map((s) => (
              <button key={s} onClick={() => { setSelectedStatus(s); setToast(`Status → ${STATUS_LABELS[s]}`); }} className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${selectedStatus === s ? "border-accent bg-accent text-accent-ink" : "border-line-2 bg-bg hover:border-ink-2"}`}>
                {selectedStatus === s && <Check className="size-3" />} {STATUS_LABELS[s]}
              </button>
            ))}
          </div>
          <div className="mt-4 rounded-md border border-line bg-bg p-3 text-xs text-ink-2">Selected: <b className="text-ink">{STATUS_LABELS[selectedStatus]}</b> — ring ping is 140ms, stroke-dash draws once. Archive on select.</div>
        </section>

        {/* 5 — palette, empty, toast, coach */}
        <section className="grid gap-6 md:grid-cols-2 mt-6">
          <div className="rounded-xl border border-line bg-surface p-4">
            <h3 className="text-sm font-semibold">05 · Command palette (⌘K / namethatui)</h3>
            <p className="mt-1 text-xs leading-relaxed text-ink-2">Jump to company, term, or page. Reuses triage haystack. Vercel uses <code className="rounded bg-chip px-1">NEXT_PUBLIC_*</code> only for publishable; palette itself is client but pulls from in-memory rows.</p>
            <button onClick={() => setShowPalette(true)} className="mt-3 inline-flex items-center gap-2 rounded-md bg-ink px-3 py-1.5 text-xs font-medium text-bg"><Command className="size-3.5" /> Open palette</button>
            <div className="mt-3 rounded-md border border-dashed border-line bg-bg p-3 text-xs text-ink-2">Try: “stripe”, “atlanta”, “tracker”, “hidden”.</div>
          </div>
          <div className="rounded-xl border border-line bg-surface p-4">
            <h3 className="text-sm font-semibold">06 · Empty states</h3>
            <div className="mt-3 rounded-md border border-line bg-bg py-10 text-center">
              <div className="mx-auto flex size-9 items-center justify-center rounded-full bg-chip"><Layers className="size-4" /></div>
              <div className="mt-2 text-sm font-medium">No resumes yet</div>
              <div className="mx-auto mt-1 max-w-xs text-xs text-ink-2">When the other agent finishes Convex resume builds, cards appear here. Paper-fold illustration, single-color.</div>
            </div>
          </div>
        </section>

        <section className="mt-6 rounded-xl border border-line bg-surface p-4">
          <h3 className="text-sm font-semibold">07 · Toasts + keyboard coach</h3>
          <div className="mt-2 flex flex-wrap gap-2">
            <button onClick={() => setToast("Saved ★ — will persist to Convex on flush")} className="rounded-md border border-line-2 bg-bg px-3 py-1.5 text-xs hover:bg-chip">Trigger toast</button>
            <button onClick={() => setToast("Hidden — batched 500ms, U to undo")} className="rounded-md bg-ink px-3 py-1.5 text-xs font-medium text-bg">Trigger ink-slab</button>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
            {[
              ["j / k", "move cursor"],
              ["x", "toggle applied"],
              ["s", "toggle saved"],
              ["h", "hide"],
              ["Enter", "open"],
              ["u", "undo burst"],
              ["/", "focus search"],
              ["⌘K", "palette"],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center gap-2 rounded-md border border-line bg-bg px-2.5 py-2"><kbd className="rounded border border-line-2 bg-chip px-1.5 py-0.5 font-mono text-[11px]">{k}</kbd><span className="text-ink-2">{v}</span></div>
            ))}
          </div>
        </section>

        <div className="mt-6 rounded-md border border-amber/30 bg-[color-mix(in_srgb,var(--color-amber)_10%,var(--color-bg))] px-3 py-2.5 text-xs text-ink-2">
          <b className="text-ink">Note:</b> All motion honors <code className="rounded bg-chip px-1">prefers-reduced-motion</code>. No aurora blobs, no gradient headlines, no bento. See <code>taste</code> guard.
        </div>
      </main>

      {/* toaster */}
      {toast && <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full bg-ink px-4 py-2 text-xs font-medium text-bg shadow-lg">{toast}</div>}

      {/* palette overlay */}
      {showPalette && (
        <div className="fixed inset-0 z-50 bg-ink/40 backdrop-blur-sm" onClick={() => setShowPalette(false)}>
          <div onClick={(e) => e.stopPropagation()} className="mx-auto mt-[14vh] w-[min(560px,92vw)] overflow-hidden rounded-xl border border-line bg-surface shadow-xl">
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <Search className="size-4 text-ink-2" />
              <input autoFocus placeholder="Type a company, term, or page…" className="w-full bg-transparent py-1.5 text-sm outline-none placeholder:text-ink-2/60" />
              <span className="rounded border border-line-2 bg-chip px-1.5 py-0.5 font-mono text-[11px]">ESC</span>
            </div>
            <div className="max-h-[42vh] overflow-auto p-2 text-sm">
              <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-ink-2">Jump</div>
              {MOCK_ROWS.slice(0, 4).map((r) => (
                <button key={r.short} onClick={() => { setPeek(r.short); setShowPalette(false); setToast(`Jumped to ${r.company}`); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-chip">
                  <span className="size-2 rounded-full bg-accent" /> {r.company} <span className="text-ink-2">— {r.title}</span>
                </button>
              ))}
              <div className="mt-2 border-t border-line pt-2">
                <button onClick={() => { setFilter("hidden"); setShowPalette(false); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-chip"><Ghost className="size-4" /> Show hidden</button>
                <button onClick={() => { setQuery("atlanta"); setShowPalette(false); }} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-chip"><Search className="size-4" /> Filter “atlanta”</button>
              </div>
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes rowIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}`}</style>
    </div>
  );
}

function FunnelDemo() {
  const [counts, setCounts] = useState<Record<string, number>>({ applied: 3, oa: 1, interview: 1, offer: 1, rejected: 1 });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const present = STATUS_ORDER.filter((s) => counts[s as string]);
  const add = () => setCounts((c) => ({ ...c, applied: (c.applied ?? 0) + 1 }));
  const ship = () =>
    setCounts((c) => {
      if ((c.applied ?? 0) === 0) return c;
      return { ...c, applied: c.applied - 1, interview: (c.interview ?? 0) + 1 };
    });
  return (
    <div>
      <div className="flex h-3.5 overflow-hidden rounded-md border border-line-2 bg-bg">
        {present.map((s) => (
          <span
            key={s}
            className={`min-w-[8px] transition-all duration-[450ms] ${s === "applied" ? "bg-accent/70" : s === "offer" ? "bg-accent" : s === "rejected" ? "bg-red" : "bg-amber"}`}
            style={{ flex: counts[s as string] ?? 0 }}
            title={`${counts[s as string]} ${s}`}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-xs tabular-nums">
        {present.map((s) => (
          <span key={s}><b className="text-ink">{counts[s as string]}</b> {s}</span>
        ))}
        <span className="text-ink-2">· total {total}</span>
        <span className="ml-auto flex gap-2">
          <button onClick={add} className="rounded-md border border-line-2 bg-bg px-2 py-1 hover:bg-chip">+ applied</button>
          <button onClick={ship} className="rounded-md bg-ink px-2 py-1 font-medium text-bg">applied → interview</button>
        </span>
      </div>
    </div>
  );
}
