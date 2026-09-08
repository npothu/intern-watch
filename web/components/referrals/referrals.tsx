"use client";

import { useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Archive, Plus, Search, Users } from "lucide-react";
import { toast } from "sonner";
import { ViewSwitch } from "@/components/nav/view-switch";
import { Button } from "@/components/ui/button";
import { CommandPalette } from "@/components/command-palette";
import { VIEWS } from "@/lib/view";
import { cn } from "@/lib/utils";
import {
  AVAILABILITY,
  REFERRAL_STATUS,
  followUpDue,
  followUpLabel,
  localDate,
  type ReferralData,
  type ReferralJob,
  type ReferralTarget,
  type JobReferral,
} from "@/lib/referrals";
import {
  saveReferralContact,
  saveJobReferral,
  changeReferralStatus,
  changeReferralFollowUp,
  archiveReferralRecord,
  addReferralNote,
  type ReferralResult,
} from "@/app/(app)/referrals/referral-actions";
import {
  ContactFields,
  EditorDialog,
  JobFields,
  type ReferralEditor,
} from "./forms";
import { ReferralBadge, ReferralDetail } from "./detail";

function subscribeDate(onChange: () => void) {
  const timer = window.setInterval(onChange, 60_000);
  window.addEventListener("focus", onChange);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("focus", onChange);
  };
}
const serverDate = () => "";

