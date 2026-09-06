"use client";

import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  LockKeyhole,
  Plus,
  Search,
  SlidersHorizontal,
  UnlockKeyhole,
} from "lucide-react";
import { toast } from "sonner";
import type { ProfileV2 } from "@/lib/profile";
import {
  addFromLibrary,
  applyCuts,
  compareWithBase,
  copyResume,
  deleteResumeVariant,
  getResume,
  putResume,
  resumeRevision,
  savedResumes,
  undoVariantChange,
  type CutProposal,
  type ResumeEntry,
  type SavedResume,
} from "../../../shared/resume-compose";
import {
  listTailoringJobs,
  suggestCuts,
} from "@/app/(app)/profile/profile-actions";
import {
  fetchBuildStatus,
  fetchResumeMeta,
  requestResumeRebuild,
} from "@/app/(app)/matches-actions";
import type { ResumeMeta } from "@/lib/convex";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DownloadMenu } from "./download-menu";
import { ComposePreview } from "./compose-preview";
import { HeaderEditor } from "./header-editor";
import { SkillsEditor } from "./skills-editor";
import { cn } from "@/lib/utils";

const field =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-accent";
const subtle =
  "rounded-md border border-line bg-surface px-3 py-2 text-xs font-medium text-ink-2 hover:text-ink disabled:opacity-50";
