"use client";

// The resume build report dialog: what the tailor actually did, and the seam
// for steering it. Five tabs - Preview (rendered outline as a paper
// miniature), What changed (before/after bullets), Selection (JD scores),
// Inputs (JD provenance + manual paste), Edit (hand-edit bullets and/or
// describe a change for the LLM, then rebuild into a new version while the
// previous one stays restorable).
//
// The dialog is read-only over a `ResumeReport`; rebuild/restore intents are
// handed up to Triage, which owns the per-row build state machine.

import { useMemo, useState } from "react";
import { Download, RotateCcw, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { ResumeMeta, ResumeReport } from "@/lib/convex";

export type RebuildOpts = {
  jdText?: string;
  instructions?: string;
  overrides?: { name: string; bullets: string[] }[];
};

const TABS = ["Preview", "Changes", "Selection", "Inputs", "Edit"] as const;
type Tab = (typeof TABS)[number];

function fmtBuilt(ts?: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Chip({
  tone = "chip",
  children,
}: {
  tone?: "chip" | "accent" | "amber" | "red";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-block rounded-full px-2 py-px text-[10.5px] font-semibold",
        tone === "accent" &&
          "bg-[color-mix(in_srgb,var(--color-accent)_13%,transparent)] text-accent",
        tone === "amber" &&
          "bg-[color-mix(in_srgb,var(--color-amber)_13%,transparent)] text-amber",
        tone === "red" &&
          "bg-[color-mix(in_srgb,var(--color-red)_12%,transparent)] text-red",
        tone === "chip" && "bg-chip text-ink-2"
      )}
    >
      {children}
    </span>
  );
}

/* ------------------------------ Preview tab ------------------------------ */

