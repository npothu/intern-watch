"use client";

// web/components/matches/triage.tsx — full replacement implementing the
// approved motion set on top of the existing component, unchanged in data
// flow (writeTicks batching, burst semantics, filters, mobile swipe):
//
//   1a  sliding cursor rail + wash (one element per term group, measured,
//       springs between rows) and spring ticks (check draws itself, star
//       pops) — animations fire only on user toggle, never on first paint
//   1b  entrance cascade on mount / filter change / settled search change
//       (list remounts via `epoch` key; stagger capped at 12 rows)
//   1d  glass dock with keycap press ripple, fired from BOTH clicks and
//       keyboard shortcuts, plus a one-time entrance rise
//   1g  hide = 320ms grid-row collapse, THEN the optimistic dismiss commits;
//       undo/restore plays the reverse; ink slab count pulses per hide
//
// Requires the "motion block" appended to app/globals.css.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { Check, Star, X, Undo2, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  writeTicks,
  requestResumeBuild,
  fetchBuildStatus,
  fetchResumeUrl,
} from "@/app/(app)/matches-actions";
import { AddUrlDialog } from "./add-url-dialog";
import type { TriageRow } from "@/app/(app)/page";
import type { TickWrite } from "@/lib/convex";

type Filter = "all" | "applied" | "saved" | "resumes" | "hidden";

const TERM_ORDER = ["Fall 2026", "Spring 2027", "Summer 2027"];
const UNKNOWN_TERM = "Unknown term";

const FLUSH_IDLE = 500;
const FLUSH_CAP = 50;
const BURST_MS = 6000;
const SWIPE_THRESHOLD = 70;
const HIDE_MS = 340; // collapse duration + a frame; dismiss commits after this
const CASCADE_CAP = 12; // rows past this share the final delay
const BUILD_POLL_MS = 15000;
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

type BuildState = "idle" | "building" | "built" | "failed";
type InFlight = "building" | { failed: string };

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "matches" },
  { key: "applied", label: "applied" },
  { key: "saved", label: "saved" },
  { key: "resumes", label: "resumes" },
  { key: "hidden", label: "hidden" },
];

/* A user-action flash: which element should replay its pop animation.
   `n` increments per flash; its parity alternates the A/B keyframe name so
   the same element can restart the animation on consecutive triggers. */
type FlashState = { key: string; n: number };

const popAnim = (n: number) =>
  `${n % 2 ? "tickpopB" : "tickpopA"} .32s var(--ease-pop)`;
const pressAnim = (n: number) =>
  `${n % 2 ? "keypressB" : "keypressA"} .36s var(--ease-pop)`;

function cascadeStyle(i: number): CSSProperties {
  return {
    animation: "cascade .5s var(--ease-out-soft) both",
    animationDelay: `${Math.min(i, CASCADE_CAP) * 70}ms`,
  };
}

function fmtDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function visibleRows(rows: TriageRow[], filter: Filter, query: string): TriageRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (filter === "hidden") {
      if (!r.dismissed) return false;
    } else if (r.dismissed) {
      return false;
    }
    if (filter === "applied" && !r.applied) return false;
    if (filter === "saved" && !r.saved) return false;
    if (filter === "resumes" && !r.resumeUrl) return false;
    if (q) {
      const hay = `${r.company} ${r.title} ${r.location}`.toLowerCase();
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
    arr.sort(
      (a, b) =>
        (b.added || "").localeCompare(a.added || "") ||
        a.company.localeCompare(b.company)
    );
  }
  const order = [
    ...TERM_ORDER.filter((t) => groups.has(t)),
    ...[...groups.keys()]
      .filter((t) => !TERM_ORDER.includes(t) && t !== UNKNOWN_TERM)
      .sort(),
    ...(groups.has(UNKNOWN_TERM) ? [UNKNOWN_TERM] : []),
  ];
  return order.map((t) => ({ term: t, rows: groups.get(t)! }));
}

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState<boolean>(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 699px)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 699px)");
    const onChange = (e: MediaQueryListEvent) => setMobile(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return mobile;
}

/* 1g — collapse shell. `open=false` collapses the row (grid-template-rows
   0fr + fade); `enter` mounts closed and opens on the next frame (restore /
   undo reverse animation). Class `collapse-shell` drives the first-child
   border/padding rules in globals.css. */