function move<T>(items: T[], index: number, direction: number): T[] {
  const next = [...items],
    target = index + direction;
  if (target < 0 || target >= items.length) return items;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
function OrderButtons({
  name,
  index,
  count,
  onMove,
}: {
  name: string;
  index: number;
  count: number;
  onMove: (direction: number) => void;
}) {
  return (
    <span className="flex shrink-0">
      <button
        className="p-1.5 text-ink-2 disabled:opacity-20"
        disabled={index === 0}
        aria-label={`Move ${name} up`}
        onClick={() => onMove(-1)}
      >
        <ArrowUp className="size-3.5" />
      </button>
      <button
        className="p-1.5 text-ink-2 disabled:opacity-20"
        disabled={index === count - 1}
        aria-label={`Move ${name} down`}
        onClick={() => onMove(1)}
      >
        <ArrowDown className="size-3.5" />
      </button>
    </span>
  );
}
function LockButton({
  locked,
  label,
  onClick,
}: {
  locked: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={locked}
      aria-label={`${locked ? "Unlock" : "Lock"} ${label}`}
      title={
        locked
          ? "Protected from AI rewriting and suggested cuts"
          : "Protect from AI rewriting and suggested cuts"
      }
      className={cn(
        "rounded p-2",
        locked ? "bg-accent/10 text-accent" : "text-ink-2 hover:bg-chip",
      )}
    >
      {locked ? (
        <LockKeyhole className="size-3.5" />
      ) : (
        <UnlockKeyhole className="size-3.5" />
      )}
    </button>
  );
}

export function ComposeEditor({
  profile,
  onChange,
}: {
  profile: ProfileV2;
  onChange: (profile: ProfileV2 | ((current: ProfileV2) => ProfileV2)) => void;
}) {
  const resumes = savedResumes(profile);
  const [selected, setSelected] = useState(() => resumes[0]?.name ?? "base");
  const name = resumes.some((r) => r.name === selected) ? selected : "base";
  const resume = getResume(profile, name);
  const editable = name !== "base";
  const [sectionId, setSectionId] = useState("all");
  const [filter, setFilter] = useState<"all" | "included" | "excluded">("all");
  const [search, setSearch] = useState("");
  const [mobilePreview, setMobilePreview] = useState(false);
  const [pages, setPages] = useState<number | null>(null);
  const [modal, setModal] = useState<
    "new" | "compare" | "cuts" | "tailor" | "delete" | null
  >(null);
  const [newName, setNewName] = useState("");
  const [copyFrom, setCopyFrom] = useState(name);
  const [proposal, setProposal] = useState<CutProposal | null>(null);
  const [accepted, setAccepted] = useState<string[]>([]);
  const [busyCuts, setBusyCuts] = useState(false);
  const entries = resume.sections.flatMap((s) => s.entries);
  const included = entries.filter((e) => e.included);
  const bulletCount = included.reduce(
    (sum, e) => sum + e.bullets.filter((b) => b.included).length,
    0,
  );
  const excludedCount = entries.filter((e) => !e.included).length;
  const change = (next: SavedResume) => onChange(putResume(profile, next));
  const updateEntry = (id: string, edit: (entry: ResumeEntry) => ResumeEntry) =>
    change({
      ...resume,
      sections: resume.sections.map((s) => ({
        ...s,
        entries: s.entries.map((e) => (e.id === id ? edit(e) : e)),
      })),
    });
  const undoable = (next: ProfileV2, message: string) => {
    const before = profile;
    onChange(next);
    toast(message, {
      action: {
        label: "Undo",
        onClick: () =>
          onChange((current) => {
            try {
              return undoVariantChange(current, before, next, name);
            } catch (err) {
              toast.error((err as Error).message);
              return current;
            }
          }),
      },
    });
  };
  const openNew = () => {
    setCopyFrom(name);
    setNewName("");
    setModal("new");
  };
  const requestCuts = async () => {
    setModal("cuts");
    setProposal(null);
    setBusyCuts(true);
    try {
      const result = await suggestCuts(JSON.stringify(profile), name);
      setProposal(result);
      setAccepted(result.cuts.map((c) => c.id));
    } catch (err) {
      toast.error((err as Error).message);
      setModal(null);
    } finally {
      setBusyCuts(false);
    }
  };
  const differences =
    modal === "compare" ? compareWithBase(profile, resume) : [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="mr-1 text-xs text-ink-2">Your resumes</span>
          {["base", ...resumes.map((r) => r.name)].map((v) => (
            <button
              key={v}
              onClick={() => {
                setSelected(v);
                setSectionId("all");
              }}
              aria-pressed={name === v}
              className={cn(
                "max-w-52 truncate rounded-full border px-3 py-1.5 text-xs",
                name === v
                  ? "border-accent bg-accent text-accent-ink"
                  : "border-line bg-surface text-ink-2",
              )}
            >
              {v === "base" ? "Base resume" : v}
            </button>
          ))}
          <button
            className={cn(subtle, "inline-flex items-center gap-1.5")}
            onClick={openNew}
          >
            <Plus className="size-3.5" /> New variant
          </button>
        </div>
        {editable && (
          <button
            className="text-xs text-ink-2 underline underline-offset-4"
            onClick={() => setModal("delete")}
          >
            Delete variant
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-line bg-surface p-4">
        <div>
          <h2 className="text-lg font-semibold text-ink">
            {editable ? name : "Start with your base resume"}
          </h2>
          <p className="mt-1 text-xs text-ink-2">
            {editable
              ? "Choose what belongs. Excluded content stays here for later."
              : "Create a variant to choose entries and bullets. Edit source content in Library."}
          </p>
          <p className="mt-2 text-xs font-medium text-accent">
            {included.length} entries · {bulletCount} bullets ·{" "}
            {pages === null
              ? "Measuring pages…"
              : `${pages} ${pages === 1 ? "page" : "pages"}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            className={subtle}
            onClick={() => setModal("compare")}
            disabled={!editable}
          >
            Compare with base
          </button>
          <button className={subtle} onClick={() => setModal("tailor")}>
            Tailor for a job
          </button>
          <DownloadMenu
            profile={profile}
            variant={name}
            label="Download"
            className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-xs font-semibold text-accent-ink"
          />
        </div>
      </div>
      {pages !== null && pages > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber/30 bg-amber/5 px-4 py-3 text-xs">
          <p className="text-ink">
            This resume fills {pages} pages. Downloads keep all {bulletCount}{" "}
            selected bullets.
          </p>
          <button
            disabled={!editable || busyCuts}
            onClick={() => void requestCuts()}
            className={cn(subtle, "text-amber")}
          >
            Suggest cuts to fit one page
          </button>
        </div>
      )}
      <div className="flex rounded-md border border-line p-1 lg:hidden">
        {[false, true].map((preview) => (
          <button
            key={String(preview)}
            className={cn(
              "flex-1 rounded py-2 text-sm",
              mobilePreview === preview && "bg-accent text-accent-ink",
            )}
            onClick={() => setMobilePreview(preview)}
          >
            {preview ? "Preview" : "Content"}
          </button>
        ))}
      </div>
      <div className="grid min-w-0 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.85fr)] xl:grid-cols-[170px_minmax(0,1fr)_minmax(360px,0.9fr)]">
        <aside
          className={cn(
            "min-w-0 space-y-3 lg:col-span-2 xl:col-span-1",
            mobilePreview && "hidden lg:block",
          )}
        >
          <p className="text-[10px] font-semibold uppercase tracking-widest text-ink-2">
            Sections
          </p>
          <nav
            className="flex flex-wrap gap-1 xl:block xl:space-y-1"
            aria-label="Resume sections"
          >
            <button
              onClick={() => setSectionId("all")}
              className={cn(
                "rounded-md px-3 py-2 text-left text-xs xl:w-full",
                sectionId === "all" ? "bg-accent/10 text-accent" : "text-ink-2",
              )}
            >
              All content
            </button>
            <button
              onClick={() => setSectionId("contact")}
              className={cn(
                "rounded-md px-3 py-2 text-left text-xs xl:w-full",
                sectionId === "contact"
                  ? "bg-accent/10 text-accent"
                  : "text-ink-2",
              )}
            >
              Contact information
            </button>
            {resume.sections.map((s, index) => (
              <div
                key={s.id}
                className={cn(
                  "flex items-center rounded-md",
                  sectionId === s.id && "bg-accent/10",
                )}
              >
                <button
                  className="min-w-0 flex-1 px-3 py-2 text-left text-xs text-ink-2"
                  onClick={() => setSectionId(s.id)}
                >
                  {s.title}
                </button>
                {editable && (
                  <span className="hidden xl:block">
                    <OrderButtons
                      name={s.title}
                      index={index}
                      count={resume.sections.length}
                      onMove={(d) =>
                        change({
                          ...resume,
                          sections: move(resume.sections, index, d),
                        })
                      }
                    />
                  </span>
                )}
              </div>
            ))}
          </nav>
          {editable && (
            <button
              className={cn(subtle, "w-full")}
              onClick={() => {
                const next = addFromLibrary(profile, resume);
                undoable(
                  putResume(profile, next),
                  "New Library content added as excluded",
                );
                setFilter("excluded");
                setSectionId("all");
              }}
            >
              Add from Library
            </button>
          )}
          <p className="hidden text-[11px] leading-relaxed text-ink-2 xl:block">
            A lock keeps wording unchanged during tailoring and protects bullets
            from suggested cuts.
          </p>
        </aside>
        <section
          className={cn("min-w-0", mobilePreview && "hidden lg:block")}
          aria-label="Resume content"
        >
          {!editable ? (
            <div className="rounded-lg border border-dashed border-line p-8 text-center">
              <Copy className="mx-auto mb-3 size-7 text-accent" />
              <h3 className="text-sm font-semibold">
                Make it yours for a role
              </h3>
              <p className="mx-auto mt-2 max-w-xs text-xs leading-relaxed text-ink-2">
                A new variant copies your content, including anything hidden.
                Your base stays available.
              </p>
              <Button className="mt-4" onClick={openNew}>
                Create a variant
              </Button>
            </div>
          ) : (
            <>
              {sectionId === "contact" ? (
                <HeaderEditor
                  header={resume.header}
                  onChange={(header) => change({ ...resume, header })}
                />
              ) : (
                <>
                  <div className="mb-3 flex flex-wrap gap-2">
                    <div className="flex rounded-md border border-line bg-surface p-1">
                      {(["all", "included", "excluded"] as const).map((f) => (
                        <button
                          key={f}
                          className={cn(
                            "rounded px-2.5 py-1.5 text-xs capitalize",
                            filter === f ? "bg-chip text-ink" : "text-ink-2",
                          )}
                          onClick={() => setFilter(f)}
                        >
                          {f}
                          {f === "excluded" ? ` (${excludedCount})` : ""}
                        </button>
                      ))}
                    </div>
                    <label className="flex min-w-32 flex-1 items-center gap-2 rounded-md border border-line bg-surface px-2">
                      <Search className="size-3.5 text-ink-2" />
                      <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Find content"
                        aria-label="Find resume content"
                        className="w-full min-w-0 bg-transparent py-2 text-xs outline-none"
                      />
                    </label>
                  </div>
                  <div className="space-y-5">
                    {resume.sections
                      .filter((s) => sectionId === "all" || sectionId === s.id)
                      .map((section) => (
                        <div key={section.id}>
                          <div className="mb-2 flex items-center justify-between">
                            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-2">
                              {section.title}
                            </h3>
                            <span className="xl:hidden">
                              <OrderButtons
                                name={section.title}
                                index={resume.sections.findIndex(
                                  (s) => s.id === section.id,
                                )}
                                count={resume.sections.length}
                                onMove={(d) =>
                                  change({
                                    ...resume,
                                    sections: move(
                                      resume.sections,
                                      resume.sections.findIndex(
                                        (s) => s.id === section.id,
                                      ),
                                      d,
                                    ),
                                  })
                                }
                              />
                            </span>
                          </div>
                          {section.kind === "skills" ? (
                            <SkillsEditor
                              skills={resume.skills}
                              onChange={(skills) =>
                                change({ ...resume, skills })
                              }
                            />
                          ) : (
                            <div className="space-y-3">
                              {section.entries.map((entry, index) => {
                                if (filter === "included" && !entry.included)
                                  return null;
                                if (
                                  filter === "excluded" &&
                                  entry.included &&
                                  entry.bullets.every((b) => b.included)
                                )
                                  return null;
                                if (
                                  search &&
                                  ![
                                    entry.heading,
                                    ...entry.bullets.map((b) => b.text),
                                  ]
                                    .join(" ")
                                    .toLowerCase()
                                    .includes(search.toLowerCase())
                                )
                                  return null;
                                return (
                                  <article
                                    key={entry.id}
                                    className={cn(
                                      "overflow-hidden rounded-lg border bg-surface",
                                      entry.included
                                        ? "border-line"
                                        : "border-dashed border-line opacity-75",
                                    )}
                                  >
                                    <div className="flex items-center gap-2 border-b border-line px-3 py-3">
                                      <input
                                        type="checkbox"
                                        checked={entry.included}
                                        onChange={(e) =>
                                          updateEntry(entry.id, (current) => ({
                                            ...current,
                                            included: e.target.checked,
                                          }))
                                        }
                                        aria-label={`Include ${entry.heading}`}
                                        className="size-4 shrink-0 accent-accent"
                                      />
                                      <div className="min-w-0 flex-1">
                                        <h4 className="truncate text-sm font-semibold text-ink">
                                          {entry.heading || "Untitled entry"}
                                        </h4>
                                        <p className="mt-0.5 text-[11px] text-ink-2">
                                          {entry.included
                                            ? `${entry.bullets.filter((b) => b.included).length} of ${entry.bullets.length} bullets`
                                            : "Excluded from this resume"}
                                          {entry.locked ? " · Locked" : ""}
                                        </p>
                                      </div>
                                      <LockButton
                                        locked={entry.locked}
                                        label={entry.heading}
                                        onClick={() =>
                                          updateEntry(entry.id, (e) => ({
                                            ...e,
                                            locked: !e.locked,
                                          }))
                                        }
                                      />
                                      <OrderButtons
                                        name={entry.heading}
                                        index={index}
                                        count={section.entries.length}
                                        onMove={(d) =>
                                          change({
                                            ...resume,
                                            sections: resume.sections.map(
                                              (s) =>
                                                s.id === section.id
                                                  ? {
                                                      ...s,
                                                      entries: move(
                                                        s.entries,
                                                        index,
                                                        d,
                                                      ),
                                                    }
                                                  : s,
                                            ),
                                          })
                                        }
                                      />
                                    </div>
                                    <details className="border-b border-line px-3 py-2">
                                      <summary className="cursor-pointer text-[11px] text-ink-2">
                                        Edit heading and dates
                                      </summary>
                                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                                        {(
                                          [
                                            "heading",
                                            "subheading",
                                            "location",
                                            "date",
                                          ] as const
                                        ).map((key) => (
                                          <label
                                            key={key}
                                            className="text-[11px] capitalize text-ink-2"
                                          >
                                            {key}
                                            <input
                                              className={field}
                                              value={entry[key] ?? ""}
                                              onChange={(event) =>
                                                updateEntry(entry.id, (e) => ({
                                                  ...e,
                                                  [key]: event.target.value,
                                                }))
                                              }
                                            />
                                          </label>
                                        ))}
                                      </div>
                                    </details>
                                    <div className="divide-y divide-line">
                                      {entry.bullets.map(
                                        (bullet, bulletIndex) => (
                                          <div
                                            key={bullet.id}
                                            className={cn(
                                              "flex items-start gap-2 px-3 py-3",
                                              !bullet.included && "bg-chip/30",
                                            )}
                                          >
                                            <input
                                              type="checkbox"
                                              checked={bullet.included}
                                              onChange={(event) =>
                                                updateEntry(entry.id, (e) => ({
                                                  ...e,
                                                  bullets: e.bullets.map((b) =>
                                                    b.id === bullet.id
                                                      ? {
                                                          ...b,
                                                          included:
                                                            event.target
                                                              .checked,
                                                        }
                                                      : b,
                                                  ),
                                                }))
                                              }
                                              aria-label={`Include bullet ${bulletIndex + 1} in ${entry.heading}`}
                                              className="mt-2 size-4 shrink-0 accent-accent"
                                            />
                                            <div className="min-w-0 flex-1">
                                              <textarea
                                                value={bullet.text}
                                                rows={Math.max(
                                                  2,
                                                  Math.ceil(
                                                    bullet.text.length / 75,
                                                  ),
                                                )}
                                                aria-label={`Bullet ${bulletIndex + 1} in ${entry.heading}`}
                                                onChange={(event) =>
                                                  updateEntry(
                                                    entry.id,
                                                    (e) => ({
                                                      ...e,
                                                      bullets: e.bullets.map(
                                                        (b) =>
                                                          b.id === bullet.id
                                                            ? {
                                                                ...b,
                                                                text: event
                                                                  .target.value,
                                                              }
                                                            : b,
                                                      ),
                                                    }),
                                                  )
                                                }
                                                className={cn(
                                                  "w-full resize-y rounded bg-transparent px-1 py-1 text-xs leading-relaxed text-ink outline-none focus:ring-1 focus:ring-accent",
                                                  !bullet.included &&
                                                    "text-ink-2",
                                                )}
                                              />
                                              {!bullet.included && (
                                                <span className="text-[10px] text-ink-2">
                                                  Excluded · retained for later
                                                </span>
                                              )}
                                              <OrderButtons
                                                name={`bullet ${bulletIndex + 1} in ${entry.heading}`}
                                                index={bulletIndex}
                                                count={entry.bullets.length}
                                                onMove={(d) =>
                                                  updateEntry(
                                                    entry.id,
                                                    (e) => ({
                                                      ...e,
                                                      bullets: move(
                                                        e.bullets,
                                                        bulletIndex,
                                                        d,
                                                      ),
                                                    }),
                                                  )
                                                }
                                              />
                                            </div>
                                            <LockButton
                                              locked={
                                                entry.locked || bullet.locked
                                              }
                                              label={`bullet ${bulletIndex + 1} in ${entry.heading}`}
                                              onClick={() => {
                                                if (entry.locked)
                                                  toast(
                                                    "Unlock the entry first to change individual bullet locks.",
                                                  );
                                                else
                                                  updateEntry(
                                                    entry.id,
                                                    (e) => ({
                                                      ...e,
                                                      bullets: e.bullets.map(
                                                        (b) =>
                                                          b.id === bullet.id
                                                            ? {
                                                                ...b,
                                                                locked:
                                                                  !b.locked,
                                                              }
                                                            : b,
                                                      ),
                                                    }),
                                                  );
                                              }}
                                            />
                                          </div>
                                        ),
                                      )}
                                    </div>
                                    <button
                                      className="px-4 py-2.5 text-xs text-accent"
                                      onClick={() =>
                                        updateEntry(entry.id, (e) => ({
                                          ...e,
                                          bullets: [
                                            ...e.bullets,
                                            {
                                              id: crypto.randomUUID(),
                                              text: "",
                                              included: true,
                                              locked: false,
                                            },
                                          ],
                                        }))
                                      }
                                    >
                                      + Add bullet
                                    </button>
                                  </article>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      ))}
                  </div>
                </>
              )}
            </>
          )}
        </section>
        <aside
          className={cn(
            "min-w-0 lg:sticky lg:top-5 lg:self-start",
            !mobilePreview && "hidden lg:block",
          )}
          aria-label="Live resume preview"
        >
          <ComposePreview profile={profile} variant={name} onPages={setPages} />
          <p className="mt-2 text-center text-[11px] text-ink-2">
            Exact PDF layout. Word keeps the same selected content.
          </p>
        </aside>
      </div>
      <Dialog
        open={modal !== null && modal !== "tailor"}
        onOpenChange={(open) => {
          if (!open) setModal(null);
        }}
      >
        <DialogContent
          className={cn(
            "max-h-[85dvh] overflow-y-auto sm:max-w-lg",
            modal === "compare" && "sm:max-w-3xl",
          )}
        >
          <DialogHeader>
            <DialogTitle>
              {modal === "new"
                ? "Create a resume variant"
                : modal === "compare"
                  ? "Compare with base"
                  : modal === "delete"
                    ? "Delete this variant?"
                    : "Review suggested cuts"}
            </DialogTitle>
            <DialogDescription>
              {modal === "new"
                ? "Copy the wording, order, selections, and locks. Then make it your own."
                : modal === "compare"
                  ? "Base is on the left. Your selected output is on the right."
                  : modal === "delete"
                    ? "This removes only this saved variant. Library and your other variants stay available."
                    : "Nothing changes until you apply selected cuts. Locked bullets are protected."}
            </DialogDescription>
          </DialogHeader>
          {modal === "new" && (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                try {
                  onChange(copyResume(profile, copyFrom, newName));
                  setSelected(newName.trim());
                  setModal(null);
                } catch (err) {
                  toast.error((err as Error).message);
                }
              }}
            >
              <label className="block text-xs">
                Variant name
                <input
                  autoFocus
                  maxLength={40}
                  required
                  className={cn(field, "mt-1")}
                  placeholder="e.g. Platform engineering"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </label>
              <label className="block text-xs">
                Copy from
                <select
                  className={cn(field, "mt-1")}
                  value={copyFrom}
                  onChange={(e) => setCopyFrom(e.target.value)}
                >
                  {["base", ...resumes.map((r) => r.name)].map((v) => (
                    <option key={v} value={v}>
                      {v === "base" ? "Base resume" : v}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit">
                <Copy className="size-4" /> Create variant
              </Button>
            </form>
          )}
          {modal === "delete" && (
            <Button
              variant="destructive"
              onClick={() => {
                undoable(deleteResumeVariant(profile, name), "Variant deleted");
                setModal(null);
              }}
            >
              Delete {name}
            </Button>
          )}
          {modal === "compare" &&
            (differences.length ? (
              <div className="space-y-5">
                {differences.map((d, index) => (
                  <div key={index}>
                    <h3 className="mb-2 text-sm font-semibold">{d.heading}</h3>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {[d.before, d.after].map((lines, side) => (
                        <div
                          key={side}
                          className={cn(
                            "rounded-md border border-line p-3 text-xs leading-relaxed",
                            side === 1 && "bg-accent/5",
                          )}
                        >
                          <p className="mb-2 text-[10px] uppercase text-ink-2">
                            {side ? name : "Base"}
                          </p>
                          {lines.length ? (
                            lines.map((line, i) => (
                              <p key={i} className="mb-1 break-words">
                                {line}
                              </p>
                            ))
                          ) : (
                            <p className="text-ink-2">Excluded</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-5 text-sm text-ink-2">
                Selected content and order match base.
              </p>
            ))}
          {modal === "cuts" &&
            (busyCuts ? (
              <p className="py-6 text-sm text-ink-2" role="status">
                Measuring possible cuts against the actual PDF…
              </p>
            ) : (
              proposal && (
                <div className="space-y-4">
                  <p className="text-sm">
                    {proposal.beforePages} pages now · {proposal.afterPages}{" "}
                    {proposal.afterPages === 1 ? "page" : "pages"} with all
                    suggested cuts
                  </p>
                  {proposal.afterPages > 1 && (
                    <p className="text-xs text-amber">
                      These cuts do not reach one page. Keep the extra pages, or
                      review your remaining entries manually.
                    </p>
                  )}
                  {proposal.cuts.map((c) => (
                    <label
                      key={c.id}
                      className="flex gap-3 rounded-md border border-line p-3"
                    >
                      <input
                        type="checkbox"
                        checked={accepted.includes(c.id)}
                        onChange={(e) =>
                          setAccepted((ids) =>
                            e.target.checked
                              ? [...ids, c.id]
                              : ids.filter((id) => id !== c.id),
                          )
                        }
                        className="mt-1 accent-accent"
                      />
                      <span className="text-xs">
                        <strong className="mb-1 block">{c.heading}</strong>
                        {c.text}
                        <span className="mt-2 block text-ink-2">
                          {c.reason}
                        </span>
                      </span>
                    </label>
                  ))}
                  <Button
                    disabled={
                      !accepted.length ||
                      proposal.revision !== resumeRevision(resume)
                    }
                    onClick={() => {
                      try {
                        undoable(
                          putResume(
                            profile,
                            applyCuts(resume, proposal, accepted),
                          ),
                          "Selected cuts applied",
                        );
                        setModal(null);
                      } catch (err) {
                        toast.error((err as Error).message);
                      }
                    }}
                  >
                    <Check className="size-4" /> Apply {accepted.length}{" "}
                    selected cuts
                  </Button>
                  <p className="text-xs text-ink-2">
                    The preview recalculates after applying your selection.
                  </p>
                </div>
              )
            ))}
        </DialogContent>
      </Dialog>
      <TailorDialog
        key={name}
        open={modal === "tailor"}
        onClose={() => setModal(null)}
        profile={profile}
        variant={name}
      />
    </div>
  );
}

function TailorDialog({
  open,
  onClose,
  profile,
  variant,
}: {
  open: boolean;
  onClose: () => void;
  profile: ProfileV2;
  variant: string;
}) {
  const [jobs, setJobs] = useState<
    Awaited<ReturnType<typeof listTailoringJobs>>
  >([]);
  const [short, setShort] = useState("");
  const [instructions, setInstructions] = useState("");
  const [status, setStatus] = useState<
    "idle" | "requesting" | "building" | "ready"
  >("idle");
  const [error, setError] = useState("");
  const [meta, setMeta] = useState<ResumeMeta | null>(null);
  const [load, setLoad] = useState(0);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void listTailoringJobs()
      .then((result) => {
        if (live) setJobs(result);
      })
      .catch((err) => {
        if (live) setError(err.message);
      });
    return () => {
      live = false;
    };
  }, [open, load]);
  useEffect(() => {
    if (status !== "building") return;
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await fetchBuildStatus(short);
        if (!live) return;
        if (typeof result === "object" && result?.status === "failed") {
          setError(result.error || "Build failed.");
          setStatus("idle");
          return;
        }
        if (result === null) {
          const data = await fetchResumeMeta(short);
          if (live) {
            setMeta(data);
            setStatus("ready");
          }
          return;
        }
      } catch (err) {
        if (live) setError((err as Error).message);
      }
      if (live) timer = setTimeout(() => void poll(), 2500);
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [status, short]);
  const build = async () => {
    setError("");
    setStatus("requesting");
    setMeta(null);
    try {
      const result = await requestResumeRebuild(short, {
        variant,
        instructions,
        profileSnapshot: JSON.stringify(profile),
      });
      if (!result.ok) throw new Error(result.error || "Build failed.");
      setStatus("building");
    } catch (err) {
      setError((err as Error).message);
      setStatus("idle");
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Tailor {variant} for a job</DialogTitle>
          <DialogDescription>
            The build uses this exact selection. AI can revise unlocked bullets.
            Your saved variant stays as written.
          </DialogDescription>
        </DialogHeader>
        {status === "ready" && meta ? (
          <div className="space-y-3">
            <p className="text-sm text-accent">
              Resume ready
              {meta.report?.pageCount
                ? ` · ${meta.report.pageCount} pages`
                : ""}
            </p>
            <div className="flex gap-3">
              <a
                className={subtle}
                href={meta.url}
                target="_blank"
                rel="noreferrer"
              >
                Open PDF
              </a>
              {meta.docxUrl && (
                <a
                  className={subtle}
                  href={meta.docxUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Download Word
                </a>
              )}
            </div>
            {meta.report?.notes.map((note, i) => (
              <p key={i} className="text-xs text-ink-2">
                {note}
              </p>
            ))}
            <button className={subtle} onClick={() => setStatus("idle")}>
              Tailor again
            </button>
          </div>
        ) : (
          <>
            <label className="text-xs">
              Choose a tracked job
              <select
                disabled={status !== "idle"}
                className={cn(field, "mt-1")}
                value={short}
                onChange={(e) => setShort(e.target.value)}
              >
                <option value="">Select a job</option>
                {jobs.map((job) => (
                  <option key={job.short} value={job.short}>
                    {job.company} · {job.title}
                  </option>
                ))}
              </select>
            </label>
            {!jobs.length && (
              <p className="text-xs text-ink-2">
                Your tracked jobs appear here.{" "}
                <button
                  className="underline"
                  onClick={() => setLoad((n) => n + 1)}
                >
                  Refresh jobs
                </button>
              </p>
            )}
            <label className="text-xs">
              Guidance, optional
              <textarea
                disabled={status !== "idle"}
                maxLength={1000}
                rows={3}
                className={cn(field, "mt-1")}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="Emphasize backend ownership and performance work"
              />
            </label>
            <Button
              disabled={!short || status !== "idle"}
              onClick={() => void build()}
            >
              <SlidersHorizontal className="size-4" />
              {status !== "idle" ? "Building resume…" : "Build tailored resume"}
            </Button>
            <p className="text-xs text-ink-2">
              This replaces the job&apos;s current generated resume and keeps
              its previous version.
            </p>
          </>
        )}
        {error && (
          <p role="alert" className="text-xs text-red">
            {error}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
