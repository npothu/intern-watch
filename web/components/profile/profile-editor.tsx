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
  isProfileEmpty,
  newId,
  profileCounts,
  SECTION_KINDS,
  variantsOf,
  type Entry,
  type ProfileCounts,
  type ProfileV2,
  type Section,
  type SectionKind,
} from "@/lib/profile";
import {
  beginResumeImport,
  confirmResumeImport,
  discardResumeImport,
  fetchProfile,
  pollResumeImport,
  saveProfile,
  startResumeImport,
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
// Import mapping polling: the server maps with up to two model calls over an
// 80k-char payload (schedule-then-poll, the resume build's contract), so the
// budget is minutes, not seconds.
const IMPORT_POLL_MS = 2000;
const IMPORT_POLL_TIMEOUT_MS = 180_000;
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

type ImportPreview = {
  profile: ProfileV2;
  unmappedLines: { id: string; text: string }[];
  sections: {
    id: string;
    title: string;
    kind: SectionKind;
    count: number;
  }[];
};

type ResumeImportState =
  | { status: "idle" }
  | { status: "parsing"; filename: string }
  | { status: "review"; filename: string; preview: ImportPreview }
  | { status: "applying"; filename: string }
  | { status: "error"; message: string };

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  const [importState, setImportState] = useState<ResumeImportState>({
    status: "idle",
  });

  const previewOn = useSyncExternalStore(
    subscribePreview,
    getPreviewSnapshot,
    () => true
  );

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const saveGeneration = useRef(0);
  const hasObservedProfile = useRef(false);
  const skipNextDebouncedSave = useRef(false);
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
    const generation = ++saveGeneration.current;
    setSaveState("saving");
    const request = saveQueue.current
      .catch(() => undefined)
      .then(() => saveProfile(JSON.stringify(snapshot, null, 2)));
    saveQueue.current = request.then(
      () => undefined,
      () => undefined
    );
    request
      .then((res) => {
        if (generation !== saveGeneration.current) return;
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
        if (generation !== saveGeneration.current) return;
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
    if (!hasObservedProfile.current) {
      hasObservedProfile.current = true;
      return;
    }
    if (skipNextDebouncedSave.current) {
      skipNextDebouncedSave.current = false;
      return;
    }
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

  const handleImportFile = async (file: File) => {
    setImportState({ status: "parsing", filename: file.name });
    try {
      const begin = await beginResumeImport(file.name, file.size);
      if (!begin.ok) {
        setImportState({ status: "error", message: begin.error });
        return;
      }
      const upload = await fetch(begin.uploadUrl, {
        method: "POST",
        headers: { "Content-Type": begin.contentType },
        body: file,
      });
      if (!upload.ok) {
        const detail = (await upload.text().catch(() => "")).slice(0, 300);
        throw new Error(
          `Resume upload failed (HTTP ${upload.status})${detail ? `: ${detail}` : ""}`
        );
      }
      const uploaded = (await upload.json().catch(() => null)) as {
        storageId?: unknown;
      } | null;
      if (typeof uploaded?.storageId !== "string" || !uploaded.storageId) {
        throw new Error("Convex accepted the resume upload but returned no storage ID.");
      }
      const started = await startResumeImport(uploaded.storageId, file.name);
      if (!started.ok) throw new Error(started.error);
      // The claim scheduled the mapping server-side; poll for its outcome
      // (the add-URL dialog's schedule-then-poll shape). A rejected poll is
      // treated as transient - the timeout is the arbiter.
      const deadline = Date.now() + IMPORT_POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(IMPORT_POLL_MS);
        let status: Awaited<ReturnType<typeof pollResumeImport>>;
        try {
          status = await pollResumeImport();
        } catch {
          continue;
        }
        if (status.status === "ready") {
          setImportState({
            status: "review",
            filename: status.filename,
            preview: status.preview,
          });
          return;
        }
        if (status.status === "failed") {
          setImportState({ status: "error", message: status.error });
          return;
        }
        if (status.status === "none") {
          throw new Error("This import was cancelled. Upload the resume again.");
        }
      }
      // Stop WATCHING, but leave the record and its result alone. The mapping
      // may still be running, and the operator has already been billed for the
      // model calls - discarding it here meant paying twice for the same
      // import. The sweep collects it if it really is dead; reopening the page
      // picks up a result that landed after we stopped looking.
      setImportState({
        status: "error",
        message:
          "Still mapping after 3 minutes, so this stopped waiting - the import may still finish. Reopen this page shortly to check before uploading again. Adding your own API key in Settings avoids the shared model's queue.",
      });
      // Returning here deliberately skips the catch below, which discards the
      // upload. That is the point: the record must survive.
      return;
    } catch (error) {
      // A claimed upload must not outlive a failed import: the server sweeps
      // abandoned claims eventually, but the common failures (transport error,
      // the timeout above) are cleaned up right here.
      void discardResumeImport();
      setImportState({
        status: "error",
        message:
          error instanceof Error && error.message
            ? error.message
            : "Couldn't import this resume.",
      });
    }
  };

  const handleCancelImport = () => {
    // Cancel and dismiss also drop the server-side pending record (its blob is
    // already gone once mapping settled, but the record should not linger).
    void discardResumeImport();
    setImportState({ status: "idle" });
  };

  const handleConfirmImport = async () => {
    if (importState.status !== "review") return;
    const imported = importState.preview.profile;
    // The pre-import profile, held for the Undo toast (the delete-variant
    // pattern) while the server parks its own copy in profileBackups.
    const previous = profile;
    setImportState({ status: "applying", filename: importState.filename });
    // Ride the same save queue attemptSave uses so an autosave already in
    // flight cannot land AFTER the import and quietly resurrect the old
    // profile; bumping the generation mutes that save's state callbacks.
    saveGeneration.current++;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    // Flush whatever was still pending BEFORE the server snapshots. Clearing
    // the timer without saving meant an edit made in the last ~1.2s never
    // reached Convex, so the backup taken moments later captured the version
    // WITHOUT it - the edit then existed nowhere, live or backed up, which is
    // the exact loss profileBackups was added to prevent.
    const pending = pendingRetry.current ?? previous;
    pendingRetry.current = null;
    const request = saveQueue.current
      .catch(() => undefined)
      .then(async () => {
        if (pending) {
          // Best effort: a failure here still leaves the pre-import profile in
          // the backup, so the import is not blocked by an unsaved keystroke.
          await saveProfile(JSON.stringify(pending, null, 2)).catch(() => undefined);
        }
        return confirmResumeImport(JSON.stringify(imported, null, 2));
      });
    saveQueue.current = request.then(
      () => undefined,
      () => undefined
    );
    let res: Awaited<typeof request>;
    try {
      res = await request;
    } catch (error) {
      res = {
        ok: false,
        error:
          error instanceof Error && error.message
            ? error.message
            : "Couldn't apply the import.",
      };
    }
    if (!res.ok) {
      toast.error(res.error);
      // Back to the review card - the preview is still valid, nothing was
      // overwritten, and the user can retry or cancel.
      setImportState(importState);
      return;
    }
    hasObservedProfile.current = true;
    skipNextDebouncedSave.current = true;
    setProfile(imported);
    setActiveId(
      imported.sections.find((section) => section.kind !== "skills")?.id ??
        imported.sections[0]?.id ??
        null
    );
    setOpenEntries({});
    setVariant("base");
    setImportState({ status: "idle" });
    setLastSavedAt(Date.now());
    setSaveState("idle");
    // Offered whenever there WAS a previous profile, not only when it looked
    // non-empty: isProfileEmpty is a heuristic, and being wrong about it must
    // not cost someone their undo on a destructive action.
    if (previous) {
      toast("Profile replaced", {
        action: {
          label: "Undo",
          onClick: () => {
            // Write it back directly rather than leaning on the debounced
            // autosave. The toast is mounted at the root layout so it outlives
            // this component: after navigating away, a setProfile-only undo
            // updated state on an unmounted editor and never reached Convex,
            // leaving the user certain they had undone something they had not.
            // Closing the tab inside the debounce window lost it the same way.
            const json = JSON.stringify(previous, null, 2);
            void saveProfile(json).then(
              (res) =>
                res.ok
                  ? toast.success("Profile restored")
                  : toast.error(`Could not restore: ${res.error}`),
              () => toast.error("Could not restore the previous profile.")
            );
            setProfile(previous);
            setActiveId(
              previous.sections.find((s) => s.kind !== "skills")?.id ??
                previous.sections[0]?.id ??
                null
            );
          },
        },
      });
    }
  };

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

  if (outcome.status === "invalid" && profile === null) {
    return (
      <div className="space-y-3">
        <EmptyState
          importing={importState.status === "parsing"}
          onImport={handleImportFile}
          onStart={() => {
            const blank = blankProfile();
            hasObservedProfile.current = true;
            skipNextDebouncedSave.current = true;
            setProfile(blank);
            attemptSave(blank, false);
            setActiveId(
              blank.sections.find((s) => s.kind !== "skills")?.id ?? null
            );
          }}
        />
        <ResumeImportStatus
          state={importState}
          current={null}
          onConfirm={() => void handleConfirmImport()}
          onCancel={handleCancelImport}
        />
      </div>
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

        <ResumeImportButton
          disabled={importState.status === "parsing"}
          label={importState.status === "parsing" ? "Parsing..." : "Import resume"}
          onSelect={handleImportFile}
        />

        <Button disabled title={BUILD_BUTTON_TITLE}>
          Build resume
        </Button>
      </div>

      <ResumeImportStatus
        state={importState}
        current={profile && !isProfileEmpty(profile) ? profileCounts(profile) : null}
        onConfirm={() => void handleConfirmImport()}
        onCancel={handleCancelImport}
      />

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

function EmptyState({
  importing,
  onImport,
  onStart,
}: {
  importing: boolean;
  onImport: (file: File) => void;
  onStart: () => void;
}) {
  return (
    <div className={cn(CARD, "max-w-md")}>
      <h2 className="mb-1 text-[13.5px] font-semibold text-ink">
        No profile on file
      </h2>
      <p className="text-[12px] text-ink-2">
        Import an existing resume to review it before saving, or start from scratch.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={onStart}>
          <Plus className="size-3.5" />
          Start from scratch
        </Button>
        <ResumeImportButton
          disabled={importing}
          label={importing ? "Parsing..." : "Import from a resume"}
          onSelect={onImport}
        />
      </div>
    </div>
  );
}

function ResumeImportButton({
  disabled,
  label,
  onSelect,
}: {
  disabled: boolean;
  label: string;
  onSelect: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="rounded-md border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-accent disabled:text-ink-2"
      >
        {label}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".docx,.txt,.md,.markdown,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onSelect(file);
        }}
      />
    </>
  );
}

// Pluralize a count for the replace warning ("1 entry", "12 entries").
function countNoun(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function ResumeImportStatus({
  state,
  current,
  onConfirm,
  onCancel,
}: {
  state: ResumeImportState;
  /** Counts for the profile being replaced; null when there is nothing worth
   *  warning about (no profile, or an empty scaffold). */
  current: ProfileCounts | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (state.status === "idle") return null;
  if (state.status === "parsing" || state.status === "applying") {
    return (
      <div className={cn(CARD, "mb-3 flex items-center gap-3")}>
        <Spinner />
        <div>
          <p className="text-[13px] font-semibold text-ink">
            {state.status === "parsing" ? "Parsing resume" : "Applying import"}
          </p>
          <p className="text-[12px] text-ink-2">
            {state.status === "parsing"
              ? `Extracting and mapping ${state.filename}`
              : `Backing up your current profile and saving ${state.filename}`}
          </p>
        </div>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className={cn(CARD, "mb-3")}>
        <p className="text-[13px] font-semibold text-red">Import failed</p>
        <p className="mt-1 break-words text-[12px] text-ink-2">{state.message}</p>
        <button
          type="button"
          onClick={onCancel}
          className="mt-3 rounded-md border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-2"
        >
          Dismiss
        </button>
      </div>
    );
  }
  return (
    <div className={cn(CARD, "mb-3")}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[13px] font-semibold text-ink">Review import</p>
          <p className="text-[12px] text-ink-2">{state.filename}</p>
          <p className="mt-1 text-[12px] font-medium text-ink">
            {state.preview.profile.header.name || "Unnamed profile"}
          </p>
          {state.preview.profile.header.contact_line && (
            <p className="text-[11.5px] text-ink-2">
              {state.preview.profile.header.contact_line}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {state.preview.sections.map((section) => (
            <span
              key={section.id}
              className="rounded-full bg-chip px-2 py-0.5 text-[11px] text-ink-2"
            >
              {section.title}: {section.count}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-3 border-t border-line pt-3">
        {state.preview.unmappedLines.length === 0 ? (
          <p className="text-[12px] text-accent">
            Every nonblank source line was credibly mapped.
          </p>
        ) : (
          <>
            <p className="text-[12px] font-semibold text-amber">
              {state.preview.unmappedLines.length} source{" "}
              {state.preview.unmappedLines.length === 1 ? "line was" : "lines were"} not mapped
            </p>
            <ul className="mt-2 max-h-36 space-y-1 overflow-y-auto rounded-md bg-chip p-2">
              {state.preview.unmappedLines.map((line) => (
                <li key={line.id} className="text-[11.5px] text-ink-2">
                  {line.text}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {current ? (
        (() => {
          const imported = profileCounts(state.preview.profile);
          return (
            <p className="mt-3 text-[11.5px] font-semibold text-amber">
              Importing REPLACES your current profile ({countNoun(current.sections, "section")},{" "}
              {countNoun(current.entries, "entry", "entries")},{" "}
              {countNoun(current.bullets, "bullet")}) with the imported content (
              {countNoun(imported.sections, "section")},{" "}
              {countNoun(imported.entries, "entry", "entries")},{" "}
              {countNoun(imported.bullets, "bullet")}). A backup of the current profile is
              saved first, and you can undo right after.
            </p>
          );
        })()
      ) : (
        <p className="mt-3 text-[11.5px] text-ink-2">
          This will fill in your empty profile. Nothing changes until you confirm this
          import.
        </p>
      )}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-md border border-line bg-surface px-3 py-1.5 text-[12px] font-semibold text-accent"
        >
          {current ? "Replace profile" : "Import"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-2"
        >
          Cancel
        </button>
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
