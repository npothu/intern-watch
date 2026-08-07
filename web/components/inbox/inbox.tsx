"use client";

// The inbox triage surface. Row anatomy mirrors the matches list (company
// bold, meta line, actions right) so the two feel like one product; motion
// mirrors triage.tsx: entrance cascade on mount, 320ms grid-row collapse on
// resolve/dismiss, optimistic commit with rollback on failure.

import { useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { Mail, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { resolveAction } from "@/app/(app)/inbox/inbox-actions";
import type { InboxAction, MailHealth } from "@/lib/convex";
import {
  STATUS_LABELS,
  STATUS_ORDER,
  isTrackerStatus,
  type TrackerStatus,
} from "@/components/tracker/tracker-lib";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const COLLAPSE_MS = 340; // collapse duration + a frame, matching triage HIDE_MS
const CASCADE_CAP = 12;

const NONE = "__none__";

/* Signal chips reuse the tracker's status tones so "rejected" reads red in
 * both places. */
const SIGNAL_TONE: Record<string, string> = {
  rejected: "bg-[color-mix(in_srgb,var(--color-red)_13%,transparent)] text-red",
  offer: "bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-accent",
  interview: "bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-accent",
  oa: "bg-[color-mix(in_srgb,var(--color-amber)_14%,transparent)] text-amber",
  phone_screen: "bg-[color-mix(in_srgb,var(--color-amber)_14%,transparent)] text-amber",
};

function gmailUrl(a: InboxAction): string {
  return (
    "https://mail.google.com/mail/?authuser=" +
    encodeURIComponent(a.accountEmail) +
    "#all/" +
    encodeURIComponent(a.gmailMessageId)
  );
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const mins = Math.round((Date.now() - d.getTime()) / 60_000);
  if (mins < 60) return `${Math.max(mins, 0)}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function cascadeStyle(i: number): CSSProperties {
  return {
    animation: "cascade .5s var(--ease-out-soft) both",
    animationDelay: `${Math.min(i, CASCADE_CAP) * 70}ms`,
  };
}

function ActionRow({
  action,
  index,
  leaving,
  onResolve,
  onDismiss,
}: {
  action: InboxAction;
  index: number;
  leaving: boolean;
  onResolve: (short: string | null, status: string) => void;
  onDismiss: () => void;
}) {
  const candidates = useMemo(
    () => [...action.candidates].sort((a, b) => b.score - a.score),
    [action.candidates],
  );
  const [short, setShort] = useState<string>(candidates[0]?.short ?? NONE);
  const [status, setStatus] = useState<string>(
    isTrackerStatus(action.signal) ? action.signal : "applied",
  );
  const noMatch = short === NONE;

  return (
    /* Grid-row collapse (triage 1g): the outer grid animates 1fr -> 0fr while
       the inner wrapper hides overflow, so the list closes around the row
       instead of it blinking out. */
    <div
      className="grid transition-[grid-template-rows,opacity] duration-300 ease-[var(--ease-out-soft)]"
      style={{ gridTemplateRows: leaving ? "0fr" : "1fr", opacity: leaving ? 0 : 1 }}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          style={cascadeStyle(index)}
          className="border-t border-line px-3 py-3 first:border-t-0"
        >
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[13.5px] font-semibold text-ink">
              {candidates[0]?.company || action.from}
            </span>
            <span
              className={cn(
                "inline-block rounded-full px-2 py-px text-[10.5px] font-semibold",
                SIGNAL_TONE[action.signal] ?? "bg-chip text-ink-2",
              )}
            >
              {STATUS_LABELS[action.signal as TrackerStatus] ?? action.signal}{" "}
              signal
            </span>
          </div>
          <div className="mt-0.5 truncate text-[12px] text-ink-2 tabular-nums">
            &ldquo;{action.subject}&rdquo; · {action.from} ·{" "}
            {fmtWhen(action.receivedAt)} ·{" "}
            <a
              href={gmailUrl(action)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline-offset-3 hover:underline"
            >
              open in Gmail
              <ExternalLink className="mb-0.5 ml-0.5 inline size-3" />
            </a>
          </div>

          <div className="mt-2 rounded-md bg-chip px-2.5 py-1.5 text-[12px] text-ink-2">
            evidence:{" "}
            <b className="font-medium text-ink">&ldquo;{action.evidence}&rdquo;</b>
            {candidates[0] && (
              <>
                {" "}
                · top match: <b className="font-medium text-ink">{candidates[0].company} - {candidates[0].title}</b>{" "}
                <span className="tabular-nums">({candidates[0].score.toFixed(1)})</span>
              </>
            )}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Select value={short} onValueChange={setShort}>
              <SelectTrigger className="h-7 max-w-[280px] rounded-full border border-line-2 bg-surface px-3 text-[12px] text-ink">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((c) => (
                  <SelectItem key={c.short} value={c.short}>
                    {c.company} - {c.title}
                  </SelectItem>
                ))}
                <SelectItem value={NONE}>none of these</SelectItem>
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger
                className={cn(
                  "h-7 w-[128px] rounded-full border border-line-2 bg-surface px-3 text-[12px] font-medium",
                  noMatch && "pointer-events-none opacity-40",
                )}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_ORDER.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              type="button"
              onClick={() => (noMatch ? onDismiss() : onResolve(short, status))}
              className="inline-flex h-7 items-center rounded-full bg-accent px-3.5 text-[12px] font-medium text-accent-ink transition-[filter,transform] hover:brightness-105 active:scale-95"
            >
              {noMatch ? "Dismiss" : "Resolve"}
            </button>
            {!noMatch && (
              <button
                type="button"
                onClick={onDismiss}
                className="inline-flex h-7 items-center rounded-full px-3 text-[12px] font-medium text-ink-2 transition-colors hover:bg-chip hover:text-ink"
              >
                Dismiss
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function Inbox({
  initialActions,
  health,
}: {
  initialActions: InboxAction[];
  health: MailHealth | null;
}) {
  const router = useRouter();
  const [actions, setActions] = useState(initialActions);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());

  function depart(id: string) {
    setLeaving((prev) => new Set(prev).add(id));
    window.setTimeout(() => {
      setActions((prev) => prev.filter((a) => a.id !== id));
      setLeaving((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      // Refresh the server-rendered header badge count.
      router.refresh();
    }, COLLAPSE_MS);
  }

  async function commit(
    action: InboxAction,
    opts: { short?: string; status?: string; dismiss?: boolean },
    label: string,
  ) {
    depart(action.id);
    const res = await resolveAction(action.id, opts);
    if (res.ok) {
      toast.success(label);
    } else {
      // Rollback: the row returns to the top of the list rather than its old
      // slot - being visible again matters more than ordering.
      setActions((prev) =>
        prev.some((a) => a.id === action.id) ? prev : [action, ...prev],
      );
      toast.error(res.error);
    }
  }

  // Leaving rows stay mounted while their collapse plays; depart() removes
  // them from `actions` after COLLAPSE_MS.
  const remaining = actions;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-[12.5px] text-ink-2">
          Ambiguous recruiter emails land here after each Gmail push - decisive
          ones update the tracker automatically.
        </p>
        {health?.lastError && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[color-mix(in_srgb,var(--color-amber)_12%,transparent)] px-2.5 py-0.5 text-[11.5px] font-medium text-amber">
            <Mail className="size-3" />
            mail sync failing: {health.lastError.slice(0, 48)}
          </span>
        )}
      </div>

      {remaining.length === 0 ? (
        <div
          style={cascadeStyle(0)}
          className="rounded-md border border-line bg-surface px-4 py-10 text-center text-[13px] text-ink-2"
        >
          <Mail className="mx-auto mb-2 size-5 opacity-50" />
          Inbox zero. New recruiter emails land here after each Gmail push
          {health?.lastPushAt
            ? ` - last push ${fmtWhen(new Date(health.lastPushAt).toISOString())}.`
            : "."}
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-line bg-surface">
          {remaining.map((a, i) => (
            <ActionRow
              key={a.id}
              action={a}
              index={i}
              leaving={leaving.has(a.id)}
              onResolve={(short, status) =>
                commit(
                  a,
                  { short: short ?? undefined, status },
                  `${STATUS_LABELS[status as TrackerStatus] ?? status} recorded`,
                )
              }
              onDismiss={() => commit(a, { dismiss: true }, "Dismissed")}
            />
          ))}
        </div>
      )}
    </div>
  );
}
