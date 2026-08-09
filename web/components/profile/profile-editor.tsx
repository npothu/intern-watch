"use client";

// The resume editor, rebuilt around the v2 profile shape. It owns the working
// copy of the profile (header, skills blob, and the ordered sections list) and
// only talks to the server through the profile server actions.
//
// 1) THE VARIANT-WRITE RULE
// -------------------------
// Bullets live at `entry.bullets[variant]`, falling back to "base". The rule
// that makes targeted (non-base) resumes safe is enforced in entry-card.tsx's
// `bulletsForEdit`: on the FIRST edit of a variant that has no array yet, it
// seeds `bullets[variant]` by COPYING `bullets.base` into a brand-new array,
// and every bullet writeback is `{ ...e.bullets, [variant]: next }`, which
// never touches `bullets.base` unless variant === "base". This file owns the
// `variant` state and passes it down to every EntryCard, so a brand-new
// variant only "exists" (appears in variantsOf) once some entry actually owns
// a bullets key for it - exactly what the "+" variant button relies on.
//
// 2) THE AUTOSAVE RULE
// --------------------
// There is no manual Save button and no broad "unsaved changes" beforeunload
// warning. Every edit schedules a save debounced 1200ms after the LAST edit;
// the indicator only shows "Saving..." once a network call is actually in
// flight. On failure it retries the same save once, then gives up with a
// toast. A beforeunload guard still exists but only fires while a save is
// genuinely in flight (between "Saving..." starting and it resolving), not
// for generic unsaved keystrokes.

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Eye, EyeOff, Plus, X } from "lucide-react";
import type { Variant } from "@/lib/profile";
import {
  blankEntry,
  blankProfile,
  newId,
  SECTION_KINDS,
  variantsOf,
  type Entry,
  type ProfileV2,
  type Section,
  type SectionKind,
} from "@/lib/profile";
import {
  fetchProfile,
  saveProfile,
  upgradeProfile,
} from "@/app/(app)/profile/profile-actions";
import { SectionRail, PERSONAL_INFO_ID } from "@/components/profile/section-rail";
import { HeaderEditor } from "@/components/profile/header-editor";
import { EntryCard } from "@/components/profile/entry-card";
import { SkillsEditor } from "@/components/profile/skills-editor";
import { ResumePreview } from "@/components/profile/resume-preview";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DEBOUNCE_MS = 1200;
const RETRY_MS = 3000;
const SAVE_TICK_MS = 10000;
const PREVIEW_KEY = "iw:resume:preview";
const PREVIEW_EVENT = "iw:resume:preview-toggle";

const CARD = "rounded-md border border-line bg-surface px-4 py-3";
const CHIP =
  "rounded-full bg-chip px-2 py-0.5 text-[10.5px] font-semibold text-ink-2";
// max-w + truncate: variant names are free-text (the "+" prompt has no length
// limit), so a pathologically long name must not force the pill row wider
// than the viewport.
const VAR_PILL =
  "max-w-[110px] min-w-0 truncate border-r border-line px-2.5 py-1 text-[11.5px] font-medium text-ink-2 transition-colors last:border-r-0 hover:text-ink";
const VAR_PILL_ACTIVE = "bg-accent text-accent-ink font-semibold";

const BUILD_BUTTON_TITLE =
  "Start a build from a specific match instead - a resume is built per job, not from this page";

const ADD_LABEL: Record<SectionKind, string> = {
  education: "Add school",
  experience: "Add job",
  projects: "Add project",
  community: "Add entry",
  custom: "Add entry",
  skills: "Add entry",
};

type ParseOutcome =
  | { status: "ok"; profile: ProfileV2 }
  | { status: "invalid" } // JSON parse failed - treat like no profile.
  | { status: "upgrade" }; // Parsed but not version 2 - migrate upstream.

/**
 * Parse stored JSON defensively. saveProfile already validates JSON
 * server-side, but we never let a parse throw crash the component: a broken
 * string degrades to the empty state (same as no profile), and a non-v2
 * (pre-migration) object routes to the upgrade notice instead.
 */
function parseV2(data: string | null): ParseOutcome {
  if (data === null) return { status: "invalid" };
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { version?: unknown }).version === 2
    ) {
      return { status: "ok", profile: parsed as ProfileV2 };
    }
    return { status: "upgrade" };
  } catch {
    return { status: "invalid" };
  }
}

/** Move the item at `from` to `to` in a copy (never mutates the input). */
function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