export function Referrals({
  data,
  jobs,
}: {
  data: ReferralData;
  jobs: ReferralJob[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [view, setView] = useState<"contacts" | "jobs">(() =>
    params.get("view") === "jobs" || params.has("job") ? "jobs" : "contacts",
  );
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [dueOnly, setDueOnly] = useState(false);
  const [archived, setArchived] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(
    () => params.get("contact") || params.get("referral") || null,
  );
  const [editor, setEditor] = useState<ReferralEditor | null>(() => {
    if (params.get("new") !== "1") return null;
    return data.contacts.some((c) => !c.archived)
      ? { kind: "referral", jobShort: params.get("job") ?? undefined }
      : { kind: "contact" };
  });
  const [afterContact, setAfterContact] = useState<Extract<
    ReferralEditor,
    { kind: "referral" }
  > | null>(() =>
    params.get("new") === "1" && !data.contacts.some((c) => !c.archived)
      ? { kind: "referral", jobShort: params.get("job") ?? undefined }
      : null,
  );
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const saving = useRef(false);
  const detailRef = useRef<HTMLElement>(null);
  const today = useSyncExternalStore(subscribeDate, localDate, serverDate);
  const contactsById = new Map(data.contacts.map((c) => [c.id, c]));
  const activeContacts = data.contacts.filter((c) => !c.archived);
  const activeReferrals = data.referrals.filter((r) => !r.archived);
  const jobCounts = new Map<string, number>();
  for (const r of activeReferrals)
    jobCounts.set(r.contactId, (jobCounts.get(r.contactId) ?? 0) + 1);
  const pool =
    view === "contacts"
      ? data.contacts.filter((c) => c.archived === archived)
      : data.referrals.filter((r) => r.archived === archived);
  const q = query.toLowerCase().trim();
  const shown = pool
    .filter((row) => {
      const contact =
        "contactId" in row ? contactsById.get(row.contactId) : row;
      const haystack = [
        row.company,
        contact?.name,
        contact?.relationship,
        "title" in row ? row.title : "",
      ]
        .join(" ")
        .toLowerCase();
      return (
        haystack.includes(q) &&
        (!dueOnly || followUpDue(row, today)) &&
        (!status ||
          ("status" in row ? row.status : row.availability) === status)
      );
    })
    .sort(
      (a, b) =>
        (a.followUpOn || "9999").localeCompare(b.followUpOn || "9999") ||
        a.company.localeCompare(b.company) ||
        b.updatedAt - a.updatedAt,
    );
  const selected =
    shown.find((row) => row.id === selectedId) ??
    shown.find(
      (row) => "jobShort" in row && row.jobShort === params.get("job"),
    ) ??
    shown[0];
  const referral =
    selected && "contactId" in selected ? (selected as JobReferral) : undefined;
  const contact = selected
    ? referral
      ? contactsById.get(referral.contactId)
      : data.contacts.find((c) => c.id === selected.id)
    : undefined;
  const dueCount = pool.filter((row) => followUpDue(row, today)).length;

  function run(
    action: () => Promise<ReferralResult>,
    success: string,
    done?: (result: Extract<ReferralResult, { ok: true }>) => void,
  ) {
    if (saving.current) return;
    saving.current = true;
    setError("");
    startTransition(async () => {
      try {
        const result = await action();
        if (!result.ok) {
          setError(result.error);
          return;
        }
        done?.(result);
        toast.success(success);
      } catch {
        setError(
          "Couldn't reach the server. Your unsaved changes are still here; please try again.",
        );
      } finally {
        saving.current = false;
      }
    });
  }
  function openEditor(next: ReferralEditor) {
    setError("");
    setEditor(next);
  }
  function add() {
    if (view === "contacts") {
      setAfterContact(null);
      openEditor({ kind: "contact" });
    } else if (activeContacts.length) openEditor({ kind: "referral" });
    else {
      setAfterContact({ kind: "referral" });
      openEditor({ kind: "contact" });
    }
  }
  function switchView(next: "contacts" | "jobs") {
    setView(next);
    setSelectedId(null);
    setStatus("");
    setError("");
    window.history.replaceState(
      null,
      "",
      next === "jobs" ? "/referrals?view=jobs" : "/referrals",
    );
  }
  function select(id: string) {
    setSelectedId(id);
    if (window.matchMedia("(max-width: 1023px)").matches)
      requestAnimationFrame(() =>
        detailRef.current?.scrollIntoView({
          block: "start",
          behavior: "instant",
        }),
      );
  }
  function saved(kind: "contacts" | "jobs", id?: string) {
    setView(kind);
    setSelectedId(id ?? null);
    setQuery("");
    setStatus("");
    setDueOnly(false);
    setArchived(false);
    setEditor(null);
    window.history.replaceState(
      null,
      "",
      kind === "jobs" ? "/referrals?view=jobs" : "/referrals",
    );
  }
  function archive(target: ReferralTarget, value: boolean) {
    run(
      () => archiveReferralRecord(target, value),
      value ? "Archived. Find it in the Archived view." : "Restored.",
    );
  }

  return (
    <div
      className="mx-auto w-full max-w-[1060px] px-5 pt-5 pb-24"
      aria-busy={pending}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ViewSwitch active="referrals" count={activeContacts.length} />
        <Button onClick={add} disabled={pending} className="gap-1.5">
          <Plus className="size-4" />
          {view === "contacts" ? "Add contact" : "Log referral"}
        </Button>
      </div>
      <div
        className="mt-5 mb-4 flex gap-5 border-b border-line"
        role="group"
        aria-label="Referral views"
      >
        {(["contacts", "jobs"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => switchView(tab)}
            aria-pressed={view === tab}
            className={cn(
              "border-b-2 border-transparent pb-2.5 text-[13px] text-ink-2",
              view === tab && "border-accent font-medium text-ink",
            )}
          >
            {tab === "contacts" ? "Contacts" : "Job referrals"}
            <span className="ml-1.5 text-[11.5px] tabular-nums text-ink-2">
              {tab === "contacts"
                ? activeContacts.length
                : activeReferrals.length}
            </span>
          </button>
        ))}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="flex min-w-[180px] flex-1 items-center gap-2 rounded-md border border-line-2 bg-surface px-2.5 py-1.5 sm:max-w-[290px]">
          <Search className="size-3.5 shrink-0 text-ink-2" />
          <input
            type="search"
            aria-label={
              view === "contacts" ? "Search contacts" : "Search referrals"
            }
            placeholder={
              view === "contacts"
                ? "Search contacts..."
                : "Search job referrals..."
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full min-w-0 bg-transparent text-base text-ink outline-none placeholder:text-ink-2 sm:text-[13px]"
          />
        </label>
        <select
          aria-label={
            view === "contacts"
              ? "Filter availability"
              : "Filter referral status"
          }
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded-md border border-line-2 bg-surface px-2 py-2 text-[12px] text-ink"
        >
          <option value="">
            {view === "contacts" ? "All availability" : "All statuses"}
          </option>
          {Object.entries(
            view === "contacts" ? AVAILABILITY : REFERRAL_STATUS,
          ).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setDueOnly((v) => !v)}
          aria-pressed={dueOnly}
          className={cn(
            "rounded-full border border-line-2 px-2.5 py-1.5 text-[12px] text-ink-2",
            dueOnly && "border-accent bg-accent text-accent-ink",
          )}
        >
          Follow-ups due <span className="ml-1 tabular-nums">{dueCount}</span>
        </button>
        <button
          type="button"
          onClick={() => {
            setArchived((v) => !v);
            setSelectedId(null);
          }}
          aria-pressed={archived}
          className={cn(
            "ml-auto inline-flex items-center gap-1 rounded-full border border-line-2 px-2.5 py-1.5 text-[12px] text-ink-2",
            archived && "border-accent bg-accent text-accent-ink",
          )}
        >
          <Archive className="size-3" />
          Archived
        </button>
      </div>
      {error && !editor && (
        <p
          role="alert"
          className="mb-4 rounded-md bg-red/10 px-3 py-2 text-sm text-red"
        >
          {error}
        </p>
      )}
      {shown.length ? (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(300px,1fr)]">
          <div className="min-w-0">
            <div className="overflow-hidden rounded-md border border-line bg-surface">
              <div className="flex justify-between gap-3 border-b border-line bg-bg px-3.5 py-2.5 text-[11px] text-ink-2">
                <span>
                  {view === "contacts" ? "Company / contact" : "Company / job"}
                </span>
                <span>
                  {view === "contacts"
                    ? "Availability / next step"
                    : "Referral / next step"}
                </span>
              </div>
              {shown.map((row) => {
                const person =
                  "contactId" in row ? contactsById.get(row.contactId) : row;
                const state = "status" in row ? row.status : row.availability;
                const label =
                  "status" in row
                    ? REFERRAL_STATUS[row.status]
                    : AVAILABILITY[row.availability];
                const jobCount = jobCounts.get(row.id) ?? 0;
                return (
                  <button
                    key={row.id}
                    type="button"
                    data-referral-row={row.id}
                    onClick={() => select(row.id)}
                    aria-pressed={selected?.id === row.id}
                    className={cn(
                      "grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-t border-line px-3.5 py-4 text-left first:border-t-0 hover:bg-bg sm:grid-cols-[32px_minmax(0,1fr)_auto]",
                      selected?.id === row.id &&
                        "bg-accent/5 shadow-[inset_3px_0_0_var(--color-accent)]",
                    )}
                  >
                    <span
                      aria-hidden
                      className="hidden size-8 items-center justify-center rounded-md bg-chip text-[11px] font-medium text-ink-2 sm:flex"
                    >
                      {row.company.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="min-w-0">
                      <span className="block break-words text-[13.5px] font-semibold">
                        {row.company}
                      </span>
                      <span className="mt-0.5 block break-words text-[12px] text-ink-2">
                        {"title" in row ? row.title : row.name}
                      </span>
                      <span className="mt-0.5 block text-[12px] text-ink-2">
                        {"title" in row ? person?.name : row.relationship}
                        {person?.archived && view === "jobs"
                          ? " · Archived contact"
                          : ""}
                      </span>
                    </span>
                    <span className="max-w-[140px] text-right">
                      <ReferralBadge value={state} label={label} />
                      <span
                        className={cn(
                          "mt-1.5 block break-words text-[11.5px] text-ink-2",
                          followUpDue(row, today) && "text-amber",
                        )}
                      >
                        {row.followUpOn
                          ? followUpLabel(row.followUpOn, today)
                          : row.nextStep ||
                            ("status" in row
                              ? "No follow-up"
                              : jobCount
                                ? jobCount +
                                  (jobCount === 1
                                    ? " job referral"
                                    : " job referrals")
                                : "No jobs linked yet")}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-3 text-[11.5px] text-ink-2">
              {shown.length} {archived ? "archived " : ""}
              {view === "contacts"
                ? shown.length === 1
                  ? "contact"
                  : "contacts"
                : shown.length === 1
                  ? "referral"
                  : "referrals"}
            </p>
          </div>
          {contact && (
            <aside ref={detailRef} className="min-w-0 scroll-mt-5">
              <ReferralDetail
                key={contact.id + (referral?.id ?? "")}
                contact={contact}
                referral={referral}
                linked={data.referrals.filter(
                  (r) =>
                    r.contactId === contact.id && (archived || !r.archived),
                )}
                notes={data.notes}
                jobs={jobs}
                today={today}
                pending={pending}
                onEdit={openEditor}
                onStatus={(id, value) =>
                  run(
                    () => changeReferralStatus(id, value),
                    "Referral status updated.",
                  )
                }
                onFollowUp={(target, value) =>
                  run(
                    () => changeReferralFollowUp(target, value),
                    value.followUpOn
                      ? "Follow-up rescheduled."
                      : "Follow-up completed.",
                  )
                }
                onArchive={archive}
                onNote={(contactId, note, referralId, done) =>
                  run(
                    () => addReferralNote(contactId, note, referralId),
                    "Note added.",
                    done,
                  )
                }
              />
            </aside>
          )}
        </div>
      ) : (
        <div className="rounded-md border border-line bg-surface px-5 py-12 text-center">
          <Users className="mx-auto mb-3 size-6 text-ink-2" />
          <h2 className="text-[15px] font-medium">
            {pool.length
              ? "No matches for these filters"
              : archived
                ? "Nothing archived"
                : view === "contacts"
                  ? "Save your first referral contact"
                  : "No job referrals yet"}
          </h2>
          <p className="mt-2 text-[13px] text-ink-2">
            {pool.length
              ? "Try a different search or clear the filters."
              : archived
                ? "Archived records will appear here. You can restore them anytime."
                : view === "contacts"
                  ? "Start with a name and company. Pick a job whenever you're ready."
                  : "Link a contact to a job in Matches or Tracker, or enter the role yourself."}
          </p>
          {pool.length ? (
            <Button
              variant="outline"
              className="mt-4"
              onClick={() => {
                setQuery("");
                setStatus("");
                setDueOnly(false);
              }}
            >
              Clear filters
            </Button>
          ) : (
            !archived && (
              <Button className="mt-4" onClick={add}>
                <Plus className="size-4" />
                {view === "contacts" ? "Add contact" : "Log referral"}
              </Button>
            )
          )}
        </div>
      )}
      <CommandPalette
        jumps={data.contacts
          .filter((c) => !c.archived)
          .map((c) => ({ id: c.id, title: c.company, subtitle: c.name }))}
        onJump={(id) => {
          setView("contacts");
          setQuery("");
          setStatus("");
          setDueOnly(false);
          setArchived(false);
          setSelectedId(id);
        }}
        actions={VIEWS.map((v) => ({
          id: v.id,
          label: "Go to " + v.label,
          icon: <v.icon className="size-4" />,
          run: () => router.push(v.href),
        }))}
      />
      {editor && (
        <EditorDialog
          editor={editor}
          pending={pending}
          error={error}
          onClose={() => {
            setEditor(
              editor.kind === "contact" && afterContact && activeContacts.length
                ? afterContact
                : null,
            );
            setAfterContact(null);
            setError("");
          }}
        >
          {editor.kind === "contact" ? (
            <ContactFields
              key={editor.record?.id ?? "new-contact"}
              record={editor.record}
              pending={pending}
              onSubmit={(input, note) =>
                run(
                  () => saveReferralContact(input, editor.record?.id, note),
                  "Contact saved.",
                  (result) => {
                    if (afterContact && result.id) {
                      setEditor({ ...afterContact, contactId: result.id });
                      setAfterContact(null);
                    } else if (editor.record) setEditor(null);
                    else saved("contacts", result.id);
                  },
                )
              }
            />
          ) : (
            <JobFields
              key={editor.record?.id ?? "new-referral"}
              editor={editor}
              contacts={data.contacts}
              jobs={jobs}
              pending={pending}
              onAddContact={(draft) => {
                setAfterContact({ ...editor, draft });
                openEditor({ kind: "contact" });
              }}
              onSubmit={(input) =>
                run(
                  () => saveJobReferral(input, editor.record?.id),
                  "Referral saved.",
                  (result) =>
                    editor.record ? setEditor(null) : saved("jobs", result.id),
                )
              }
            />
          )}
        </EditorDialog>
      )}
    </div>
  );
}