function PreviewTab({ report }: { report: ResumeReport }) {
  // Bullets rewritten or hand-edited for THIS build get the highlight wash in
  // the miniature, so "what changed" is visible in place on the page.
  const changed = useMemo(() => {
    const set = new Set<string>();
    for (const p of report.projects) {
      if (p.llmRewritten || p.overridden) {
        for (const b of p.after) set.add(b.trim());
      }
    }
    return set;
  }, [report]);

  return (
    <div>
      <div className="mx-auto max-w-[480px] rounded-[4px] border border-line-2 bg-white px-7 py-6 font-serif text-[10.5px] leading-[1.45] text-[#1a1a1a] shadow-md">
        {report.outline.map((line, i) => {
          const t = line.trim();
          const hot = changed.has(t);
          return (
            <div
              key={i}
              className={cn(
                i === 0 && "text-center text-[14px] font-bold tracking-wide",
                i === 1 && "mb-1.5 text-center text-[8.5px] text-[#555]",
                hot && "bg-[color-mix(in_srgb,#33604a_14%,#fff)]"
              )}
            >
              {t || " "}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-center text-[11.5px] text-ink-2">
        Rendered from the exact build output - highlighted lines were tailored
        for this job.
      </p>
    </div>
  );
}

/* ------------------------------ Changes tab ------------------------------ */

function ChangesTab({ report }: { report: ResumeReport }) {
  const rewritten = report.projects.filter((p) => p.llmRewritten || p.overridden);
  return (
    <div>
      <p className="mb-2 text-[12px] text-ink-2">
        {rewritten.length} of {report.projects.length} projects changed from
        bank text
        {report.usedLlm ? "" : " (LLM pass unavailable - see Inputs)"}.
      </p>
      {report.projects.map((p) => {
        const changedIdx = p.before.join("\n") !== p.after.join("\n");
        return (
          <div key={p.name} className="mb-3 last:mb-0">
            <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[12.5px] font-semibold text-ink">
              {p.name}
              {p.variant && p.variant !== "base" && (
                <Chip tone="chip">variant: {p.variant}</Chip>
              )}
              {p.overridden ? (
                <Chip tone="amber">edited by you</Chip>
              ) : p.llmRewritten ? (
                <Chip tone="accent">rewritten</Chip>
              ) : (
                <Chip tone="chip">bank text kept</Chip>
              )}
            </div>
            {changedIdx ? (
              <>
                {p.before.map((b, i) => (
                  <div
                    key={`b${i}`}
                    className="my-0.5 rounded-[5px] bg-[color-mix(in_srgb,var(--color-red)_9%,transparent)] px-2 py-1 font-mono text-[11.5px] text-ink-2 line-through decoration-[color-mix(in_srgb,var(--color-red)_55%,transparent)] [overflow-wrap:anywhere]"
                  >
                    {b}
                  </div>
                ))}
                {p.after.map((b, i) => (
                  <div
                    key={`a${i}`}
                    className="my-0.5 rounded-[5px] bg-[color-mix(in_srgb,var(--color-accent)_11%,transparent)] px-2 py-1 font-mono text-[11.5px] text-ink [overflow-wrap:anywhere]"
                  >
                    {b}
                  </div>
                ))}
              </>
            ) : (
              p.after.map((b, i) => (
                <div
                  key={i}
                  className="my-0.5 rounded-[5px] bg-chip px-2 py-1 font-mono text-[11.5px] text-ink-2 [overflow-wrap:anywhere]"
                >
                  {b}
                </div>
              ))
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ----------------------------- Selection tab ----------------------------- */

function SelectionTab({ report }: { report: ResumeReport }) {
  const entries = Object.entries(report.scores).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...entries.map(([, s]) => s), 1);
  const picked = new Set(report.projects.map((p) => p.name));
  return (
    <div>
      <p className="mb-2 text-[12px] text-ink-2">
        Projects scored against the JD - tags ×3, tech ×2, bullet prose ×1
        (the select.py rules). Top 6 make the page.
      </p>
      <div className="grid grid-cols-[minmax(0,1fr)_46px_minmax(0,1.1fr)] items-center gap-x-2.5 gap-y-1.5 text-[12.5px]">
        {entries.map(([name, score]) => {
          const out = !picked.has(name);
          return (
            <div key={name} className="contents">
              <span className={cn("truncate", out ? "text-ink-2" : "font-medium text-ink")}>
                {name}
                {out && (
                  <span className="ml-1.5 align-[1px]">
                    <Chip tone="chip">dropped</Chip>
                  </span>
                )}
              </span>
              <span
                className={cn(
                  "text-right font-mono text-[11px] tabular-nums",
                  out ? "text-ink-2" : "text-ink"
                )}
              >
                {score.toFixed(1)}
              </span>
              <div className="h-1.5 overflow-hidden rounded-full bg-chip">
                <div
                  className={cn("h-full rounded-full", out ? "bg-ink-2/40" : "bg-accent")}
                  style={{ width: `${Math.max((score / max) * 100, 2)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-2.5 text-[11.5px] text-ink-2">
        Want a dropped project back in? Hand-edit in the Edit tab, or add JD
        keywords to its tags in your Resume profile.
      </p>
    </div>
  );
}

/* ------------------------------ Inputs tab ------------------------------- */

function InputsTab({
  report,
  onRebuild,
}: {
  report: ResumeReport;
  onRebuild: (opts: RebuildOpts) => void;
}) {
  const [jd, setJd] = useState("");
  return (
    <div className="text-[12.5px]">
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {report.jdSource === "manual" && <Chip tone="accent">pasted JD · {report.jdChars} chars</Chip>}
        {report.jdSource === "fetched" && <Chip tone="accent">JD fetched · {report.jdChars} chars</Chip>}
        {report.jdSource === "stub" && (
          <Chip tone="red">no JD acquired - built from the title stub</Chip>
        )}
        {report.usedLlm ? (
          <Chip tone="accent">
            <Sparkles className="mb-0.5 mr-0.5 inline size-2.5" />
            LLM rewrites applied
          </Chip>
        ) : (
          <Chip tone="amber">
            {report.llmError ? `LLM failed: ${report.llmError.slice(0, 40)}` : "LLM unavailable - bank text"}
          </Chip>
        )}
      </div>
      {report.notes.length > 0 && (
        <ul className="mb-2 list-disc pl-5 text-[12px] text-ink-2">
          {report.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      <p className="mb-1.5 text-ink-2">
        {report.jdSource === "stub"
          ? "Paste the job description to rebuild against the real posting:"
          : "Think the fetched JD was wrong or thin? Paste the real one and rebuild:"}
      </p>
      <textarea
        value={jd}
        onChange={(e) => setJd(e.target.value)}
        placeholder="Paste the job description here..."
        className="min-h-[88px] w-full rounded-md border border-line-2 bg-bg px-3 py-2 text-[12.5px] text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-accent"
      />
      <div className="mt-1.5 text-right">
        <Button
          size="sm"
          disabled={jd.trim().length < 100}
          onClick={() => onRebuild({ jdText: jd.trim() })}
        >
          Rebuild with pasted JD
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------- Edit tab -------------------------------- */

function EditTab({
  report,
  onRebuild,
}: {
  report: ResumeReport;
  onRebuild: (opts: RebuildOpts) => void;
}) {
  // Working copy of every selected project's bullets; only projects whose
  // text actually differs from the report are sent as overrides.
  const [bullets, setBullets] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(report.projects.map((p) => [p.name, [...p.after]]))
  );
  const [instructions, setInstructions] = useState("");

  const overrides = report.projects
    .filter((p) => {
      const cur = bullets[p.name] ?? [];
      return cur.join("\n") !== p.after.join("\n");
    })
    .map((p) => ({
      name: p.name,
      bullets: (bullets[p.name] ?? []).map((b) => b.trim()).filter(Boolean),
    }));
  const dirty = overrides.length > 0 || instructions.trim().length > 0;

  return (
    <div className="text-[12.5px]">
      <p className="mb-2 text-ink-2">
        Edit any bullet directly - your words win over the LLM&apos;s. Or describe
        the change below and let the model apply it across the resume.
      </p>
      {report.projects.map((p) => (
        <div key={p.name} className="mb-2.5">
          <div className="mb-1 text-[12px] font-semibold text-ink">{p.name}</div>
          {(bullets[p.name] ?? []).map((b, i) => (
            <textarea
              key={i}
              value={b}
              rows={Math.max(1, Math.ceil(b.length / 82))}
              onChange={(e) =>
                setBullets((prev) => {
                  const next = [...(prev[p.name] ?? [])];
                  next[i] = e.target.value;
                  return { ...prev, [p.name]: next };
                })
              }
              className="mb-1 w-full resize-y rounded-md border border-line-2 bg-bg px-2.5 py-1.5 font-mono text-[11.5px] leading-snug text-ink outline-none transition-colors focus:border-accent"
            />
          ))}
        </div>
      ))}
      <div className="rounded-md border border-line-2 bg-bg px-3 py-2.5">
        <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-ink-2">
          <Sparkles className="mb-0.5 mr-1 inline size-3 text-accent" />
          Describe a change
        </div>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder='e.g. "emphasize the distributed-systems work and mention Go in the cache bullet"'
          className="min-h-[52px] w-full resize-y bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-2"
        />
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11.5px] text-ink-2">
          {overrides.length > 0 &&
            `${overrides.length} project${overrides.length > 1 ? "s" : ""} hand-edited · `}
          Rebuilding keeps the current version restorable.
        </span>
        <Button
          size="sm"
          disabled={!dirty}
          onClick={() =>
            onRebuild({
              overrides: overrides.length ? overrides : undefined,
              instructions: instructions.trim() || undefined,
            })
          }
        >
          Rebuild with changes
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------- Dialog --------------------------------- */

export function ResumeReportDialog({
  company,
  short,
  meta,
  onOpenChange,
  onRebuild,
  onRestore,
}: {
  company: string;
  /** Open while non-null. */
  short: string | null;
  meta: ResumeMeta | null;
  onOpenChange: (open: boolean) => void;
  onRebuild: (short: string, opts: RebuildOpts) => void;
  onRestore: (short: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("Preview");
  // Reset to the first tab whenever a different row's report opens.
  const [lastShort, setLastShort] = useState<string | null>(null);
  if (short !== lastShort) {
    setLastShort(short);
    if (short) setTab("Preview");
  }

  const report = meta?.report ?? null;
  const rebuild = (opts: RebuildOpts) => {
    if (short) onRebuild(short, opts);
  };

  return (
    <Dialog open={short !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[680px]">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-baseline gap-x-2">
            {company} - build report
            {report && (
              <span className="text-[11.5px] font-normal text-ink-2 tabular-nums">
                built {fmtBuilt(report.builtAt)}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {!report ? (
          <p className="py-4 text-[13px] text-ink-2">
            No report is stored for this build - it predates build reports.
            Rebuilding will produce one.
          </p>
        ) : (
          <>
            <div className="-mt-1 flex flex-wrap gap-0.5 border-b border-line">
              {TABS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={cn(
                    "cursor-pointer border-b-2 px-2.5 py-1.5 text-[12.5px] font-medium transition-colors",
                    tab === t
                      ? "border-accent text-ink"
                      : "border-transparent text-ink-2 hover:text-ink"
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="max-h-[56vh] overflow-y-auto py-1 pr-1">
              {tab === "Preview" && <PreviewTab report={report} />}
              {tab === "Changes" && <ChangesTab report={report} />}
              {tab === "Selection" && <SelectionTab report={report} />}
              {tab === "Inputs" && <InputsTab report={report} onRebuild={rebuild} />}
              {tab === "Edit" && (
                <EditTab key={short} report={report} onRebuild={rebuild} />
              )}
            </div>
          </>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <span>
            {meta?.prevUrl && short && (
              <Button
                variant="ghost"
                size="sm"
                className="text-ink-2"
                onClick={() => onRestore(short)}
              >
                <RotateCcw className="size-3.5" />
                restore previous version
              </Button>
            )}
          </span>
          <span className="flex gap-1.5">
            {meta?.url && (
              <Button size="sm" asChild>
                <a href={meta.url} target="_blank" rel="noopener noreferrer">
                  <Download className="size-3.5" />
                  Download .docx
                </a>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
