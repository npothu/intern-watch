"use client";

// The matches triage surface. Data flow (writeTicks batching, burst undo
// semantics, filters, mobile swipe) is independent of the motion layer.
//
// Desktop (>= 700px) is one flat dense table (matches-table.tsx on the
// dense-table.tsx shell): status pills x term pills x search, a sortable
// header, and one row open at a time with its details panel. Phones keep
// the swipeable cards, grouped by term. Pure logic - filter counts, sort,
// term codes, the ?filter/?term/?sort/?open URL state - is matches-lib.ts.
//
//   cursor rail  one measured rail + wash over the table, sliding between
//                rows in 150ms so a held j/k never outruns it
//   ticks        the applied check draws its own stroke, both ticks pop -
//                only on a user toggle, never on mount or hydration
//   cascade      rows rise in on mount and when filtering adds new rows
//   dock         keycap press ring in the pressed action's own colour,
//                fired from clicks and keyboard shortcuts alike
//   hide         the row collapses first, and the dismiss commits after
//   details      the open row's panel expands on the same collapse shell
//
// Keyframes live in app/globals.css; the replayable one-shots in lib/motion.ts.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type TouchEvent as ReactTouchEvent,
} from "react";
import {
  Check,
  Star,
  X,
  FileText,
  Loader2,
  Ghost,
  LayoutList,
  ListChecks,
  Eraser,
  Search,
  Mail,
  AlertTriangle,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  useReplay,
  TICK_POP,
  TICK_POP_OPTS,
  keypressFrames,
  KEYPRESS_OPTS,
  prefersReducedMotion,
} from "@/lib/motion";
import {
  writeTicks,
  requestResumeBuild,
  requestResumeRebuild,
  requestResumeRestore,
  fetchBuildStatus,
  fetchResumeUrl,
  fetchResumeMeta,
} from "@/app/(app)/matches-actions";
import {
  CommandPalette,
  openCommandPalette,
  type PaletteAction,
} from "@/components/command-palette";
import { FilterPills, type PillOption } from "@/components/filter-pills";
import { RefreshControl } from "@/components/refresh-control";
import {
  ResumeReportDialog,
  type RebuildOpts,
} from "@/components/matches/resume-report";
import { AddUrlDialog } from "./add-url-dialog";
import { ResumeJdPrompt } from "./resume-jd-prompt";
import { useRouter } from "next/navigation";
import { useAppView } from "@/lib/view";
import { ViewSwitch } from "@/components/nav/view-switch";
import { ReferralLink } from "@/components/referrals/referral-link";
import type { TriageRow } from "@/app/(app)/page";
import { sortTerms, todayLocal } from "@/lib/terms";
import { isKnownTerm } from "@/lib/preferences";
import type { ResumeMeta, TickWrite } from "@/lib/convex";
import { MatchesTable, type BuildState, type MatchHandlers } from "./matches-table";
import {
  COLLAPSE_MS,
  CollapseShell,
  FOCUS_RING,
  blurOnPointerActivate,
} from "./row-primitives";
import {
  ALL_TERMS,
  DEFAULT_URL_STATE,
  STATUS_FILTERS,
  UNKNOWN_TERM,
  composeFilters,
  cycleSort,
  formatUrlState,
  isPrimaryTerm,
  orderTerms,
  sortLabel,
  sortRows,
  termFromSlug,
  termLabel,
  termOf,
  termShort,
  termSlug,
  type MatchesUrlState,
  type Sort,
  type StatusFilter,
} from "./matches-lib";

type Filter = StatusFilter;

/** Page scroll increment when j/k runs off the end of the list (item 5). */
const EDGE_SCROLL_PX = 180;

const FLUSH_IDLE = 500;
const FLUSH_CAP = 50;
const BURST_MS = 6000;
const SWIPE_THRESHOLD = 70;
const HIDE_MS = COLLAPSE_MS + 20; // ...then the dismiss commits
const CASCADE_STEP = 55; // per-row stagger
const SCROLL_MS = 180;
const CASCADE_CAP = 10; // rows past this share the final delay
const BUILD_POLL_MS = 15000;
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

type InFlight = "building" | { failed: string };

/* Which element should replay a one-shot animation, and how many times it has
   been asked to. `n` is the replay token handed to useReplay; `key` names the
   single element the flash belongs to, so every other element gets null and
   stays static. */
type FlashState = { key: string; n: number };

/** The replay token for `key`, or null when this element isn't the one. */
const tokenFor = (flash: FlashState, key: string) =>
  flash.key === key ? flash.n : null;

function cascadeStyle(i: number): CSSProperties {
  return {
    animation: "cascade .42s var(--ease-out-soft) both",
    animationDelay: `${Math.min(i, CASCADE_CAP) * CASCADE_STEP}ms`,
  };
}

function fmtDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The pinned group's key; never a real term, so it can't collide. */
const PRIORITY_GROUP = "__priority__";

type Group = { term: string; kind: "priority" | "term"; rows: TriageRow[] };

/**
 * Phones only (the desktop table is flat and sortable instead).
 * The pinned Priority group first (every priority row, across terms), then
 * one group per term for everything else, chronological, unknown last. A
 * priority row lives only in the pinned group, so nothing renders twice;
 * inside a term group the digest's tiers still apply (top before the rest).
 */