// ---- preview toggle: a tiny external store backed by localStorage ----------
// The preview boolean is read out of localStorage under `iw:resume:preview`
// (default on). useSyncExternalStore is the right tool here: it reads a stable
// server snapshot (true) and, after hydration, swaps to the stored value
// without a hydration mismatch, and it re-renders when the value changes.

function subscribePreview(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  window.addEventListener(PREVIEW_EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(PREVIEW_EVENT, callback);
  };
}

function getPreviewSnapshot(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return localStorage.getItem(PREVIEW_KEY) !== "0";
  } catch {
    return true;
  }
}

export function ProfileEditor(props: {
  initialData: string | null;
  user: string;
}) {
  // Parse the incoming JSON once, defensively, into a stable initial outcome.
  // This is a plain state value (not a ref) so it is safe to read while
  // rendering; it never changes after mount.
  const [outcome] = useState(() => parseV2(props.initialData));
  const [profile, setProfile] = useState<ProfileV2 | null>(
    outcome.status === "ok" ? outcome.profile : null
  );

  const [activeId, setActiveId] = useState<string | null>(() => {
    if (outcome.status !== "ok") return null;
    // Default to the first concrete section (education, experience, ...) so
    // the default view is a real editor rather than the skills blob.
    return (
      outcome.profile.sections.find((s) => s.kind !== "skills")?.id ?? null
    );
  });
  const [openEntries, setOpenEntries] = useState<Record<string, boolean>>({});
  const [addingVariant, setAddingVariant] = useState(false);
  const [variantDraft, setVariantDraft] = useState("");
  const [variant, setVariant] = useState<Variant>("base");
  const [saveState, setSaveState] = useState<
    "idle" | "saving" | "retrying" | "not-saved"
  >("idle");
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const previewOn = useSyncExternalStore(
    subscribePreview,
    getPreviewSnapshot,
    () => true
  );

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One-shot guard for the migration gate - not render state, just "did we
  // already ask the server to upgrade?" (mirrors a state flag without the
  // synchronous setState-in-effect the lint would flag).
  const upgradedRef = useRef(false);

  const togglePreview = () => {
    const next = !previewOn;
    try {
      localStorage.setItem(PREVIEW_KEY, next ? "1" : "0");
    } catch {
      /* ignore - the in-memory toggle still works. */
    }
    window.dispatchEvent(new Event(PREVIEW_EVENT));
  };

  // attemptSave: perform one network save. On failure it records the snapshot
  // in a ref and flips to "retrying"; an effect below schedules exactly one
  // retry 3s later, and if the retry also fails it shows a toast and falls back
  // to "Not saved" (no more automatic retries - the next edit will schedule a
  // fresh save through the debounce path). Using useCallback([]) keeps it
  // stable for effects and avoids the lint's "self-reference" immutability
  // error; the retry is scheduled by an effect rather than by attemptSave
  // calling itself.
  const pendingRetry = useRef<ProfileV2 | null>(null);
  const attemptSave = useCallback((snapshot: ProfileV2, isRetry: boolean) => {
    setSaveState("saving");
    saveProfile(JSON.stringify(snapshot, null, 2))
      .then((res) => {
        if (res.ok) {
          pendingRetry.current = null;
          setLastSavedAt(Date.now());
          setSaveState("idle");
          return;
        }
        if (!isRetry) {
          pendingRetry.current = snapshot;
          setSaveState("retrying");
        } else {
          pendingRetry.current = null;
          setSaveState("not-saved");
          toast.error(res.error || "Couldn't save your changes.");
        }
      })
      .catch((err: unknown) => {
        if (!isRetry) {
          pendingRetry.current = snapshot;
          setSaveState("retrying");
        } else {
          pendingRetry.current = null;
          setSaveState("not-saved");
          toast.error((err as Error).message || "Couldn't save your changes.");
        }
      });
  }, []);

  // One retry, 3s after a failed first attempt, of the SAME snapshot. When the
  // user edits while retrying, the saveState flips to "saving" and this timer's
  // cleanup clears the pending retry.
  useEffect(() => {
    if (saveState !== "retrying") return;
    const timer = setTimeout(() => {
      const snap = pendingRetry.current;
      if (snap) attemptSave(snap, true);
    }, RETRY_MS);
    return () => clearTimeout(timer);
  }, [saveState, attemptSave]);

  // Debounced autosave: reset the timer on every edit (a ref-held timeout, not
  // a naive effect that fires per keystroke). The effect re-runs on each
  // profile change and clears the prior timer, so the closure always captures
  // the LATEST profile - no ref-with-latest needed.
  useEffect(() => {
    if (!profile) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      attemptSave(profile, false);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [profile, attemptSave]);

  // Leave no dangling timers on unmount.
  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  // beforeunload: fire ONLY while a save is genuinely in flight (saving or
  // the scheduled retry). Generic unsaved keystrokes never warn.
  useEffect(() => {
    if (saveState !== "saving" && saveState !== "retrying") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [saveState]);

  // Ticker re-renders "Saved Ns ago" every 10s while we have a timestamp.
  useEffect(() => {
    if (lastSavedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), SAVE_TICK_MS);
    return () => clearInterval(id);
  }, [lastSavedAt]);

  // One-shot migration gate: only when stored data exists but is not v2. The
  // client must not migrate in the browser - it asks the server action and, on
  // success, refetches and parses THAT result into local state directly (the
  // prop won't update because nothing here re-renders the server component).
  useEffect(() => {
    if (outcome.status !== "upgrade" || upgradedRef.current) return;
    upgradedRef.current = true;
    void upgradeProfile().then(async (res) => {
      if (res.ok) {
        const again = await fetchProfile();
        if (again.ok && again.data) {
          const parsed = parseV2(again.data);
          if (parsed.status === "ok") {
            setProfile(parsed.profile);
            setActiveId(
              parsed.profile.sections.find((s) => s.kind !== "skills")?.id ??
                null
            );
          }
        }
      } else {
        toast.error(res.error);
      }
    });
  }, [outcome]);

  const variants = profile ? variantsOf(profile) : ["base"];
  const activeIndex = profile
    ? profile.sections.findIndex((s) => s.id === activeId)
    : -1;
  const activeSection = activeIndex >= 0 ? profile!.sections[activeIndex] : null;

  // ---- state mutation helpers (never mutate in place) -------------------

  const updateSection = (index: number, updater: (s: Section) => Section) => {
    setProfile((p) => {
      if (!p) return p;
      return {
        ...p,
        sections: p.sections.map((s, i) => (i === index ? updater(s) : s)),
      };
    });
  };

  const patchActive = (updater: (s: Section) => Section) => {
    if (activeIndex < 0) return;
    updateSection(activeIndex, updater);
  };

  const updateActiveEntry = (i: number, updater: (e: Entry) => Entry) => {
    patchActive((s) => ({
      ...s,
      entries: s.entries.map((e, idx) => (idx === i ? updater(e) : e)),
    }));
  };

  const moveActiveEntry = (from: number, to: number) => {
    patchActive((s) => ({ ...s, entries: moveItem(s.entries, from, to) }));
  };

  const updateSkills = (skills: ProfileV2["skills"]) => {
    setProfile((p) => (p ? { ...p, skills } : p));
  };

  // ---- section rail handlers --------------------------------------------

  const handleReorderSections = (from: number, to: number) => {
    setProfile((p) =>
      p ? { ...p, sections: moveItem(p.sections, from, to) } : p
    );
  };

  const handleRenameSection = (id: string, title: string) => {
    setProfile((p) =>
      p
        ? {
            ...p,
            sections: p.sections.map((s) =>
              s.id === id ? { ...s, title } : s
            ),
          }
        : p
    );
  };

  const handleAddSection = (kind: SectionKind, title?: string) => {
    const section: Section = {
      id: newId(kind),
      title:
        title ??
        SECTION_KINDS.find((k) => k.kind === kind)?.defaultTitle ??
        "Custom",
      kind,
      entries: [],
    };
    setProfile((p) => (p ? { ...p, sections: [...p.sections, section] } : p));
    setActiveId(section.id);
  };

  const handleDeleteSection = (id: string) => {
    const index = profile?.sections.findIndex((s) => s.id === id) ?? -1;
    const section = index >= 0 ? profile!.sections[index] : undefined;
    if (!section) return;

    setProfile((p) =>
      p ? { ...p, sections: p.sections.filter((s) => s.id !== id) } : p
    );
    // If the active section was deleted, select a sensible replacement: the
    // one now at the same index, else the first remaining one.
    if (activeId === id) {
      const remaining = profile!.sections.filter((s) => s.id !== id);
      const next = remaining[index] ?? remaining[0];
      setActiveId(next?.id ?? null);
    }
    toast("Section deleted", {
      action: {
        label: "Undo",
        onClick: () =>
          setProfile((p) => {
            if (!p) return p;
            const sections = [...p.sections];
            sections.splice(Math.min(index, sections.length), 0, section);
            return { ...p, sections };
          }),
      },
    });
  };

  // ---- centre-column entry handlers -------------------------------------

  const handleAddEntry = () => {
    if (!activeSection) return;
    const entry = blankEntry(activeSection.kind);
    patchActive((s) => ({ ...s, entries: [...s.entries, entry] }));
    // Open the fresh card immediately so the user sees fields to fill in.
    setOpenEntries((o) => ({ ...o, [entry.id]: true }));
  };

  const handleDeleteEntry = (entry: Entry, entryIndex: number) => {
    const sectionIndex = activeIndex;
    if (sectionIndex < 0) return;
    setProfile((p) => {
      if (!p) return p;
      return {
        ...p,
        sections: p.sections.map((s, i) =>
          i === sectionIndex
            ? { ...s, entries: s.entries.filter((e) => e.id !== entry.id) }
            : s
        ),
      };
    });
    // Capture entry and index before removing so Undo is exact.
    toast("Entry deleted", {
      action: {
        label: "Undo",
        onClick: () =>
          setProfile((p) => {
            if (!p) return p;
            return {
              ...p,
              sections: p.sections.map((s, i) => {
                if (i !== sectionIndex) return s;
                const entries = [...s.entries];
                entries.splice(entryIndex, 0, entry);
                return { ...s, entries };
              }),
            };
          }),
      },
    });
  };

  const handleToggleHidden = (entry: Entry, entryIndex: number) => {
    updateActiveEntry(entryIndex, (e) => {
      const hidden = e.hiddenIn ?? [];
      if (hidden.includes(variant)) {
        // Removing the last item leaves an empty array, which reads the same
        // as "hiddenIn absent" in visibleEntries/bulletsFor.
        return { ...e, hiddenIn: hidden.filter((v) => v !== variant) };
      }
      return { ...e, hiddenIn: [...hidden, variant] };
    });
  };

  // Adding a variant PERSISTS it on profile.variants rather than only flipping
  // local state. Before this, a variant existed solely as a bullets key, so a
  // newly named one was invisible until some entry happened to get a bullet
  // under it - it looked like "adding a variant does nothing", and then one
  // would appear later out of nowhere.
  const commitVariant = () => {
    const name = variantDraft.trim();
    setVariantDraft("");
    setAddingVariant(false);
    if (!name) return;
    if (name.toLowerCase() === "base") {
      toast.error("base always exists - pick another name.");
      return;
    }
    if (variants.some((v) => v.toLowerCase() === name.toLowerCase())) {
      toast.error(`"${name}" already exists.`);
      return;
    }
    setProfile((p) =>
      p ? { ...p, variants: [...(p.variants ?? []), name] } : p
    );
    setVariant(name);
  };

  // Removing a variant drops it from the stored list AND from every entry's
  // bullets, so it stops being resurrected by variantsOf's derived half.
  const handleDeleteVariant = (name: string) => {
    if (name === "base") return;
    const snapshot = profile;
    setProfile((p) => {
      if (!p) return p;
      return {
        ...p,
        variants: (p.variants ?? []).filter((v) => v !== name),
        sections: p.sections.map((s) => ({
          ...s,
          entries: s.entries.map((e) => {
            if (!(name in e.bullets)) return e;
            const bullets = { ...e.bullets };
            delete bullets[name];
            return { ...e, bullets };
          }),
        })),
      };
    });
    if (variant === name) setVariant("base");
    toast(`Variant "${name}" deleted`, {
      action: {
        label: "Undo",
        onClick: () => setProfile(snapshot),
      },
    });
  };

  // ---- rendering ---------------------------------------------------------

  if (outcome.status === "invalid") {
    return (
      <EmptyState
        onStart={() => {
          const blank = blankProfile();
          setProfile(blank);
          // Kick off an immediate save so there is something in Convex right
          // away (not just in memory).
          attemptSave(blank, false);
          setActiveId(
            blank.sections.find((s) => s.kind !== "skills")?.id ?? null
          );
        }}
      />
    );
  }

  if (profile === null) {
    // Stored data exists but is not v2 - we are migrating it server-side.
    return (
      <div className={cn(CARD, "flex items-center gap-3")}>
        <Spinner />
        <span className="text-[13px] text-ink-2">
          This profile is being upgraded
        </span>
      </div>
    );
  }

  const savedText = (() => {
    if (saveState === "saving") return "Saving...";
    if (saveState === "retrying") return "Not saved - retrying";
    if (saveState === "not-saved") return "Not saved";
    if (lastSavedAt !== null) {
      const secs = Math.max(0, Math.floor((now - lastSavedAt) / 1000));
      return `Saved ${secs}s ago`;
    }
    return "Saved";
  })();
  const saveErrored = saveState === "retrying" || saveState === "not-saved";

  return (
    <div className="min-w-0">
      {/* Top bar: heading, variant switcher, save indicator, spacer, toggle. */}
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <h3 className="text-[15px] font-semibold text-ink">Resume</h3>

        {/* Labelled so the pill row is self-describing - unlabelled pills gave
            no clue what they switched. */}
        <span className="text-[11px] font-medium uppercase tracking-wider text-ink-2">
          Variant
        </span>

        <div className="inline-flex overflow-hidden rounded-md border border-line bg-surface">
          {variants.map((v) => (
            <span key={v} className="group/var inline-flex items-center">
              <button
                type="button"
                aria-current={variant === v ? "page" : undefined}
                onClick={() => setVariant(v)}
                className={cn(VAR_PILL, variant === v && VAR_PILL_ACTIVE)}
              >
                {v}
              </button>
              {v !== "base" && variant === v && (
                <button
                  type="button"
                  onClick={() => handleDeleteVariant(v)}
                  aria-label={`Delete variant ${v}`}
                  title={`Delete variant ${v}`}
                  className="border-r border-line bg-accent px-1.5 py-1 text-accent-ink/70 transition-colors last:border-r-0 hover:text-accent-ink"
                >
                  <X className="size-3" />
                </button>
              )}
            </span>
          ))}
          {addingVariant ? (
            <input
              autoFocus
              value={variantDraft}
              placeholder="Name"
              aria-label="New variant name"
              className="w-24 min-w-0 bg-bg px-2 py-1 text-[11.5px] text-ink outline-none placeholder:text-ink-2"
              onChange={(e) => setVariantDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitVariant();
                }
                if (e.key === "Escape") {
                  setAddingVariant(false);
                  setVariantDraft("");
                }
              }}
              onBlur={commitVariant}
            />
          ) : (
            <button
              type="button"
              onClick={() => {
                setVariantDraft("");
                setAddingVariant(true);
              }}
              aria-label="Add variant"
              className={cn(VAR_PILL, "font-semibold")}
            >
              +
            </button>
          )}
        </div>

        <span
          className={cn(
            "inline-flex items-center gap-1 text-[11.5px] tabular-nums",
            saveErrored ? "text-red" : "text-ink-2"
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              saveErrored ? "bg-red" : "bg-accent"
            )}
          />
          {savedText}
        </span>

        <div className="min-w-2 flex-1" />

        <button
          type="button"
          onClick={togglePreview}
          aria-label={previewOn ? "Hide resume preview" : "Show resume preview"}
          title="Toggle resume preview"
          className="hidden items-center gap-1.5 rounded-md border border-line-2 bg-surface px-2.5 py-1 text-[12px] text-ink-2 transition-colors hover:text-ink lg:inline-flex"
        >
          {previewOn ? (
            <Eye className="size-3.5" />
          ) : (
            <EyeOff className="size-3.5" />
          )}
          Preview
        </button>

        <Button disabled title={BUILD_BUTTON_TITLE}>
          Build resume
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[186px_minmax(0,1fr)_232px]">
        <div className="min-w-0">
          <SectionRail
            sections={profile.sections}
            activeId={activeId ?? ""}
            onSelect={setActiveId}
            onReorder={handleReorderSections}
            onRename={handleRenameSection}
            onDelete={handleDeleteSection}
            onAdd={handleAddSection}
            headerIncomplete={
              !profile.header.name.trim() || !profile.header.contact_line.trim()
            }
          />
        </div>

        <div className="min-w-0">
          {activeId === PERSONAL_INFO_ID ? (
            <HeaderEditor
              header={profile.header}
              onChange={(header) => setProfile((p) => (p ? { ...p, header } : p))}
            />
          ) : (
            <>
              {/* Name the variant being edited in the canvas itself. The pill
                  row alone was too easy to lose track of, and editing bullets
                  under the wrong variant is silent and annoying to undo. */}
              <p className="mb-2 text-[11.5px] text-ink-2">
                Editing the{" "}
                {variant === "base" ? (
                  "base variant"
                ) : (
                  <>
                    <span className="font-semibold text-accent">{variant}</span> variant
                  </>
                )}
              </p>
              <SectionBody
                section={activeSection}
                variant={variant}
                skills={profile.skills}
                openEntries={openEntries}
                onToggleOpen={(id) =>
                  setOpenEntries((o) => ({ ...o, [id]: !o[id] }))
                }
                onAddEntry={handleAddEntry}
                onDeleteEntry={handleDeleteEntry}
                onToggleHidden={handleToggleHidden}
                onChangeEntry={updateActiveEntry}
                onMoveEntry={moveActiveEntry}
                onSkillsChange={updateSkills}
              />
            </>
          )}
        </div>

        {previewOn && (
          <div className="hidden min-w-0 lg:block">
            <ResumePreview profile={profile} variant={variant} />
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState({ onStart }: { onStart: () => void }) {
  return (
    <div className={cn(CARD, "max-w-md")}>
      <h2 className="mb-1 text-[13.5px] font-semibold text-ink">
        No profile on file
      </h2>
      <p className="text-[12px] text-ink-2">
        Start from a blank resume and fill it in here, or import one later.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={onStart}>
          <Plus className="size-3.5" />
          Start from scratch
        </Button>
        <Button size="sm" variant="outline" disabled title="Coming soon">
          Import from a resume
        </Button>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span className="inline-block size-4 animate-spin rounded-full border-2 border-line border-t-accent" />
  );
}

function SectionBody({
  section,
  variant,
  skills,
  openEntries,
  onToggleOpen,
  onAddEntry,
  onDeleteEntry,
  onToggleHidden,
  onChangeEntry,
  onMoveEntry,
  onSkillsChange,
}: {
  section: Section | null;
  variant: Variant;
  skills: ProfileV2["skills"];
  openEntries: Record<string, boolean>;
  onToggleOpen: (id: string) => void;
  onAddEntry: () => void;
  onDeleteEntry: (entry: Entry, index: number) => void;
  onToggleHidden: (entry: Entry, index: number) => void;
  onChangeEntry: (index: number, updater: (e: Entry) => Entry) => void;
  onMoveEntry: (from: number, to: number) => void;
  onSkillsChange: (skills: ProfileV2["skills"]) => void;
}) {
  const [, setDragIndex] = useState<number | null>(null);

  const header = (
    <div className="mb-2 flex flex-wrap items-center gap-2.5">
      <span className="min-w-0 truncate text-[14px] font-semibold text-ink">
        {section?.title ?? "Section"}
      </span>
      {section && section.kind !== "skills" && (
        <span className={CHIP}>
          {section.entries.length}{" "}
          {section.entries.length === 1 ? "entry" : "entries"}
        </span>
      )}
      <div className="min-w-2 flex-1" />
      {section && section.kind !== "skills" && (
        <Button size="sm" onClick={onAddEntry}>
          <Plus className="size-3.5" />
          + {ADD_LABEL[section.kind]}
        </Button>
      )}
    </div>
  );

  if (!section) {
    return (
      <div>
        {header}
        <div className={cn(CARD, "text-[12px] text-ink-2")}>
          Nothing selected yet - pick a section from the left.
        </div>
      </div>
    );
  }

  if (section.kind === "skills") {
    return (
      <div>
        {header}
        <SkillsEditor skills={skills} onChange={onSkillsChange} />
      </div>
    );
  }

  return (
    <div>
      {header}
      <div className="space-y-2">
        {section.entries.map((entry, i) => {
          const hidden = (entry.hiddenIn ?? []).includes(variant);
          return (
            <EntryCard
              key={entry.id}
              entry={entry}
              kind={section.kind}
              variant={variant}
              isOpen={!!openEntries[entry.id]}
              onToggleOpen={() => onToggleOpen(entry.id)}
              onChange={(updater) => onChangeEntry(i, updater)}
              onDelete={() => onDeleteEntry(entry, i)}
              onToggleHidden={() => onToggleHidden(entry, i)}
              isHiddenInVariant={hidden}
              moveUp={i > 0 ? () => onMoveEntry(i, i - 1) : undefined}
              moveDown={
                i < section.entries.length - 1
                  ? () => onMoveEntry(i, i + 1)
                  : undefined
              }
              dragHandleProps={{
                draggable: true,
                onDragStart: (e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", String(i));
                  setDragIndex(i);
                },
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const from = Number(e.dataTransfer.getData("text/plain"));
                if (!Number.isNaN(from) && from !== i) onMoveEntry(from, i);
                setDragIndex(null);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
