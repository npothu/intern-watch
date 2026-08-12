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

import { useEffect, useMemo, useState } from "react";
import { Download, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { removeResume } from "@/app/(app)/matches-actions";
import { fetchProfile } from "@/app/(app)/profile/profile-actions";
import { variantsOf, type ProfileV2 } from "@/lib/profile";
import type { ResumeMeta, ResumeReport } from "@/lib/convex";

export type RebuildOpts = {
  jdText?: string;
  instructions?: string;
  overrides?: { name: string; bullets: string[] }[];
  /** The forced bullet variant, undefined = Auto (per-project JD pick). */
  variant?: string;
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

/**
 * The text-outline miniature. This is the FALLBACK: it is exact about content
 * and silent about layout, so it only runs when the real document cannot be
 * rendered (no stored artifact yet, or docx-preview failed on it).
 */
function OutlineMiniature({ report }: { report: ResumeReport }) {
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
        Text outline of the build - highlighted lines were tailored for this
        job. Download the .docx to check its layout.
      </p>
    </div>
  );
}

function PreviewTab({
  report,
  url,
}: {
  report: ResumeReport;
  /** The stored PDF. Legacy DOCX builds fall back to the text outline. */
  url?: string;
}) {
  // A build made before the resume header was filled in renders an outline of
  // nothing but empty strings, which paints a blank white rectangle that looks
  // like a broken component. Say what actually happened instead.
  const hasText = report.outline.some((l) => l.trim().length > 0);
  if (!hasText) {
    return (
      <div className="rounded-md border border-amber/45 bg-amber/10 px-3 py-2.5">
        <p className="text-[12px] text-amber">
          This build produced an empty document - it ran before your resume had a name and
          contact line, so there was nothing to render.
        </p>
        <p className="mt-1 text-[11.5px] text-ink-2">
          Fill in Personal info on the Resume page, then rebuild from the Edit tab.
        </p>
      </div>
    );
  }

  if (url) {
    return (
      <iframe
        src={`${url}#toolbar=0&navpanes=0&view=FitH`}
        title="Generated resume PDF preview"
        className="h-[720px] w-full rounded-md border border-line bg-white"
      />
    );
  }

  return (
    <div>
      <OutlineMiniature report={report} />
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
  variants,
}: {
  report: ResumeReport;
  onRebuild: (opts: RebuildOpts) => void;
  /** Every variant the profile defines, "base" first. */
  variants: string[];
}) {
  // Working copy of every selected project's bullets; only projects whose
  // text actually differs from the report are sent as overrides.
  const [bullets, setBullets] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(report.projects.map((p) => [p.name, [...p.after]]))
  );
  const [instructions, setInstructions] = useState("");
  // "" means Auto (no override), matching RebuildOpts.variant === undefined.
  const [forcedVariant, setForcedVariant] = useState("");

  const overrides = report.projects
    .filter((p) => {
      const cur = bullets[p.name] ?? [];
      return cur.join("\n") !== p.after.join("\n");
    })
    .map((p) => ({
      name: p.name,
      bullets: (bullets[p.name] ?? []).map((b) => b.trim()).filter(Boolean),
    }));
  // A variant override counts as a change on its own - otherwise picking one
  // and pressing nothing else would leave Rebuild disabled with no explanation.
  const dirty =
    overrides.length > 0 || instructions.trim().length > 0 || forcedVariant !== "";

  return (
    <div className="text-[12.5px]">
      <p className="mb-2 text-ink-2">
        Edit any bullet directly - your words win over the LLM&apos;s. Or describe
        the change below and let the model apply it across the resume.
      </p>

      {/* Variant override. Only worth showing when the profile actually has a
          second variant - a lone "base" makes the control a decoy. */}
      {variants.length > 1 && (
        <div className="mb-3 min-w-0 border-b border-line pb-3">
          <label className="mb-1 block text-[11.5px] font-medium text-ink-2">
            Variant
          </label>
          <select
            value={forcedVariant}
            aria-label="Bullet variant to build with"
            onChange={(e) => setForcedVariant(e.target.value)}
            className="w-full min-w-0 rounded-md border border-line-2 bg-bg px-2.5 py-1.5 text-[12.5px] text-ink outline-none transition-colors focus:border-accent"
          >
            <option value="">Auto (best match per project)</option>
            {variants.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-ink-2">
            Auto picks the best-scoring variant for each project. Choosing one forces it
            everywhere, falling back to base where a project has no bullets for it.
          </p>
        </div>
      )}
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
              variant: forcedVariant || undefined,
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Reset to the first tab whenever a different row's report opens.
  const [lastShort, setLastShort] = useState<string | null>(null);
  if (short !== lastShort) {
    setLastShort(short);
    if (short) setTab("Preview");
    // Never carry an armed delete across rows - the confirm belongs to the
    // build that was on screen when it was armed.
    setConfirmDelete(false);
  }

  // The variant list comes from the saved profile, not from the report: the
  // report only records the variants a past build happened to pick, so relying
  // on it would hide the very variant the user wants to switch TO.
  const [variants, setVariants] = useState<string[]>(["base"]);
  useEffect(() => {
    if (!short) return;
    let cancelled = false;
    void fetchProfile().then((res) => {
      if (cancelled || !res.ok || !res.data) return;
      try {
        setVariants(variantsOf(JSON.parse(res.data) as ProfileV2));
      } catch {
        // A malformed profile just leaves the default ["base"]; the rebuild
        // still works, it simply offers no override.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [short]);

  const report = meta?.report ?? null;
  const rebuild = (opts: RebuildOpts) => {
    if (short) onRebuild(short, opts);
  };

  const onDelete = async () => {
    if (!short) return;
    setDeleting(true);
    try {
      const res = await removeResume(short);
      if (res.ok) {
        toast.success("Resume deleted");
        onOpenChange(false);
      } else {
        toast.error(res.error);
      }
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <Dialog open={short !== null} onOpenChange={onOpenChange}>
      {/* Wide enough that a US Letter page (8.5in = 816px) renders at ~100% in
          the Preview tab instead of being shrunk to illegibility.
          The `sm:` prefix is required, not decorative: DialogContent's base
          class is `sm:max-w-sm`, and tailwind-merge does not let an unprefixed
          `max-w-*` override a breakpoint-prefixed one, so a plain
          `max-w-[880px]` here silently lost and the dialog stayed 336px. */}
      <DialogContent className="sm:max-w-[880px]">
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
              {tab === "Preview" && (
                <PreviewTab
                  key={short}
                  report={report}
                  url={meta?.format === "pdf" ? meta.url : undefined}
                />
              )}
              {tab === "Changes" && <ChangesTab report={report} />}
              {tab === "Selection" && <SelectionTab report={report} />}
              {tab === "Inputs" && <InputsTab report={report} onRebuild={rebuild} />}
              {tab === "Edit" && (
                <EditTab key={short} report={report} onRebuild={rebuild} variants={variants} />
              )}
            </div>
          </>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <span className="flex flex-wrap items-center gap-1.5">
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
            {/* Destructive action, kept on the far left away from Download and
                Close. The confirm is inline rather than window.confirm, which
                blocks the page and cannot be styled. */}
            {short && meta?.url && (
              confirmDelete ? (
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11.5px] text-ink-2">Delete this build?</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-red"
                    disabled={deleting}
                    onClick={onDelete}
                  >
                    {deleting ? "Deleting..." : "Delete"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-ink-2"
                    disabled={deleting}
                    onClick={() => setConfirmDelete(false)}
                  >
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 className="size-3.5" />
                  Delete
                </Button>
              )
            )}
          </span>
          <span className="flex gap-1.5">
            {meta?.format === "pdf" && meta.docxUrl && (
              <Button variant="outline" size="sm" asChild>
                <a
                  href={meta.docxUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  download={meta.docxFilename ?? undefined}
                >
                  <Download className="size-3.5" />
                  Download DOCX
                </a>
              </Button>
            )}
            {meta?.url && (
              <Button size="sm" asChild>
                <a
                  href={meta.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  download={meta.filename}
                >
                  <Download className="size-3.5" />
                  {meta.format === "pdf" ? "Download PDF" : "Download DOCX"}
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