function groupRows(rows: TriageRow[]): Group[] {
  const priority = rows
    .filter((r) => r.priority)
    .sort(
      (a, b) =>
        (b.added || "").localeCompare(a.added || "") ||
        a.company.localeCompare(b.company)
    );
  const groups = new Map<string, TriageRow[]>();
  for (const r of rows) {
    if (r.priority) continue;
    const t = termOf(r);
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t)!.push(r);
  }
  for (const arr of groups.values()) {
    arr.sort(
      (a, b) =>
        tierOf(a) - tierOf(b) ||
        (b.added || "").localeCompare(a.added || "") ||
        a.company.localeCompare(b.company)
    );
  }
  const order = orderTerms(groups.keys());
  return [
    ...(priority.length ? [{ term: PRIORITY_GROUP, kind: "priority" as const, rows: priority }] : []),
    ...order.map((t) => ({ term: t, kind: "term" as const, rows: groups.get(t)! })),
  ];
}

/** 1 top company, 2 everything else - the digest's tiers below priority
 *  (priority rows sit in their own pinned group here). */
function tierOf(row: TriageRow): number {
  return /^\[TOP/.test(row.tag) ? 1 : 2;
}

const MOBILE_QUERY = "(max-width: 699px)";

function subscribeMobile(onChange: () => void): () => void {
  const mq = window.matchMedia(MOBILE_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/**
 * Phone width or not. The server always renders the desktop table, so
 * hydration uses the same answer (getServerSnapshot) and the cards swap in
 * right after - reading matchMedia during hydration instead made the two
 * trees disagree and React throw away the server HTML.
 */
function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribeMobile,
    () => window.matchMedia(MOBILE_QUERY).matches,
    () => false
  );
}

/**
 * The row's badge. Inside the pinned Priority group the priority badge is
 * implied by the box, so `pinnedTerm` swaps it for the row's term - the one
 * fact that group's rows no longer get from their heading.
 */
function Tags({
  tag,
  pinnedTerm,
  wantedTerms = null,
}: {
  tag: string;
  pinnedTerm?: string;
  wantedTerms?: string[] | null;
}) {
  if (pinnedTerm !== undefined) {
    // Same short code and colour rule as the desktop Term column.
    return (
      <span
        title={termLabel(pinnedTerm || UNKNOWN_TERM)}
        className={cn(
          "ml-1.5 inline-block rounded-full bg-chip px-1.5 py-[1px] align-[2px] font-mono text-[10.5px] font-medium leading-none",
          !pinnedTerm || isPrimaryTerm(pinnedTerm, wantedTerms) ? "text-ink-2" : "text-amber"
        )}
      >
        {termShort(pinnedTerm)}
      </span>
    );
  }
  if (!tag) return null;
  const raw = tag.replace(/[\[\]*]/g, "").toLowerCase();
  // Priority is the one filled badge on the row: it is the reason the row
  // sits at the top of its group, so it should read before the title does.
  const cls = raw === "priority"
    ? "bg-accent font-semibold text-accent-ink"
    : raw.includes("top")
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

/**
 * Pointer affordance for the command palette, which was otherwise reachable
 * only by knowing Ctrl/Cmd+K. Shows the shortcut so the keystroke gets learned
 * rather than replaced.
 */
function PaletteButton() {
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      title="Command palette"
      aria-label="Open command palette"
      aria-keyshortcuts="Control+K Meta+K"
      className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-line-2 bg-surface px-3 text-[13px] font-medium text-ink-2 transition-colors hover:border-ink-2 hover:text-ink focus-visible:border-accent focus-visible:outline-none"
    >
      <Search className="size-3.5" />
      <span className="hidden font-mono text-[10.5px] sm:inline">⌘K</span>
    </button>
  );
}

function Divider({ className }: { className?: string }) {
  return <span className={cn("h-5 w-px self-center bg-line", className)} />;
}

export function Triage({
  rows: initialRows,
  demo = false,
  initialView = DEFAULT_URL_STATE,
  initialSelected,
  wantedTerms = null,
}: {
  rows: TriageRow[];
  /**
   * Terms Settings > Preferences wants today. Rows in a known term outside
   * this set (Fall 2026 after it started, a term switched off) stay out of
   * the list, the pills and the counts, behind one "show" link. Null means
   * the preferences are unknown and nothing is hidden.
   */
  wantedTerms?: string[] | null;
  /**
   * Motion lab mode: keep every interaction local instead of persisting it, so
   * the animations can be exercised over and over against fixtures without
   * writing ticks, hides or resume builds to a real tracker. Only /motion-lab
   * passes this.
   */
  demo?: boolean;
  /**
   * The view to open on, from the page's `?filter=`, `?term=`, `?sort=` and
   * `?open=` search params (matches-lib parseUrlState). `?filter=` exists so
   * the command palette's "Show hidden" can reach the hidden list from the
   * tracker page; the rest let a link reproduce a view. Kept in sync with the
   * URL (replace, not push) as they change.
   */
  initialView?: MatchesUrlState;
  initialSelected?: string;
}) {
  const { show } = useAppView();
  const router = useRouter();
  const [rows, setRows] = useState<TriageRow[]>(initialRows);

  /* Re-seed from the server whenever it hands over a new array - a refresh, or
     an Add URL ingest landing. Without this the copy taken at mount survives
     every router.refresh() and newly ingested rows never appear. Adjusting
     state during render, which React allows for exactly this case. Any tick
     not yet flushed is superseded by the server's answer, which is the right
     way round: the server is authoritative about what a row is. */
  const [seed, setSeed] = useState(initialRows);
  if (initialRows !== seed) {
    setSeed(initialRows);
    setRows(initialRows);
  }

  // A row the link points at (?job= or ?open=) must be reachable: a hidden
  // one opens the hidden list, and unwatched terms are shown.
  const focusShort = initialSelected ?? initialView.open ?? undefined;
  const [filter, setFilter] = useState<Filter>(() =>
    initialRows.find((r) => r.short === focusShort)?.dismissed ? "hidden" : initialView.filter
  );
  const [showUnwatched, setShowUnwatched] = useState(!!focusShort);
  /* Rows in terms the preferences don't want, and the rows the surface
     works from. Unwatched rows are set aside before every count and filter,
     so "11 matches" and the pills describe what is actually on screen. */
  const { scoped, unwatched } = useMemo(() => {
    if (!wantedTerms || showUnwatched) return { scoped: rows, unwatched: [] as TriageRow[] };
    const wanted = new Set(wantedTerms);
    const out: TriageRow[] = [];
    const aside: TriageRow[] = [];
    for (const r of rows) {
      (r.term && isKnownTerm(r.term) && !wanted.has(r.term) ? aside : out).push(r);
    }
    return { scoped: out, unwatched: aside };
  }, [rows, wantedTerms, showUnwatched]);
  const unwatchedTerms = useMemo(
    () => sortTerms([...new Set(unwatched.filter((r) => !r.dismissed).map((r) => r.term))]),
    [unwatched]
  );
  const [termFilter, setTermFilter] = useState<string>(() =>
    termFromSlug(initialView.term, orderTerms(initialRows.map(termOf)))
  );
  const [sort, setSort] = useState<Sort>(initialView.sort);
  /** The one row whose details panel is open (desktop accordion). */
  const [openShort, setOpenShort] = useState<string | null>(initialView.open);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | null>(focusShort ?? null);
  const [burst, setBurst] = useState<{ visible: boolean; count: number }>({
    visible: false,
    count: 0,
  });

  // Motion state -----------------------------------------------------------
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
  const scrollFrame = useRef<number | null>(null);
  const scrollTarget = useRef<number | null>(null);

  const animateWindowScroll = useCallback((rawTarget: number) => {
    if (scrollFrame.current !== null) {
      window.cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
    }

    const maxScroll = Math.max(
      0,
      document.documentElement.scrollHeight - window.innerHeight
    );
    const target = Math.max(0, Math.min(maxScroll, rawTarget));
    const start = window.scrollY;
    scrollTarget.current = target;

    if (prefersReducedMotion() || Math.abs(target - start) < 1) {
      window.scrollTo({ top: target, behavior: "auto" });
      scrollTarget.current = null;
      return;
    }

    const startedAt = performance.now();
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / SCROLL_MS);
      const eased = 1 - Math.pow(1 - progress, 3);
      window.scrollTo({ top: start + (target - start) * eased });
      if (progress < 1) {
        scrollFrame.current = window.requestAnimationFrame(tick);
      } else {
        scrollFrame.current = null;
        scrollTarget.current = null;
      }
    };
    scrollFrame.current = window.requestAnimationFrame(tick);
  }, []);

  useEffect(
    () => () => {
      if (scrollFrame.current !== null) {
        window.cancelAnimationFrame(scrollFrame.current);
      }
    },
    []
  );

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
      // In-flight wins over an existing URL: a REBUILD runs while the old
      // artifact is still attached, and must read as "building".
      const s = builds[row.short];
      if (s === "building") return "building";
      if (typeof s === "object" && s?.failed !== undefined) return "failed";
      if (row.resumeUrl) return "built";
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

  // Build-report dialog: which row's report is open, a per-short metadata
  // cache (server-rendered meta first, refetched after in-session builds),
  // and the set of rows whose report icon should play its "just built" pulse.
  const [reportShort, setReportShort] = useState<string | null>(null);
  const [buildPromptShort, setBuildPromptShort] = useState<string | null>(null);
  const [metaCache, setMetaCache] = useState<Record<string, ResumeMeta>>({});
  const [justBuilt, setJustBuilt] = useState<Set<string>>(new Set());

  const metaFor = useCallback(
    (row: TriageRow): ResumeMeta | null =>
      metaCache[row.short] ?? row.resumeMeta ?? null,
    [metaCache]
  );

  const refreshMeta = useCallback((short: string) => {
    void fetchResumeMeta(short)
      .then((meta) => {
        if (meta) {
          setMetaCache((prev) => ({ ...prev, [short]: meta }));
          setRows((prev) =>
            prev.map((row) =>
              row.short === short ? { ...row, resumeMeta: meta } : row
            )
          );
        }
      })
      .catch(() => {});
  }, []);

  function openReport(row: TriageRow) {
    if (!metaFor(row)?.report) refreshMeta(row.short);
    setJustBuilt((prev) => {
      if (!prev.has(row.short)) return prev;
      const next = new Set(prev);
      next.delete(row.short);
      return next;
    });
    setReportShort(row.short);
  }

  function rebuild(short: string, opts: RebuildOpts) {
    setReportShort(null);
    delete buildStartedAt.current[short];
    setBuilds((prev) => ({ ...prev, [short]: "building" as const }));
    toast.success("Rebuilding - the current version stays restorable");
    void requestResumeRebuild(short, opts).then((res) => {
      if (res.ok) return;
      setBuilds((prev) => ({
        ...prev,
        [short]: { failed: res.error || "Couldn't start the rebuild." },
      }));
      toast.error(res.error || "Couldn't start the rebuild.");
    });
  }

  function restore(short: string) {
    void requestResumeRestore(short).then(async (res) => {
      if (!res.ok) {
        toast.error(res.error || "Couldn't restore the previous version.");
        return;
      }
      toast.success("Previous version restored");
      refreshMeta(short);
      try {
        const url = await fetchResumeUrl(short);
        if (url) updateRow(short, { resumeUrl: url });
      } catch {}
    });
  }

  const updateRow = useCallback((short: string, patch: Partial<TriageRow>) => {
    setRows((prev) =>
      prev.map((r) => (r.short === short ? { ...r, ...patch } : r))
    );
  }, []);

  /** The single seam every tick write goes through, so demo mode stays local. */
  const persistTicks = useCallback(
    (writes: TickWrite[]): Promise<unknown> =>
      demo ? Promise.resolve() : writeTicks(writes),
    [demo]
  );

  /* Status pills x term pills x search (matches-lib composeFilters). Each
     status pill is counted against the active term and query, each term pill
     against the active status and query. Term pills come from the rows - the
     wanted set rolls with the calendar - and a stored term no longer on offer
     simply stops applying rather than being written back from an effect. */
  const filtered = useMemo(
    () => composeFilters(scoped, { filter, term: termFilter, query }),
    [scoped, filter, termFilter, query]
  );
  const activeTerm = filtered.term;
  const visible = filtered.rows;

  const statusPills = useMemo<PillOption[]>(
    () =>
      STATUS_FILTERS.map((f) => ({
        key: f.key,
        label: f.label,
        count: filtered.statusCounts[f.key],
      })),
    [filtered]
  );
  const termPills = useMemo<PillOption[]>(
    () =>
      filtered.termCounts.map((t) => ({
        key: t.key,
        label: t.key === ALL_TERMS ? "All terms" : termLabel(t.key),
        count: t.count,
      })),
    [filtered]
  );

  /* Desktop: one flat list in the header's sort order. Phones keep the term
     groups (pinned Priority first), so their order is the groups flattened. */
  const sorted = useMemo(() => sortRows(visible, sort), [visible, sort]);
  const groups = useMemo(() => (isMobile ? groupRows(visible) : []), [isMobile, visible]);
  const ordered = useMemo(
    () => (isMobile ? groups.flatMap((g) => g.rows) : sorted),
    [isMobile, groups, sorted]
  );

  /* The open panel only counts while its row is on screen; a filter that
     drops the row closes it without writing state back. */
  const activeOpen = openShort && visible.some((r) => r.short === openShort) ? openShort : null;

  const stats = useMemo(() => {
    const active = scoped.filter((r) => !r.dismissed);
    return {
      matches: active.length,
      unwatched: unwatched.filter((r) => !r.dismissed).length,
    };
  }, [scoped, unwatched]);

  /* View state in the URL: ?filter= ?term= ?sort= ?open=, replacing the
     history entry so filtering never piles up Back presses. Other params
     (view, job) ride along untouched. */
  useEffect(() => {
    const qs = formatUrlState(window.location.search, {
      filter,
      term: activeTerm === ALL_TERMS ? null : termSlug(activeTerm),
      sort,
      open: activeOpen,
    });
    const href = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
    if (href !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, "", href);
    }
  }, [filter, activeTerm, sort, activeOpen]);

  const cursorIndex = cursor ? ordered.findIndex((r) => r.short === cursor) : -1;
  const currentRow = cursorIndex >= 0 ? ordered[cursorIndex] : null;

  /* Normal cursor moves keep the row just in view ("nearest"); a palette jump
     may land far off screen, so that one asks for the centre instead. */
  const scrollBlock = useRef<ScrollLogicalPosition>("nearest");
  useEffect(() => {
    if (!cursor) return;
    const el = rootRef.current?.querySelector?.('[data-cursor="1"]');
    if (!el) {
      scrollBlock.current = "nearest";
      return;
    }
    const rect = el.getBoundingClientRect();
    let target: number | null = null;
    if (scrollBlock.current === "center") {
      target = window.scrollY + rect.top - (window.innerHeight - rect.height) / 2;
    } else if (rect.top < 0) {
      target = window.scrollY + rect.top;
    } else if (rect.bottom > window.innerHeight) {
      target = window.scrollY + rect.bottom - window.innerHeight;
    }
    if (target !== null) {
      animateWindowScroll(target);
    } else if (scrollFrame.current !== null) {
      window.cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
      scrollTarget.current = null;
    }
    scrollBlock.current = "nearest";
  }, [cursor, animateWindowScroll]);

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
      await persistTicks(writes);
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
    if (openShort === short) setOpenShort(null);

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
    void persistTicks([{ short, field: "applied", value }]).catch(() => {
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
    void persistTicks([{ short, field: "saved", value }]).catch(() => {
      updateRow(short, { saved: r.saved });
      toast.error("Couldn't sync saved state.");
    });
  }
  function queueBuild(short: string, jdText?: string) {
    const row = rows.find((x) => x.short === short);
    if (!row || row.resumeUrl) return;
    if (builds[short] === "building") return;
    setBuildPromptShort(null);
    delete buildStartedAt.current[short];
    setBuilds((prev) => ({ ...prev, [short]: "building" as const }));
    if (demo) {
      // Walk the button through building -> built locally so the state machine
      // can be seen without dispatching a real Convex build.
      window.setTimeout(() => {
        updateRow(short, {
          resumeUrl: "#demo",
          hasJobDescription: row.hasJobDescription || Boolean(jdText),
        });
        setBuilds((prev) => {
          const next = { ...prev };
          delete next[short];
          return next;
        });
      }, 1400);
      return;
    }
    void requestResumeBuild(short, { jdText }).then((res) => {
      if (res.ok) {
        if (jdText) updateRow(short, { hasJobDescription: true });
        return;
      }
      setBuilds((prev) => ({ ...prev, [short]: { failed: res.error || "Couldn't start the resume build." } }));
      toast.error(res.error || "Couldn't start the resume build.");
    });
  }
  function startBuild(short: string) {
    const row = rows.find((x) => x.short === short);
    if (!row || row.resumeUrl || builds[short] === "building") return;
    if (!row.hasJobDescription) {
      setBuildPromptShort(short);
      return;
    }
    queueBuild(short);
  }
  /** Enter: the details panel on desktop; phones have no panel, so the
   *  posting opens instead, as it always has there. */
  function dockDetails() {
    if (!currentRow) return;
    if (isMobile) openRow();
    else toggleDetails(currentRow.short);
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
    if (demo) return; // demo builds resolve on their own timer
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
          // Pull the fresh build report and pulse the report affordance so
          // the "what did the tailor do" surface announces itself once.
          refreshMeta(s);
          setJustBuilt((prev) => new Set(prev).add(s));
        })();
      }
    }, BUILD_POLL_MS);
    return () => window.clearInterval(timer);
  }, [builds, updateRow, demo, refreshMeta]);

  /** Moves the cursor by `delta`, returning false when it was already at that
   *  end of the list (which is the caller's cue to scroll the page instead). */
  function move(delta: number): boolean {
    if (!ordered.length) return false;
    let i = cursorIndex;
    if (i < 0) {
      i = delta > 0 ? 0 : ordered.length - 1;
    } else {
      i = Math.max(0, Math.min(ordered.length - 1, i + delta));
      if (i === cursorIndex) return false;
    }
    setCursor(ordered[i].short);
    return true;
  }

  /* Item 5: at the ends of the list the cursor has nowhere to go, so j/k and
     the arrows hand off to the page. This is why the key handler can keep
     calling preventDefault() unconditionally - the browser's native arrow
     scrolling is not lost, it is taken over, so `j` and ArrowDown behave
     identically and a held key never fights a native scroll mid-list. */
  function edgeScroll(delta: number) {
    const start = scrollTarget.current ?? window.scrollY;
    animateWindowScroll(start + delta * EDGE_SCROLL_PX);
  }

  function navigate(delta: number) {
    if (!move(delta)) edgeScroll(delta);
  }

  function openRow(row?: TriageRow) {
    const r = row ?? currentRow;
    if (!r?.url) return;

    // Reuse the rendered anchor so the keyboard shortcut follows the same
    // browser navigation path as clicking the job title.
    const link = rootRef.current?.querySelector<HTMLAnchorElement>(
      '[data-cursor="1"] a[data-open]'
    );
    if (link?.href === r.url) {
      link.click();
      return;
    }
    window.open(r.url, "_blank", "noopener");
  }

  /** Opens a row's details panel (closing any other), or closes it. */
  function toggleDetails(short: string) {
    setCursor(short);
    setOpenShort((cur) => (cur === short ? null : short));
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
      const tag = (e.target as HTMLElement | null)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (k === "Escape") {
        // A dialog or the palette handles (and prevents) its own Escape.
        if (!isInput && !e.defaultPrevented && openShort) {
          e.preventDefault();
          setOpenShort(null);
        }
        return;
      }
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
        navigate(1);
      } else if (kl === "k" || k === "ArrowUp") {
        e.preventDefault();
        flashDock("up");
        navigate(-1);
      } else if (k === "ArrowLeft" || k === "ArrowRight") {
        e.preventDefault();
        if (termPills.length) {
          const idx = termPills.findIndex((p) => p.key === activeTerm);
          const cur = idx >= 0 ? idx : 0;
          const delta = k === "ArrowRight" ? 1 : -1;
          const next =
            (cur + delta + termPills.length) % termPills.length;
          setTermFilter(termPills[next].key);
        }
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
      } else if (kl === "t") {
        // The actual view cycle is wired globally (components/nav/view-cycle.tsx)
        // so it keeps working after the user leaves this surface - this just
        // flashes the dock's own keycap in step with it.
        e.preventDefault();
        flashDock("cycle");
      } else if (kl === "o") {
        e.preventDefault();
        flashDock("open");
        openRow();
      } else if (k === "Enter") {
        // A focused button or link keeps its own Enter.
        if (tag === "BUTTON" || tag === "A") return;
        e.preventDefault();
        flashDock("details");
        dockDetails();
      }
    };
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyboardActions.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function clearFilters() {
    setFilter("all");
    setTermFilter(ALL_TERMS);
    setQuery("");
  }

  function toggleSort(key: NonNullable<Sort>["key"]) {
    setSort((cur) => cycleSort(cur, key));
  }

  /* Command palette. Jump targets are every live match, not just the visible
     ones, so the palette is a way out of a filter rather than a prisoner of
     it - jumping to a row the current filters hide clears them first. */
  const paletteJumps = useMemo(
    () =>
      scoped
        .filter((r) => !r.dismissed)
        .map((r) => ({ id: r.short, title: r.company, subtitle: r.title })),
    [scoped]
  );

  const paletteActions: PaletteAction[] = [
    {
      id: "referrals",
      label: "Go to Referrals",
      icon: <Users className="size-4" />,
      run: () => router.push("/referrals"),
    },
    {
      id: "matches",
      label: "Go to Matches",
      icon: <LayoutList className="size-4" />,
      run: () => clearFilters(),
    },
    {
      id: "tracker",
      label: "Go to Tracker",
      icon: <ListChecks className="size-4" />,
      run: () => show("tracker"),
    },
    {
      id: "inbox",
      label: "Go to Inbox",
      icon: <Mail className="size-4" />,
      run: () => router.push("/inbox"),
    },
    {
      id: "resume",
      label: "Open Resume",
      icon: <FileText className="size-4" />,
      run: () => router.push("/profile"),
    },
    {
      id: "priority",
      label: "Show priority",
      icon: <Star className="size-4" />,
      run: () => {
        setTermFilter(ALL_TERMS);
        setFilter("priority");
      },
    },
    {
      id: "hidden",
      label: "Show hidden",
      icon: <Ghost className="size-4" />,
      run: () => {
        setTermFilter(ALL_TERMS);
        setFilter("hidden");
      },
    },
    {
      id: "clear",
      label: "Clear filters",
      icon: <Eraser className="size-4" />,
      run: clearFilters,
    },
  ];

  function paletteJump(short: string) {
    const row = rows.find((r) => r.short === short);
    if (!row) return;
    if (!ordered.some((r) => r.short === short)) clearFilters();
    scrollBlock.current = "center";
    setCursor(short);
  }

  const hasAnyRows = rows.length > 0;
  const emptyFilter = hasAnyRows && visible.length === 0;
  const today = todayLocal();

  const tableHandlers: MatchHandlers = {
    onActivate: toggleDetails,
    onToggleApplied: toggleApplied,
    onToggleSaved: toggleSaved,
    onHide: hideShort,
    onRestore: restoreShort,
    onBuild: startBuild,
    onOpenReport: openReport,
  };

  const nothingHere = (
    <>
      Nothing matches the current filters.
      <button
        type="button"
        onClick={clearFilters}
        className="ml-2 cursor-pointer font-medium text-accent underline decoration-dashed underline-offset-2"
      >
        clear filters
      </button>
    </>
  );

  // Flat render index per row for the mobile cascade stagger.
  let flatIndex = 0;

  return (
    <div
      ref={rootRef}
      className="mx-auto w-full max-w-[1060px] px-5 py-5 pb-32"
    >
      {/* The view switch leads the first row - same slot on every surface (see
          Tracker's own first row, and the /inbox and /profile pages) - with
          the freshness readout riding its right edge. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13px] text-ink-2 tabular-nums">
        <ViewSwitch active="matches" count={stats.matches} />
        <RefreshControl className="ml-auto" />
      </div>

      {/* toolbar - the search spans the row, with the palette trigger and Add
          URL at its right end. The status pills and term pills share the line
          underneath, status on the left and terms on the right. */}
      <div className="mb-2 flex items-center gap-2">
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search company, title, location…"
          autoComplete="off"
          aria-label="Search matches"
          className="h-[34px] min-w-0 flex-1 rounded-[5px] border border-line-2 bg-surface px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-2/70 focus:border-accent focus:outline-none"
        />
        <PaletteButton />
        <AddUrlDialog />
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <FilterPills
          label="Filter by status"
          options={statusPills}
          value={filter}
          onChange={(key) => setFilter(key as Filter)}
        />
        <FilterPills
          label="Filter by term"
          options={termPills}
          value={activeTerm}
          onChange={setTermFilter}
        />
      </div>

      {!hasAnyRows ? (
        <EmptyState
          title="No matches yet."
          hint="Matches will land here as the watcher finds them - or add a job URL manually."
          action={<AddUrlDialog />}
        />
      ) : !isMobile ? (
        <>
          <MatchesTable
            rows={sorted}
            sort={sort}
            onSort={toggleSort}
            openShort={activeOpen}
            cursor={cursor}
            wantedTerms={wantedTerms}
            today={today}
            hiding={hiding}
            entering={entering}
            rowStyle={cascadeStyle}
            flashFor={(short, field) => tokenFor(tickFlash, `${short}:${field}`)}
            buildStateFor={buildStateFor}
            buildErrorFor={buildErrorFor}
            metaFor={metaFor}
            justBuilt={justBuilt}
            handlers={tableHandlers}
            empty={nothingHere}
          />
          <p
            aria-live="polite"
            className="mt-2.5 font-mono text-[11px] tracking-[0.06em] text-ink-2 uppercase"
          >
            {visible.length} shown · {sortLabel(sort)}
          </p>
        </>
      ) : emptyFilter ? (
        <div className="rounded-md border border-line bg-surface">
          <div className="px-4 py-7 text-center text-[13px] text-ink-2">{nothingHere}</div>
        </div>
      ) : (
        <div>
          {groups.map((g) => {
            const headerIndex = flatIndex;
            return (
              <section key={g.term} className="mb-5 last:mb-0">
                <h2
                  className={cn(
                    "mb-1.5 flex items-baseline gap-1.5 text-[11.5px] font-semibold tracking-[0.09em] uppercase",
                    g.kind === "priority" ? "text-accent" : "text-ink-2"
                  )}
                  style={{
                    ...cascadeStyle(headerIndex),
                    animationDelay: `${Math.max(0, Math.min(headerIndex, CASCADE_CAP) * 70 - 40)}ms`,
                  }}
                >
                  {g.kind === "priority" ? (
                    <>
                      <Star className="size-3 self-center" strokeWidth={2.5} fill="currentColor" />
                      Priority
                    </>
                  ) : (
                    g.term
                  )}
                  <span
                    className={cn(
                      "font-normal not-italic tracking-normal normal-case",
                      g.kind === "priority" ? "text-accent/80" : "text-ink-2/80"
                    )}
                  >
                    · {g.rows.length}
                  </span>
                </h2>
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
                            pinned={g.kind === "priority"}
                            wantedTerms={wantedTerms}
                            defaultExpanded={r.short === activeOpen}
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
                            onOpenReport={() => openReport(r)}
                          />
                        </div>
                      </CollapseShell>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* Terms the preferences no longer want (a season that started, or one
          switched off) keep their rows out of the way, behind one link, so
          the list and its counts describe only what is being watched. */}
      {(stats.unwatched > 0 || showUnwatched) && wantedTerms && (
        <p className="mt-4 text-[12px] text-ink-2">
          {showUnwatched ? (
            <>
              Showing matches from terms you are not watching.{" "}
              <button
                type="button"
                onClick={() => setShowUnwatched(false)}
                className="font-medium text-accent underline decoration-dashed underline-offset-2"
              >
                hide them
              </button>
            </>
          ) : (
            <>
              {stats.unwatched} match{stats.unwatched === 1 ? "" : "es"} in{" "}
              {unwatchedTerms.length === 1 ? "a term" : "terms"} you are not watching (
              {unwatchedTerms.map(termLabel).join(", ")}).{" "}
              <button
                type="button"
                onClick={() => setShowUnwatched(true)}
                className="font-medium text-accent underline decoration-dashed underline-offset-2"
              >
                show
              </button>
            </>
          )}
        </p>
      )}

      <CommandPalette
        jumps={paletteJumps}
        onJump={paletteJump}
        actions={paletteActions}
      />

      {(() => {
        const row = rows.find((item) => item.short === buildPromptShort);
        return (
          <ResumeJdPrompt
            key={buildPromptShort ?? "closed"}
            open={Boolean(row)}
            company={row?.company ?? "this company"}
            title={row?.title ?? "this role"}
            onOpenChange={(open) => {
              if (!open) setBuildPromptShort(null);
            }}
            onBuildWithoutJd={() => {
              if (row) queueBuild(row.short);
            }}
            onSaveAndBuild={(jdText) => {
              if (row) queueBuild(row.short, jdText);
            }}
          />
        );
      })()}

      <ResumeReportDialog
        company={
          rows.find((r) => r.short === reportShort)?.company ?? "Resume"
        }
        short={reportShort}
        meta={(() => {
          const r = rows.find((x) => x.short === reportShort);
          return r ? metaFor(r) : null;
        })()}
        onOpenChange={(o) => {
          if (!o) setReportShort(null);
        }}
        onRebuild={rebuild}
        onRestore={restore}
        onJobDescriptionSaved={(short) =>
          updateRow(short, { hasJobDescription: true })
        }
      />

      <Dock
        pressed={pressed}
        onCycle={() => {
          flashDock("cycle");
          show("tracker");
        }}
        onNav={(d) => {
          flashDock(d > 0 ? "down" : "up");
          navigate(d);
        }}
        onAct={(kind) => {
          flashDock(kind);
          actOnCurrent(kind);
        }}
        onOpen={() => {
          flashDock("open");
          openRow();
        }}
        onDetails={() => {
          flashDock("details");
          dockDetails();
        }}
        onBuild={() => {
          flashDock("build");
          dockBuild();
        }}
        buildState={currentRow ? buildStateFor(currentRow) : "idle"}
        detailsOpen={!!currentRow && currentRow.short === activeOpen}
      />

      {burst.visible && (
        <div
          className="fixed right-4 bottom-[76px] z-[60] flex items-center gap-3 rounded-md bg-ink px-3.5 py-2.5 text-[13px] text-bg shadow-[0_4px_16px_color-mix(in_srgb,var(--color-ink)_22%,transparent)]"
          style={{ animation: "toastin .22s var(--ease-out-soft) both" }}
        >
          <span>
            Hidden <BurstCount count={burst.count} />
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

/** The hide-burst tally, popping once per increment within a burst. */
function BurstCount({ count }: { count: number }) {
  const el = useReplay<HTMLSpanElement>(count, TICK_POP, TICK_POP_OPTS);
  return (
    <span ref={el} className="inline-block font-semibold tabular-nums">
      {count}
    </span>
  );
}

function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-line bg-surface">
      <div className="px-4 py-20 text-center">
        <div className="text-[13.5px] font-medium text-ink">{title}</div>
        <p className="mt-1 text-[12.5px] text-ink-2">{hint}</p>
        {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
      </div>
    </div>
  );
}

function ResumeButton({
  state,
  href,
  onBuild,
  error,
  noJd,
  format,
}: {
  state: BuildState;
  href: string | null;
  onBuild: () => void;
  error?: string;
  noJd?: boolean;
  format?: "pdf" | "docx";
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
        title={
          noJd
            ? "No job description was found. This resume used only the job title, company, and location."
            : format === "pdf"
              ? "Open generated PDF"
              : "Open generated resume"
        }
        onClick={(e) => e.stopPropagation()}
        className={cn(
          base,
          "border-[color-mix(in_srgb,var(--color-accent)_42%,transparent)] bg-surface text-accent hover:border-ink-2"
        )}
      >
        {noJd ? (
          <AlertTriangle className="size-3.5 text-amber" aria-hidden="true" />
        ) : (
          <FileText className="size-3.5" />
        )}
        {format === "pdf" ? "resume PDF" : "resume"}
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

function MobileCard({
  row,
  pinned = false,
  wantedTerms,
  defaultExpanded = false,
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
  onOpenReport,
}: {
  row: TriageRow;
  pinned?: boolean;
  wantedTerms: string[] | null;
  /** Opened by a ?open= link. */
  defaultExpanded?: boolean;
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
  onOpenReport: () => void;
}) {
  const [drag, setDrag] = useState(0);
  const [expanded, setExpanded] = useState(defaultExpanded);
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
              blurOnPointerActivate(e);
              onToggleApplied();
            }}
            className={cn(
              "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-[1.5px] transition-colors",
              FOCUS_RING,
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
              <Tags
                tag={row.tag}
                pinnedTerm={pinned ? row.term : undefined}
                wantedTerms={wantedTerms}
              />
              {saved && (
                <Star
                  className="size-3 shrink-0 self-center text-amber"
                  fill="currentColor"
                  aria-label="saved"
                />
              )}
            </div>
            {row.url ? (
              <a
                data-open
                href={row.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className={cn(
                  "mt-0.5 block line-clamp-2 text-[12px] text-ink transition-colors hover:text-accent hover:underline underline-offset-3",
                  applied && "opacity-55"
                )}
                title={row.title}
              >
                {row.title}
              </a>
            ) : (
              <div
                className={cn(
                  "mt-0.5 line-clamp-2 text-[12px] text-ink transition-opacity duration-[250ms]",
                  applied && "opacity-55"
                )}
              >
                {row.title}
              </div>
            )}
            <div className="mt-1 truncate text-[11px] text-ink-2 tabular-nums">
              {[row.location, row.salary, `seen ${fmtDate(row.added)}`]
                .filter(Boolean)
                .join(" · ")}
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
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
            <ReferralLink short={row.short} />
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
            <ResumeButton
              state={buildState}
              href={row.resumeUrl}
              onBuild={onBuild}
              error={buildError}
              noJd={row.resumeMeta?.report?.jdSource === "stub"}
              format={row.resumeMeta?.format}
            />
            {buildState === "built" && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenReport();
                  setExpanded(false);
                }}
                className="rounded-md border border-line-2 bg-surface px-2.5 py-1.5 text-[12px] font-medium text-ink transition-colors hover:border-ink-2"
              >
                Report
              </button>
            )}
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

/**
 * One dock button. Owns its own press-ring replay so the ring blooms in the
 * action's colour - a uniform accent flash on every key reads as one
 * undifferentiated blink, and loses the colour language the dock already
 * teaches (green applies, amber saves, red hides).
 */
function DockButton({
  act,
  ring,
  pressed,
  className,
  children,
  ...rest
}: {
  act: string;
  ring: string;
  pressed: FlashState;
  className?: string;
  children: React.ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className">) {
  const btn = useReplay<HTMLButtonElement>(
    tokenFor(pressed, act),
    keypressFrames(ring),
    KEYPRESS_OPTS
  );
  return (
    <button ref={btn} type="button" data-act={act} className={className} {...rest}>
      {children}
    </button>
  );
}

/* Glass dock: translucent surface + blur, an entrance rise on mount, and a
   keycap press ring on whichever action fired (click or keyboard shortcut). */
function Dock({
  pressed,
  onNav,
  onAct,
  onOpen,
  onDetails,
  onBuild,
  onCycle,
  buildState,
  detailsOpen,
}: {
  pressed: FlashState;
  onNav: (d: number) => void;
  onAct: (kind: "applied" | "saved" | "hide") => void;
  onOpen: () => void;
  onDetails: () => void;
  onBuild: () => void;
  onCycle: () => void;
  buildState: BuildState;
  /** The cursor row's panel is open, so ↵ closes it. */
  detailsOpen: boolean;
}) {
  const kbd =
    "rounded border border-line-2 bg-surface px-1 py-px font-mono text-[10.5px] font-medium text-ink-2";
  const db =
    "inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-transparent bg-transparent px-2 py-1.5 text-[12.5px] font-medium text-ink transition-colors select-none active:translate-y-px hover:bg-chip hover:border-line-2";
  const label = "hidden min-[701px]:inline";
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
          | "cycle"
          | "up"
          | "down"
          | "applied"
          | "saved"
          | "hide"
          | "build"
          | "open"
          | "details"
          | undefined;
        if (act === "cycle") onCycle();
        else if (act === "up" || act === "down") onNav(act === "up" ? -1 : 1);
        else if (act === "build") onBuild();
        else if (act === "open") onOpen();
        else if (act === "details") onDetails();
        else if (act) onAct(act as "applied" | "saved" | "hide");
      }}
    >
      <DockButton
        act="cycle"
        ring="var(--color-ink-2)"
        pressed={pressed}
        title="Switch view"
        className={cn(db, "text-ink-2")}
      >
        <span className={kbd}>t</span>
      </DockButton>
      <Divider />
      <DockButton
        act="up"
        ring="var(--color-amber)"
        pressed={pressed}
        className={cn(db, "text-ink-2 hover:border-amber hover:bg-[color-mix(in_srgb,var(--color-amber)_10%,transparent)]")}
      >
        <span className={kbd}>k</span>
      </DockButton>
      <DockButton
        act="down"
        ring="var(--color-amber)"
        pressed={pressed}
        className={cn(db, "text-ink-2 hover:border-amber hover:bg-[color-mix(in_srgb,var(--color-amber)_10%,transparent)]")}
      >
        <span className={kbd}>j</span>
      </DockButton>
      <Divider />
      <DockButton
        act="applied"
        ring="var(--color-accent)"
        pressed={pressed}
        className={cn(db, "text-accent hover:border-accent hover:bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)]")}
      >
        <span className={kbd}>x</span> <span className={label}>applied</span>
      </DockButton>
      <DockButton
        act="saved"
        ring="var(--color-amber)"
        pressed={pressed}
        className={cn(db, "text-amber hover:border-amber hover:bg-[color-mix(in_srgb,var(--color-amber)_10%,transparent)]")}
      >
        <span className={kbd}>s</span> <span className={label}>save</span>
      </DockButton>
      <DockButton
        act="hide"
        ring="var(--color-red)"
        pressed={pressed}
        className={cn(db, "text-red hover:border-red hover:bg-[color-mix(in_srgb,var(--color-red)_10%,transparent)]")}
      >
        <span className={kbd}>h</span> <span className={label}>hide</span>
      </DockButton>
      <Divider />
      <DockButton
        act="build"
        ring="var(--color-accent)"
        pressed={pressed}
        disabled={buildState === "building"}
        title={buildState === "built" ? "open resume" : "build resume"}
        className={cn(db, "disabled:opacity-70")}
      >
        <span className={kbd}>b</span>{" "}
        {buildState === "building" ? (
          <Loader2 className="size-3.5 animate-spin text-ink-2" />
        ) : (
          <span className={label}>build resume</span>
        )}
      </DockButton>
      <DockButton
        act="details"
        ring="var(--color-ink-2)"
        pressed={pressed}
        title={detailsOpen ? "close details (Esc)" : "show details"}
        className={db}
      >
        <span className={kbd}>↵</span> <span className={label}>details</span>
      </DockButton>
      <DockButton act="open" ring="var(--color-ink-2)" pressed={pressed} title="open posting" className={db}>
        <span className={kbd}>o</span> <span className={label}>open</span>
      </DockButton>
    </div>
  );
}
