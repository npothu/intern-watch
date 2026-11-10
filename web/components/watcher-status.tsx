"use client";

// The header's one status control: a labelled chip ("Checked 38m ago") and
// the popover behind it. It replaces four separate header items that all
// answered "is this data fresh?" without saying so - a bare health dot, the
// watcher sparkline, its "4H" caption and the "AS OF 10:10 PM" readout with
// its refresh icon. The chip states the answer in words and colour; the
// popover holds the detail (sparkline, per-pipeline rows, when this page's
// data was read) and the one action, Refresh.
//
// The level and wording are pure (lib/watcher-status.ts). The header renders
// this twice, once per layout (desktop, phone) with CSS picking one, so the
// open state lives in the header and both copies share it.

import { useId } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { sinceLabel, type PulseRun } from "@/lib/watcher-pulse";
import type { StatusLevel, WatcherStatus } from "@/lib/watcher-status";
import type { TrackerHealth } from "@/lib/convex";
import type { Freshness } from "@/components/refresh-control";
import { WatcherPulse } from "@/components/watcher-pulse";

/** Matches the chip, its popover and anything else that opens it (each
 *  carries `data-watcher-status`), so the header's click-away leaves presses
 *  on them alone. */
export const STATUS_SELECTOR = "[data-watcher-status]";

const DOT: Record<StatusLevel, string> = { ok: "bg-accent", warn: "bg-amber", bad: "bg-red" };
const TEXT: Record<StatusLevel, string> = { ok: "text-accent", warn: "text-amber", bad: "text-red" };

export function StatusDot({ level, className }: { level: StatusLevel; className?: string }) {
  return (
    <span aria-hidden className={cn("relative flex size-[7px] shrink-0", className)}>
      {level !== "ok" && (
        <span
          className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60", DOT[level])}
          style={{ animationDuration: "2.4s" }}
        />
      )}
      <span className={cn("relative inline-flex size-full rounded-full", DOT[level])} />
    </span>
  );
}

export function WatcherStatusChip({
  status,
  open,
  onOpenChange,
  health,
  runs,
  renderedAt,
  clock,
  freshness,
  compact = false,
}: {
  status: WatcherStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  health: TrackerHealth | null;
  /** The watcher's last day of runs for the sparkline, streamed (never rejects). */
  runs?: Promise<PulseRun[]>;
  /** The layout's server render time: the end of the sparkline's window. */
  renderedAt: number;
  /** "Now" for every age on screen (lib/use-minute useClock). */
  clock: number;
  freshness: Freshness;
  /** Always the short label (phones); otherwise it widens at 1200px. */
  compact?: boolean;
}) {
  const panelId = useId();
  // The same two mail problems lib/watcher-status.ts reports on the chip.
  const mailExpired = Boolean(health?.mail?.watchExpiration && health.mail.watchExpiration < clock);
  return (
    <div data-watcher-status className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Pipeline status: ${status.label}`}
        className={cn(
          "inline-flex h-8 cursor-pointer items-center gap-2 rounded-full px-2.5 text-[12.5px] whitespace-nowrap tabular-nums transition-colors hover:bg-chip",
          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent",
          open && "bg-chip",
          status.level === "ok" ? "text-ink-2 hover:text-ink" : TEXT[status.level]
        )}
      >
        <StatusDot level={status.level} />
        {compact ? (
          status.short
        ) : (
          <>
            <span className="min-[1200px]:hidden">{status.short}</span>
            <span className="hidden min-[1200px]:inline">{status.label}</span>
          </>
        )}
      </button>
      {open && (
        // A disclosure panel, not a dialog: it does not take focus or trap
        // it, and it sits right after its button in the tab order.
        <div
          id={panelId}
          role="group"
          aria-label="Pipeline status"
          className={cn(
            "absolute top-[calc(100%+8px)] right-0 z-50 w-[300px] origin-top-right animate-in rounded-xl border border-line-2 bg-surface p-3.5 text-[12.5px] shadow-lg duration-150 fade-in-0 zoom-in-95",
            // On a phone the chip is not at the screen edge, so the panel
            // spans the screen under the header instead of hanging off it.
            "max-[699px]:fixed max-[699px]:inset-x-3 max-[699px]:top-[54px] max-[699px]:w-auto"
          )}
        >
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <span className="text-[14px] font-semibold text-ink">Job watcher</span>
            <span className={cn("font-medium", TEXT[status.level])}>{status.word}</span>
          </div>
          {runs && <WatcherPulse runs={runs} now={renderedAt} clock={clock} />}
          <Row k="Watcher" ok={status.level !== "bad"}>
            {health?.watcherPushedAt
              ? `ran ${sinceLabel(health.watcherPushedAt, clock)} ago`
              : "no matches pushed yet"}
          </Row>
          <Row k="Mail sync" ok={!health?.mail?.lastError && !mailExpired}>
            {health?.mail
              ? health.mail.lastError
                ? `failing: ${health.mail.lastError.slice(0, 60)}`
                : mailExpired
                  ? "watch expired"
                  : health.mail.lastPushAt
                  ? `push ${sinceLabel(health.mail.lastPushAt, clock)} ago`
                  : "no push yet"
              : "not connected"}
          </Row>
          <Row k="Resume builds" ok={!health?.stuckBuilds}>
            {health?.stuckBuilds ? `${health.stuckBuilds} stuck >15m` : "none stuck"}
          </Row>
          <Row k="Inbox queue" ok>
            {health ? `${health.pendingInbox} pending` : "-"}
          </Row>
          {status.level !== "ok" && (
            <p className="mt-2 text-[12px] leading-snug text-ink-2">
              While this is amber or red, an empty Matches page means the pipeline needs attention,
              not that nothing matched.
            </p>
          )}
          <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-line pt-2.5">
            <span className={cn("text-[12px]", freshness.stale ? "text-amber" : "text-ink-2")}>
              {freshness.label ? `Page data ${freshness.label}` : "Page data"}
              {freshness.stale && ", older than one watcher run"}
            </span>
            <button
              type="button"
              onClick={freshness.refresh}
              disabled={freshness.pending}
              className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-[7px] border border-line-2 px-2.5 text-ink transition-colors hover:border-ink-2 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-default disabled:opacity-70"
            >
              <RefreshCw aria-hidden className={cn("size-3.5", freshness.pending && "animate-spin")} />
              Refresh
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ k, ok, children }: { k: string; ok: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-dashed border-line py-1.5">
      <span className="shrink-0 text-ink-2">{k}</span>
      <span className={cn("text-right font-medium tabular-nums", ok ? "text-ink" : "text-amber")}>
        {children}
      </span>
    </div>
  );
}