function CollapseShell({
  open,
  enter = false,
  children,
}: {
  open: boolean;
  enter?: boolean;
  children: React.ReactNode;
}) {
  const [ready, setReady] = useState(!enter);
  useEffect(() => {
    if (!ready) {
      const id = requestAnimationFrame(() => setReady(true));
      return () => cancelAnimationFrame(id);
    }
  }, [ready]);
  const expanded = open && ready;
  return (
    <div
      className="collapse-shell"
      style={{
        display: "grid",
        gridTemplateRows: expanded ? "1fr" : "0fr",
        transition: "grid-template-rows .32s var(--ease-out-soft)",
      }}
    >
      <div
        style={{
          overflow: "hidden",
          minHeight: 0,
          opacity: expanded ? 1 : 0,
          transition: "opacity .25s",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function Tags({ tag }: { tag: string }) {
  if (!tag) return null;
  const raw = tag.replace(/[\[\]*]/g, "").toLowerCase();
  const cls = raw.includes("top")
    ? "border border-[color-mix(in_srgb,var(--color-accent)_38%,transparent)] text-accent"
    : raw.includes("gone")
      ? "bg-[color-mix(in_srgb,var(--color-amber)_13%,transparent)] text-amber"
      : "bg-chip text-ink-2";
  return (
    <span
      title={tag}
      className={cn(
        "ml-1.5 inline-block rounded-full px-1.5 py-[1px] align-[2px] text-[10.5px] font-medium leading-none",
        cls
      )}
    >
      {raw}
    </span>
  );
}

function Divider({ className }: { className?: string }) {
  return <span className={cn("h-5 w-px self-center bg-line", className)} />;
}

export function Triage({ rows: initialRows }: { rows: TriageRow[] }) {
  const [rows, setRows] = useState<TriageRow[]>(initialRows);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [burst, setBurst] = useState<{ visible: boolean; count: number }>({
    visible: false,
    count: 0,
  });

  // Motion state -----------------------------------------------------------
  // 1b: bumping `epoch` remounts the list container, replaying the cascade.
  const [epoch, setEpoch] = useState(0);
  // 1a: which tick just got toggled ON ("<short>:a" | "<short>:s").
  const [tickFlash, setTickFlash] = useState<FlashState>({ key: "", n: 0 });
  // 1d: which dock action just fired.
  const [pressed, setPressed] = useState<FlashState>({ key: "", n: 0 });
  // 1g: rows mid-collapse (still rendered, dismiss not yet committed) and
  // rows that should enter with the reverse animation.
  const [hiding, setHiding] = useState<ReadonlySet<string>>(new Set());
  const [entering, setEntering] = useState<ReadonlySet<string>>(new Set());

  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const pendingDismiss = useRef<Map<string, boolean>>(new Map());
  const flushTimer = useRef<number | null>(null);
  const flushBusy = useRef(false);
  const burstShorts = useRef<Set<string>>(new Set());
  const burstTimer = useRef<number | null>(null);
  const hideTimers = useRef<Map<string, number>>(new Map());

  const isMobile = useIsMobile();

  // Per-row resume build state (Convex-native)
  const [builds, setBuilds] = useState<Record<string, InFlight>>({});
  const buildStartedAt = useRef<Record<string, number>>({});
  const buildStateFor = useCallback(
    (row: TriageRow): BuildState => {
      if (row.resumeUrl) return "built";
      const s = builds[row.short];
      if (s === "building") return "building";
      if (typeof s === "object" && s?.failed !== undefined) return "failed";
      return "idle";
    },
    [builds]
  );
  const buildErrorFor = useCallback(
    (row: TriageRow): string | undefined => {
      const s = builds[row.short];
      return typeof s === "object" && s?.failed !== undefined ? s.failed : undefined;
    },
    [builds]
  );

  const updateRow = useCallback((short: string, patch: Partial<TriageRow>) => {
    setRows((prev) =>
      prev.map((r) => (r.short === short ? { ...r, ...patch } : r))
    );
  }, []);

  const visible = useMemo(
    () => visibleRows(rows, filter, query),
    [rows, filter, query]
  );
  const groups = useMemo(() => groupByTerm(visible), [visible]);
  const ordered = useMemo(() => groups.flatMap((g) => g.rows), [groups]);

  const stats = useMemo(() => {
    const active = rows.filter((r) => !r.dismissed);
    return {
      matches: active.length,
      applied: active.filter((r) => r.applied).length,
      saved: active.filter((r) => r.saved).length,
      resumes: active.filter((r) => r.resumeUrl).length,
      hidden: rows.length - active.length,
    };
  }, [rows]);

  const cursorIndex = cursor ? ordered.findIndex((r) => r.short === cursor) : -1;
  const currentRow = cursorIndex >= 0 ? ordered[cursorIndex] : null;

  useEffect(() => {
    if (!cursor) return;
    const el = rootRef.current?.querySelector?.('[data-cursor="1"]');
    el?.scrollIntoView?.({ block: "nearest" });
  }, [cursor]);

  // 1b: replay the cascade when the filter changes or the search settles
  // (150ms after the last keystroke). Never on tick/hide mutations.
  const skipFirstEpoch = useRef(true);
  useEffect(() => {
    if (skipFirstEpoch.current) {
      skipFirstEpoch.current = false;
      return;
    }
    const id = window.setTimeout(() => setEpoch((e) => e + 1), 150);
    return () => window.clearTimeout(id);
  }, [filter, query]);

  function flashDock(key: string) {
    setPressed((p) => ({ key, n: p.n + 1 }));
  }
  function flashTick(short: string, field: "a" | "s") {
    setTickFlash((p) => ({ key: `${short}:${field}`, n: p.n + 1 }));
  }
  function markEntering(shorts: string[]) {
    setEntering(new Set(shorts));
    window.setTimeout(() => setEntering(new Set()), 400);
  }

  function sealBurst() {
    if (burstTimer.current) {
      window.clearTimeout(burstTimer.current);
      burstTimer.current = null;
    }
    burstShorts.current.clear();
    setBurst({ visible: false, count: 0 });
  }

  function undoBurst() {
    if (!burstShorts.current.size) return;
    const shorts = [...burstShorts.current];
    let needsFlush = false;
    for (const s of shorts) {
      // A row still mid-collapse hasn't been dismissed yet - just cancel it.
      const t = hideTimers.current.get(s);
      if (t) {
        window.clearTimeout(t);
        hideTimers.current.delete(s);
      }
      const v = pendingDismiss.current.get(s);
      if (v === true) pendingDismiss.current.delete(s);
      else if (v === false) {
        // restore already queued - leave it
      } else if (!t) {
        pendingDismiss.current.set(s, false);
        needsFlush = true;
      }
      updateRow(s, { dismissed: false });
    }
    setHiding((prev) => {
      const next = new Set(prev);
      for (const s of shorts) next.delete(s);
      return next;
    });
    markEntering(shorts); // reverse animation for rows re-entering the list
    sealBurst();
    if (needsFlush) scheduleFlush();
  }

  async function flush() {
    if (flushTimer.current) {
      window.clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    const queue = pendingDismiss.current;
    if (!queue.size || flushBusy.current) return;
    const writes: TickWrite[] = [];
    for (const [short, value] of queue) {
      writes.push({ short, field: "dismissed", value });
    }
    flushBusy.current = true;
    try {
      await writeTicks(writes);
      for (const w of writes) {
        if (queue.get(w.short) === w.value) queue.delete(w.short);
      }
    } catch {
      for (const w of writes) {
        if (queue.get(w.short) === w.value) queue.delete(w.short);
        updateRow(w.short, { dismissed: !w.value });
      }
      toast.error("Couldn't sync hides - reverted.");
    } finally {
      flushBusy.current = false;
      if (queue.size) scheduleFlush();
    }
  }

  function scheduleFlush() {
    const queue = pendingDismiss.current;
    if (!queue.size || flushBusy.current) return;
    if (queue.size >= FLUSH_CAP) {
      if (flushTimer.current) window.clearTimeout(flushTimer.current);
      flushTimer.current = null;
      void flush();
      return;
    }
    if (flushTimer.current) window.clearTimeout(flushTimer.current);
    flushTimer.current = window.setTimeout(() => {
      flushTimer.current = null;
      void flush();
    }, FLUSH_IDLE);
  }

  function queueDismiss(short: string, dismissed: boolean) {
    const queue = pendingDismiss.current;
    if (queue.get(short) === dismissed) return;
    queue.set(short, dismissed);
    updateRow(short, { dismissed });
    scheduleFlush();
  }

  /* 1g: hide = collapse first, commit after. Burst bookkeeping (slab count,
     seal timer) starts immediately so the slab reads "Hidden N" in real time,
     but the row stays rendered (collapsing) until HIDE_MS elapses. */
  function hideShort(short: string) {
    if (hiding.has(short)) return;
    const i = ordered.findIndex((r) => r.short === short);
    const next = ordered[i + 1] || ordered[i - 1];
    setCursor(next ? next.short : null);

    setHiding((prev) => new Set(prev).add(short));
    burstShorts.current.add(short);
    setBurst({ visible: true, count: burstShorts.current.size });
    if (burstTimer.current) window.clearTimeout(burstTimer.current);
    burstTimer.current = window.setTimeout(sealBurst, BURST_MS);

    const t = window.setTimeout(() => {
      hideTimers.current.delete(short);
      setHiding((prev) => {
        const next2 = new Set(prev);
        next2.delete(short);
        return next2;
      });
      queueDismiss(short, true);
    }, HIDE_MS);
    hideTimers.current.set(short, t);
  }

  function restoreShort(short: string) {
    queueDismiss(short, false);
    markEntering([short]);
  }

  function toggleApplied(short: string) {
    const r = rows.find((x) => x.short === short);
    if (!r) return;
    const value = !r.applied;
    if (value) flashTick(short, "a"); // 1a: pop + checkdraw only on toggle-ON
    updateRow(short, { applied: value });
    void writeTicks([{ short, field: "applied", value }]).catch(() => {
      updateRow(short, { applied: r.applied });
      toast.error("Couldn't sync applied state.");
    });
  }

  function toggleSaved(short: string) {
    const r = rows.find((x) => x.short === short);
    if (!r) return;
    const value = !r.saved;
    if (value) flashTick(short, "s");
    updateRow(short, { saved: value });
    void writeTicks([{ short, field: "saved", value }]).catch(() => {
      updateRow(short, { saved: r.saved });
      toast.error("Couldn't sync saved state.");
    });
  }
  function startBuild(short: string) {
    const row = rows.find((x) => x.short === short);
    if (!row || row.resumeUrl) return;
    if (builds[short] === "building") return;
    delete buildStartedAt.current[short];
    setBuilds((prev) => ({ ...prev, [short]: "building" as const }));
    void requestResumeBuild(short).then((res) => {
      if (res.ok) return;
      setBuilds((prev) => ({ ...prev, [short]: { failed: res.error || "Couldn't start the resume build." } }));
      toast.error(res.error || "Couldn't start the resume build.");
    });
  }
  function dockBuild() {
    if (!currentRow) return;
    if (currentRow.resumeUrl) {
      window.open(currentRow.resumeUrl, "_blank", "noopener");
      return;
    }
    startBuild(currentRow.short);
  }
  // Polling for Convex resume builds
  useEffect(() => {
    const building = Object.entries(builds)
      .filter(([, s]) => s === "building")
      .map(([k]) => k);
    if (!building.length) return;
    const timer = window.setInterval(() => {
      for (const s of [...building]) {
        if (buildStartedAt.current[s] === undefined) buildStartedAt.current[s] = Date.now();
        if (Date.now() - buildStartedAt.current[s] > BUILD_TIMEOUT_MS) {
          setBuilds((prev) => (prev[s] === "building" ? { ...prev, [s]: { failed: "Build timed out after 15 minutes." } } : prev));
          continue;
        }
        void (async () => {
          let status;
          try {
            status = await fetchBuildStatus(s);
          } catch {
            return;
          }
          if (status === "building") return;
          if (status && typeof status === "object" && status.status === "failed") {
            setBuilds((prev) => (prev[s] === "building" ? { ...prev, [s]: { failed: status.error || "Build failed." } } : prev));
            return;
          }
          let url: string | null = null;
          try {
            url = await fetchResumeUrl(s);
          } catch {
            return;
          }
          if (!url) return;
          updateRow(s, { resumeUrl: url });
          setBuilds((prev) => {
            const next = { ...prev };
            delete next[s];
            return next;
          });
        })();
      }
    }, BUILD_POLL_MS);
    return () => window.clearInterval(timer);
  }, [builds, updateRow]);

  function move(delta: number) {
    if (!ordered.length) return;
    let i = cursorIndex;
    if (i < 0) {
      i = delta > 0 ? 0 : ordered.length - 1;
    } else {
      i = Math.max(0, Math.min(ordered.length - 1, i + delta));
    }
    setCursor(ordered[i].short);
  }

  function openRow(row?: TriageRow) {
    const r = row ?? currentRow;
    if (r?.url) window.open(r.url, "_blank", "noopener");
  }

  function actOnCurrent(kind: "applied" | "saved" | "hide") {
    if (!currentRow) return;
    if (kind === "applied") {
      toggleApplied(currentRow.short);
    } else if (kind === "saved") {
      toggleSaved(currentRow.short);
      move(1);
    } else {
      hideShort(currentRow.short);
    }
  }

  const keyboardActions = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    keyboardActions.current = (e: KeyboardEvent) => {
      const k = e.key;
      if (k === "Escape") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      const kl = k.toLowerCase();
      if (isInput) {
        if (kl === "z" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          undoBurst();
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey || e.altKey) && !(kl === "z")) return;
      if (kl === "j" || k === "ArrowDown") {
        e.preventDefault();
        flashDock("down");
        move(1);
      } else if (kl === "k" || k === "ArrowUp") {
        e.preventDefault();
        flashDock("up");
        move(-1);
      } else if (k === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (kl === "x") {
        e.preventDefault();
        flashDock("applied");
        actOnCurrent("applied");
      } else if (kl === "s") {
        e.preventDefault();
        flashDock("saved");
        actOnCurrent("saved");
      } else if (kl === "h") {
        e.preventDefault();
        flashDock("hide");
        actOnCurrent("hide");
      } else if (kl === "u") {
        e.preventDefault();
        undoBurst();
      } else if (kl === "z" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        undoBurst();
      } else if (kl === "b") {
        e.preventDefault();
        flashDock("build");
        dockBuild();
      } else if (k === "Enter") {
        e.preventDefault();
        flashDock("open");
        openRow();
      }
    };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyboardActions.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const hasAnyRows = rows.length > 0;
  const emptyFilter = hasAnyRows && groups.length === 0;

  // Flat render index per row for the cascade stagger.
  let flatIndex = 0;

  return (
    <div
      ref={rootRef}
      className="mx-auto w-full max-w-[1060px] px-5 py-5 pb-32"
    >
      {/* statline */}
      <div className="mb-3 text-[13px] text-ink-2 tabular-nums">
        {FILTERS.map((s, i) => {
          const n =
            s.key === "all"
              ? stats.matches
              : s.key === "applied"
                ? stats.applied
                : s.key === "saved"
                  ? stats.saved
                  : s.key === "resumes"
                    ? stats.resumes
                    : stats.hidden;
          const active = filter === s.key;
          return (
            <span key={s.key}>
              {i > 0 && <span className="mx-1">·</span>}
              <button
                type="button"
                onClick={() => setFilter((f) => (f === s.key ? "all" : s.key))}
                className={cn(
                  "cursor-pointer rounded-sm px-0.5 transition-colors",
                  active
                    ? "text-accent underline decoration-dashed underline-offset-[3px]"
                    : "hover:text-accent hover:underline hover:decoration-dashed hover:underline-offset-[3px]"
                )}
              >
                <b className="font-semibold text-ink">{n}</b>{" "}
                <span className="text-ink-2">{s.label}</span>
              </button>
            </span>
          );
        })}
      </div>

      {/* toolbar */}
      <div className="mb-4 flex items-center gap-2">
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search company, title, location…"
          autoComplete="off"
          aria-label="Search matches"
          className="flex-1 rounded-[5px] border border-line-2 bg-surface px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-2/70 focus:border-accent focus:outline-none"
        />
        <AddUrlDialog />
      </div>

      {!hasAnyRows ? (
        <div className="rounded-md border border-line bg-surface"><div className="px-4 py-8 text-center"><p className="text-[14px] font-medium text-ink">No matches yet.</p><p className="mt-1 text-[13px] text-ink-2">Matches will land here as the watcher finds them — or add a job URL manually.</p><div className="mt-4 flex justify-center"><AddUrlDialog /></div></div></div>
      ) : emptyFilter ? (
        <div className="rounded-md border border-line bg-surface">
          <div className="px-4 py-7 text-center text-[13px] text-ink-2">
            Nothing matches the current filters.
            <button
              type="button"
              onClick={() => {
                setFilter("all");
                setQuery("");
              }}
              className="ml-2 font-medium text-accent underline decoration-dashed underline-offset-2"
            >
              clear filters
            </button>
          </div>
        </div>
      ) : (
        /* 1b: key={epoch} remounts the whole list so the cascade replays */
        <div key={epoch}>
          {groups.map((g) => {
            const headerIndex = flatIndex;
            return (
              <section key={g.term} className="mb-5 last:mb-0">
                <h2
                  className="mb-1.5 flex items-baseline gap-1.5 text-[11.5px] font-semibold tracking-[0.09em] text-ink-2 uppercase"
                  style={{
                    ...cascadeStyle(headerIndex),
                    animationDelay: `${Math.max(0, Math.min(headerIndex, CASCADE_CAP) * 70 - 40)}ms`,
                  }}
                >
                  {g.term}
                  <span className="font-normal not-italic tracking-normal normal-case text-ink-2/80">
                    · {g.rows.length}
                  </span>
                </h2>
                {isMobile ? (
                  <div>
                    {g.rows.map((r) => {
                      const i = flatIndex++;
                      return (
                        <CollapseShell
                          key={r.short}
                          open={!hiding.has(r.short)}
                          enter={entering.has(r.short)}
                        >
                          <div data-card-pad className="pt-2">
                            <MobileCard
                              row={r}
                              cascade={cascadeStyle(i)}
                              isCursor={r.short === cursor}
                              onSelect={() => setCursor(r.short)}
                              onOpen={() => openRow(r)}
                              onToggleApplied={() => toggleApplied(r.short)}
                              onToggleSaved={() => toggleSaved(r.short)}
                              onHide={() => hideShort(r.short)}
                              onRestore={() => restoreShort(r.short)}
                              buildState={buildStateFor(r)}
                              buildError={buildErrorFor(r)}
                              onBuild={() => startBuild(r.short)}
                            />
                          </div>
                        </CollapseShell>
                      );
                    })}
                  </div>
                ) : (
                  <DesktopGroup cursor={cursor} rows={g.rows}>
                    {g.rows.map((r) => {
                      const i = flatIndex++;
                      return (
                        <CollapseShell
                          key={r.short}
                          open={!hiding.has(r.short)}
                          enter={entering.has(r.short)}
                        >
                          <RowView
                            row={r}
                            cascade={cascadeStyle(i)}
                            isCursor={r.short === cursor}
                            appliedFlash={
                              tickFlash.key === `${r.short}:a` ? tickFlash.n : null
                            }
                            savedFlash={
                              tickFlash.key === `${r.short}:s` ? tickFlash.n : null
                            }
                            buildState={buildStateFor(r)}
                            buildError={buildErrorFor(r)}
                            onSelect={() => setCursor(r.short)}
                            onToggleApplied={() => toggleApplied(r.short)}
                            onToggleSaved={() => toggleSaved(r.short)}
                            onHide={() => hideShort(r.short)}
                            onRestore={() => restoreShort(r.short)}
                            onBuild={() => startBuild(r.short)}
                          />
                        </CollapseShell>
                      );
                    })}
                  </DesktopGroup>
                )}
              </section>
            );
          })}
        </div>
      )}

      <Dock
        pressed={pressed}
        onNav={(d) => {
          flashDock(d > 0 ? "down" : "up");
          move(d);
        }}
        onAct={(kind) => {
          flashDock(kind);
          actOnCurrent(kind);
        }}
        onOpen={() => {
          flashDock("open");
          openRow();
        }}
        onBuild={() => {
          flashDock("build");
          dockBuild();
        }}
        buildState={currentRow ? buildStateFor(currentRow) : "idle"}
      />

      {burst.visible && (
        <div
          className="fixed right-4 bottom-[76px] z-[60] flex items-center gap-3 rounded-md bg-ink px-3.5 py-2.5 text-[13px] text-bg shadow-[0_4px_16px_color-mix(in_srgb,var(--color-ink)_22%,transparent)]"
          style={{ animation: "toastin .22s var(--ease-out-soft) both" }}
        >
          <span>
            Hidden{" "}
            {/* count pulses on each increment (keyed remount restarts it) */}
            <span
              key={burst.count}
              className="inline-block font-semibold tabular-nums"
              style={{ animation: popAnim(burst.count) }}
            >
              {burst.count}
            </span>
          </span>
          <button
            type="button"
            onClick={undoBurst}
            className="cursor-pointer font-medium text-amber"
          >
            Undo
          </button>
        </div>
      )}
    </div>
  );
}

/* 1a — desktop term-group container owning the sliding rail + wash. Measures
   the cursor row ([data-cursor="1"]) inside itself; when the cursor is in
   another group the rail fades out (each group has its own). */
function DesktopGroup({
  cursor,
  rows,
  children,
}: {
  cursor: string | null;
  rows: TriageRow[];
  children: React.ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [rail, setRail] = useState<{ y: number; h: number } | null>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const el = box.querySelector<HTMLElement>('[data-cursor="1"]');
    if (el) setRail({ y: el.offsetTop, h: el.offsetHeight });
    else setRail(null);
  }, [cursor, rows]);

  const railStyle: CSSProperties = {
    transform: `translateY(${rail ? rail.y : 0}px)`,
    height: rail ? `${rail.h}px` : 0,
    opacity: rail ? 1 : 0,
    transition:
      "transform .26s var(--ease-spring), height .26s var(--ease-spring), opacity .15s",
    pointerEvents: "none",
  };

  return (
    <div
      ref={boxRef}
      className="relative overflow-hidden rounded-md border border-line bg-surface"
    >
      {/* wash behind the rows (rows have no background of their own) */}
      <span
        aria-hidden
        className="absolute left-0 top-0 w-full bg-[color-mix(in_srgb,var(--color-accent)_4%,transparent)]"
        style={railStyle}
      />
      {/* the rail */}
      <span
        aria-hidden
        className="absolute left-0 top-0 z-10 w-[3px] rounded-r-[2px] bg-accent"
        style={railStyle}
      />
      {children}
    </div>
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="rounded-md border border-line bg-surface">
      <div className="px-4 py-20 text-center">
        <div className="text-[13.5px] font-medium text-ink">{title}</div>
        <p className="mt-1 text-[12.5px] text-ink-2">{hint}</p>
      </div>
    </div>
  );
}

function ResumeButton({
  state,
  href,
  onBuild,
  error,
}: {
  state: BuildState;
  href: string | null;
  onBuild: () => void;
  error?: string;
}) {
  const base =
    "inline-flex min-w-[98px] items-center justify-center gap-1.5 rounded-[5px] border px-2 py-[5px] text-[12px] font-medium whitespace-nowrap transition-colors select-none";
  if (state === "built") {
    return (
      <a
        data-open
        href={href ?? "#"}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className={cn(
          base,
          "border-[color-mix(in_srgb,var(--color-accent)_42%,transparent)] bg-surface text-accent hover:border-ink-2"
        )}
      >
        <FileText className="size-3.5" /> resume
      </a>
    );
  }
  if (state === "building") {
    return (
      <button
        type="button"
        disabled
        aria-busy="true"
        className={cn(base, "cursor-default border-line-2 bg-surface text-ink-2")}
      >
        <Loader2 className="size-3.5 animate-spin" /> building…
      </button>
    );
  }
  if (state === "failed") {
    return (
      <button
        type="button"
        title={error}
        onClick={(e) => {
          e.stopPropagation();
          onBuild();
        }}
        className={cn(
          base,
          "cursor-pointer border-[color-mix(in_srgb,var(--color-red)_42%,transparent)] bg-surface text-red hover:border-ink-2"
        )}
      >
        retry build
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onBuild();
      }}
      className={cn(
        base,
        "cursor-pointer border-[color-mix(in_srgb,var(--color-accent)_42%,transparent)] bg-surface text-accent hover:border-ink-2"
      )}
    >
      <FileText className="size-3.5" /> build resume
    </button>
  );
}

function RowView({
  row,
  cascade,
  isCursor,
  appliedFlash,
  savedFlash,
  buildState,
  buildError,
  onSelect,
  onToggleApplied,
  onToggleSaved,
  onHide,
  onRestore,
  onBuild,
}: {
  row: TriageRow;
  cascade: CSSProperties;
  isCursor: boolean;
  appliedFlash: number | null;
  savedFlash: number | null;
  buildState: BuildState;
  buildError?: string;
  onSelect: () => void;
  onToggleApplied: () => void;
  onToggleSaved: () => void;
  onHide: () => void;
  onRestore: () => void;
  onBuild: () => void;
}) {
  const { short, company, title, location, salary, added, applied, saved, dismissed } = row;
  return (
    <div
      data-cursor={isCursor ? "1" : undefined}
      data-row-line
      onClick={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest("[data-applied-tick]")) return;
        if (t.closest("[data-saved-tick]")) return;
        if (t.closest("[data-hide]")) return;
        if (t.closest("[data-restore]")) return;
        if (t.closest("[data-open]")) return;
        onSelect();
      }}
      style={cascade}
      /* cursor bg/inset-shadow classes removed - DesktopGroup's rail + wash
         layers replace them */
      className="grid cursor-default grid-cols-[46px_minmax(0,1fr)_auto] items-start gap-x-3 border-t border-line px-3 py-2.5 transition-colors select-none"
    >
      {/* ticks */}
      <div className="flex gap-1.5 pt-0.5">
        <button
          type="button"
          data-applied-tick
          aria-label={applied ? "Mark as not applied" : "Mark as applied"}
          aria-pressed={applied}
          onClick={onToggleApplied}
          style={
            appliedFlash !== null
              ? { animation: popAnim(appliedFlash) }
              : undefined
          }
          className={cn(
            "flex h-[17px] w-[17px] items-center justify-center rounded-[5px] border-[1.5px] transition-all active:scale-90",
            applied
              ? "border-accent bg-accent text-accent-ink"
              : "border-line-2 bg-surface text-transparent hover:border-ink-2 hover:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_14%,transparent)]"
          )}
        >
          {/* inline check path (replaces <Check/>) so the stroke can draw */}
          <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden>
            <path
              d="M3 8.5 L6.5 12 L13 4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="3.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray="20"
              style={
                applied
                  ? appliedFlash !== null
                    ? {
                        strokeDashoffset: 0,
                        animation: "checkdraw .3s ease .05s both",
                      }
                    : { strokeDashoffset: 0 } // ticked at load: static, no draw
                  : { strokeDashoffset: 20 }
              }
            />
          </svg>
        </button>
        <button
          type="button"
          data-saved-tick
          aria-label={saved ? "Unsave" : "Save"}
          aria-pressed={saved}
          onClick={onToggleSaved}
          style={
            savedFlash !== null ? { animation: popAnim(savedFlash) } : undefined
          }
          className={cn(
            "flex h-[17px] w-[17px] items-center justify-center rounded-[5px] border-[1.5px] transition-all active:scale-90",
            saved
              ? "border-amber bg-[color-mix(in_srgb,var(--color-amber)_16%,var(--color-surface))] text-amber"
              : "border-line-2 bg-surface text-transparent hover:border-ink-2 hover:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_14%,transparent)]"
          )}
        >
          <Star className="size-3" strokeWidth={2} fill={saved ? "currentColor" : "none"} />
        </button>
      </div>

      {/* company / title / meta - applied dim now transitions */}
      <div className="min-w-0">
        <span
          className={cn(
            "text-[13.5px] font-semibold transition-opacity duration-[250ms]",
            applied && "opacity-55"
          )}
        >
          {company}
        </span>
        <Tags tag={row.tag} />
        <div
          className={cn(
            "truncate text-[12.5px] text-ink-2 transition-opacity duration-[250ms]",
            applied && "opacity-55"
          )}
          title={title}
        >
          {title}
        </div>
        <div className="mt-0.5 text-[11.5px] text-ink-2 tabular-nums">
          {location}
          {salary ? ` · ${salary}` : ""} · seen {fmtDate(added)} ·{" "}
          <span className="font-mono text-[10.5px]">{short}</span>
        </div>
      </div>

      {/* actions — resume docker */}
      <div className="flex items-center gap-1.5 self-center">
        <ResumeButton state={buildState} href={row.resumeUrl} onBuild={onBuild} error={buildError} />
        {dismissed ? (
          <button
            type="button"
            data-restore
            title="restore to the matches list"
            onClick={onRestore}
            className="flex h-[26px] w-[26px] items-center justify-center rounded-[5px] text-ink-2 transition-colors hover:bg-[color-mix(in_srgb,var(--color-amber)_12%,transparent)] hover:text-amber"
          >
            <Undo2 className="size-3.5" />
          </button>
        ) : (
          <button
            type="button"
            data-hide
            title="hide - moves to Hidden"
            onClick={onHide}
            className="flex h-[26px] w-[26px] items-center justify-center rounded-[5px] text-ink-2 transition-colors hover:bg-[color-mix(in_srgb,var(--color-red)_12%,transparent)] hover:text-red"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function MobileCard({
  row,
  cascade,
  isCursor,
  onSelect,
  onOpen,
  onToggleApplied,
  onToggleSaved,
  onHide,
  onRestore,
  buildState,
  buildError,
  onBuild,
}: {
  row: TriageRow;
  cascade: CSSProperties;
  isCursor: boolean;
  onSelect: () => void;
  onOpen: () => void;
  onToggleApplied: () => void;
  onToggleSaved: () => void;
  onHide: () => void;
  onRestore: () => void;
  buildState: BuildState;
  buildError?: string;
  onBuild: () => void;
}) {
  const [drag, setDrag] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [dragged, setDragged] = useState(false);
  const startX = useRef<number | null>(null);

  const dir = drag <= -SWIPE_THRESHOLD ? "hide" : drag >= SWIPE_THRESHOLD ? "save" : null;
  const tintVisible = Math.abs(drag) > 24;

  function onTouchStart(e: ReactTouchEvent) {
    startX.current = e.touches[0].clientX;
    setDragged(false);
    setDrag(0);
  }
  function onTouchMove(e: ReactTouchEvent) {
    if (startX.current == null) return;
    const dx = e.touches[0].clientX - startX.current;
    if (Math.abs(dx) > 8) setDragged(true);
    setDrag(dx);
  }
  function onTouchEnd() {
    startX.current = null;
    if (drag <= -SWIPE_THRESHOLD) onHide();
    else if (drag >= SWIPE_THRESHOLD) onToggleSaved();
    else setDrag(0);
  }
  function onTap() {
    if (dragged) {
      setDragged(false);
      return;
    }
    onSelect();
    setExpanded((v) => !v);
  }

  const { applied, saved, dismissed } = row;
  return (
    <div
      data-cursor={isCursor ? "1" : undefined}
      style={cascade}
      className={cn(
        "relative overflow-hidden rounded-lg border bg-surface transition-shadow",
        isCursor ? "border-accent/60" : "border-line"
      )}
    >
      {/* swipe feedback layer */}
      <div
        className={cn(
          "absolute inset-0 flex items-center",
          dir === "hide" && "justify-end pr-4",
          dir === "save" && "justify-start pl-4"
        )}
        style={{
          background:
            dir === "hide"
              ? "color-mix(in srgb, var(--color-red) 12%, transparent)"
              : dir === "save"
                ? "color-mix(in srgb, var(--color-amber) 14%, transparent)"
                : "transparent",
          opacity: tintVisible ? 1 : 0,
        }}
      >
        {dir === "hide" && <X className="size-5 text-red" />}
        {dir === "save" && <Star className="size-5 text-amber" fill="currentColor" />}
      </div>

      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClick={onTap}
        className={cn(
          "relative bg-surface",
          !dragged && drag === 0 && "transition-transform duration-200"
        )}
        style={{ transform: `translateX(${drag}px)` }}
      >
        <div className="flex items-start gap-2.5 px-3 py-2.5">
          <button
            type="button"
            aria-label={applied ? "Mark as not applied" : "Mark as applied"}
            aria-pressed={applied}
            onClick={(e) => {
              e.stopPropagation();
              onToggleApplied();
            }}
            className={cn(
              "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-[1.5px] transition-colors",
              applied ? "border-accent bg-accent text-accent-ink" : "border-line-2 text-transparent"
            )}
          >
            <Check className="size-3.5" strokeWidth={3.5} />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1">
              <span
                className={cn(
                  "truncate text-[13px] font-semibold transition-opacity duration-[250ms]",
                  applied && "opacity-55"
                )}
              >
                {row.company}
              </span>
              <Tags tag={row.tag} />
            </div>
            <div
              className={cn(
                "mt-0.5 line-clamp-2 text-[12px] text-ink-2 transition-opacity duration-[250ms]",
                applied && "opacity-55"
              )}
            >
              {row.title}
            </div>
            <div className="mt-1 truncate text-[11px] text-ink-2 tabular-nums">
              {row.location}
              {row.salary ? ` · ${row.salary}` : ""} · seen {fmtDate(row.added)}
            </div>
          </div>
          <button
            type="button"
            aria-label={expanded ? "Collapse actions" : "More actions"}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            className="mt-0.5 shrink-0 rounded px-1.5 py-1 text-[11px] text-ink-2 transition-colors hover:bg-chip"
          >
            {expanded ? "▾" : "⋯"}
          </button>
        </div>

        {/* expanded actions */}
        {expanded && (
          <div className="flex items-center gap-2 border-t border-line px-3 py-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleApplied();
                setExpanded(false);
              }}
              className={cn(
                "rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition-colors",
                applied
                  ? "border-accent bg-accent text-accent-ink"
                  : "border-line-2 bg-surface text-ink hover:border-ink-2"
              )}
            >
              Applied
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpen();
              }}
              className="rounded-md border border-line-2 bg-surface px-2.5 py-1.5 text-[12px] font-medium text-ink transition-colors hover:border-ink-2"
            >
              Open
            </button>
            <ResumeButton state={buildState} href={row.resumeUrl} onBuild={onBuild} error={buildError} />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleSaved();
                setExpanded(false);
              }}
              className={cn(
                "rounded-md border px-2.5 py-1.5 text-[12px] font-medium transition-colors",
                saved
                  ? "border-amber bg-[color-mix(in_srgb,var(--color-amber)_16%,var(--color-surface))] text-amber"
                  : "border-line-2 bg-surface text-ink hover:border-ink-2"
              )}
            >
              {saved ? "Saved" : "Save"}
            </button>
            {dismissed ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRestore();
                  setExpanded(false);
                }}
                className="ml-auto rounded-md border border-line-2 bg-surface px-2.5 py-1.5 text-[12px] font-medium text-amber transition-colors hover:border-ink-2"
              >
                Restore
              </button>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onHide();
                }}
                className="ml-auto rounded-md border border-line-2 bg-surface px-2.5 py-1.5 text-[12px] font-medium text-red transition-colors hover:border-ink-2"
              >
                Hide
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* 1d — glass dock: translucent surface + blur, entrance rise on mount, and a
   keycap press ripple on whichever action fired (click or shortcut). */
function Dock({
  pressed,
  onNav,
  onAct,
  onOpen,
  onBuild,
  buildState,
}: {
  pressed: FlashState;
  onNav: (d: number) => void;
  onAct: (kind: "applied" | "saved" | "hide") => void;
  onOpen: () => void;
  onBuild: () => void;
  buildState: BuildState;
}) {
  const kbd =
    "rounded border border-line-2 bg-surface px-1 py-px font-mono text-[10.5px] font-medium text-ink-2";
  const db =
    "inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-transparent bg-transparent px-2 py-1.5 text-[12.5px] font-medium text-ink transition-colors select-none active:translate-y-px hover:bg-chip hover:border-line-2";
  const label = "hidden min-[701px]:inline";
  const press = (act: string): CSSProperties | undefined =>
    pressed.key === act ? { animation: pressAnim(pressed.n) } : undefined;
  return (
    <div
      className="fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100vw-24px)] translate-x-[-50%] items-center gap-1 rounded-[11px] border border-line-2 px-1.5 py-1 shadow-[0_6px_24px_color-mix(in_srgb,var(--color-ink)_16%,transparent)] backdrop-blur-[8px]"
      style={{
        background:
          "color-mix(in srgb, var(--color-surface) 72%, transparent)",
        animation: "dockup .4s var(--ease-out-soft) .25s both",
      }}
      onClick={(e) => {
        const t = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
        if (!t) return;
        const act = t.dataset.act as
          | "up"
          | "down"
          | "applied"
          | "saved"
          | "hide"
          | "build"
          | "open"
          | undefined;
        if (act === "up" || act === "down") onNav(act === "up" ? -1 : 1);
        else if (act === "build") onBuild();
        else if (act === "open") onOpen();
        else if (act) onAct(act as "applied" | "saved" | "hide");
      }}
    >
      <button
        type="button"
        data-act="up"
        style={press("up")}
        className={cn(db, "text-ink-2 hover:border-amber hover:bg-[color-mix(in_srgb,var(--color-amber)_10%,transparent)]")}
      >
        <span className={cn(kbd, "group-hover:border-amber")}>k</span>
      </button>
      <button
        type="button"
        data-act="down"
        style={press("down")}
        className={cn(db, "text-ink-2 hover:border-amber hover:bg-[color-mix(in_srgb,var(--color-amber)_10%,transparent)]")}
      >
        <span className={kbd}>j</span>
      </button>
      <Divider />
      <button
        type="button"
        data-act="applied"
        style={press("applied")}
        className={cn(db, "text-accent hover:border-accent hover:bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]")}
      >
        <span className={kbd}>x</span> <span className={label}>applied</span>
      </button>
      <button
        type="button"
        data-act="saved"
        style={press("saved")}
        className={cn(db, "text-amber hover:border-amber hover:bg-[color-mix(in_srgb,var(--color-amber)_10%,transparent)]")}
      >
        <span className={kbd}>s</span> <span className={label}>save</span>
      </button>
      <button
        type="button"
        data-act="hide"
        style={press("hide")}
        className={cn(db, "text-red hover:border-red hover:bg-[color-mix(in_srgb,var(--color-red)_10%,transparent)]")}
      >
        <span className={kbd}>h</span> <span className={label}>hide</span>
      </button>
      <Divider />
      <button
        type="button"
        data-act="build"
        disabled={buildState === "building"}
        title={buildState === "built" ? "open resume" : "build resume"}
        style={press("build")}
        className={cn(db, "disabled:opacity-70")}
      >
        <span className={kbd}>b</span>{" "}
        {buildState === "building" ? (
          <Loader2 className="size-3.5 animate-spin text-ink-2" />
        ) : (
          <span className={label}>build resume</span>
        )}
      </button>
      <button type="button" data-act="open" style={press("open")} className={db}>
        <span className={kbd}>↵</span> <span className={label}>open</span>
      </button>
    </div>
  );
}
