"use client";

import Link from "next/link";
import { useState } from "react";
import { Archive, ArrowUpRight, Pencil, Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  STATUS_LABELS,
  isTrackerStatus,
} from "@/components/tracker/tracker-lib";
import { cn } from "@/lib/utils";
import {
  AVAILABILITY,
  REFERRAL_STATUS,
  followUpDue,
  followUpLabel,
  localDate,
  safeReferralUrl,
  type FollowUp,
  type ReferralContact,
  type JobReferral,
  type ReferralNote,
  type ReferralJob,
  type ReferralStatus,
  type ReferralTarget,
} from "@/lib/referrals";
import { FIELD, Field, type ReferralEditor } from "./forms";

export function ReferralBadge({
  value,
  label,
}: {
  value: string;
  label: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex rounded-full bg-chip px-2 py-0.5 text-[11.5px] font-medium text-ink-2",
        (value === "can_refer" || value === "submitted") &&
          "bg-accent/10 text-accent",
        value === "requested" && "bg-amber/10 text-amber",
      )}
    >
      {label}
    </span>
  );
}

function FollowUpSection({
  record,
  target,
  today,
  onChange,
  pending,
}: {
  record: FollowUp;
  target: ReferralTarget;
  today: string;
  pending: boolean;
  onChange: (target: ReferralTarget, input: FollowUp) => void;
}) {
  if (!record.followUpOn && !record.nextStep) return null;
  const isDue = followUpDue(record, today);
  function postpone() {
    const date = new Date(today + "T12:00:00");
    date.setDate(date.getDate() + 3);
    onChange(target, {
      nextStep: record.nextStep,
      followUpOn: localDate(date),
    });
  }
  return (
    <div
      className={cn(
        "mt-3 rounded-r-md border-l-2 border-line-2 bg-bg px-3 py-2.5",
        isDue && "border-amber bg-amber/5",
      )}
    >
      {record.followUpOn && (
        <p
          className={cn(
            "mb-1 text-[12px] font-medium text-ink-2",
            isDue && "text-amber",
          )}
        >
          {followUpLabel(record.followUpOn, today)} · Follow up
        </p>
      )}
      <p className="break-words text-[13px]">
        {record.nextStep || "Follow up on this referral"}
      </p>
      <div className="mt-2 flex gap-3 text-[12px] text-accent">
        <button
          type="button"
          disabled={pending}
          onClick={() => onChange(target, { followUpOn: "", nextStep: "" })}
          className="hover:underline disabled:opacity-50"
        >
          Mark done
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={postpone}
          className="hover:underline disabled:opacity-50"
        >
          In 3 days
        </button>
      </div>
    </div>
  );
}

function JobSummary({
  referral,
  job,
  today,
  pending,
  onStatus,
  onFollowUp,
  onEdit,
}: {
  referral: JobReferral;
  job?: ReferralJob;
  today: string;
  pending: boolean;
  onStatus: (id: string, status: ReferralStatus) => void;
  onFollowUp: (target: ReferralTarget, input: FollowUp) => void;
  onEdit: (editor: ReferralEditor) => void;
}) {
  const safeUrl = safeReferralUrl(referral.url);
  const applicationStatus = job?.applicationStatus;
  return (
    <section className="border-t border-line py-3 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="break-words text-[13px] font-medium">
            {referral.title}
          </h3>
          <p className="mt-0.5 text-[12px] text-ink-2">
            {[referral.company, referral.term, referral.requisitionId]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <button
          className="shrink-0 rounded p-1 text-ink-2 hover:bg-chip"
          type="button"
          disabled={pending}
          onClick={() => onEdit({ kind: "referral", record: referral })}
          aria-label={"Edit " + referral.title}
        >
          <Pencil className="size-3.5" />
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <select
          aria-label={"Referral status for " + referral.title}
          className="max-w-full rounded-full border border-line-2 bg-surface px-2 py-1 text-[12px] text-ink disabled:opacity-50"
          value={referral.status}
          disabled={pending}
          onChange={(e) =>
            onStatus(referral.id, e.target.value as ReferralStatus)
          }
        >
          {Object.entries(REFERRAL_STATUS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {applicationStatus ? (
          <Link
            className="text-[12px] text-accent hover:underline"
            href={"/?view=tracker&job=" + encodeURIComponent(referral.jobShort)}
          >
            Tracker:{" "}
            {isTrackerStatus(applicationStatus)
              ? STATUS_LABELS[applicationStatus]
              : applicationStatus}
          </Link>
        ) : (
          <span className="text-[12px] text-ink-2">
            {referral.jobShort ? "Not applied" : "Not linked to Tracker"}
          </span>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[12px] text-accent">
        {safeUrl && (
          <a
            href={safeUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 hover:underline"
          >
            Job posting <ArrowUpRight className="size-3" />
          </a>
        )}
        {job?.inMatches && (
          <Link
            href={"/?job=" + encodeURIComponent(job.short)}
            className="hover:underline"
          >
            View in Matches
          </Link>
        )}
        {referral.archived && (
          <span className="text-ink-2">Archived referral</span>
        )}
      </div>
      <FollowUpSection
        record={referral}
        target={{ kind: "referral", id: referral.id }}
        today={today}
        pending={pending}
        onChange={onFollowUp}
      />
    </section>
  );
}

function Notes({
  notes,
  contactId,
  referralId,
  pending,
  onNote,
}: {
  notes: ReferralNote[];
  contactId: string;
  referralId?: string;
  pending: boolean;
  onNote: (
    contactId: string,
    note: string,
    referralId?: string,
    done?: () => void,
  ) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  return (
    <section className="mt-4 border-t border-line pt-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[12px] font-medium">Notes & activity</h3>
        <button
          type="button"
          className="text-[12px] text-accent hover:underline"
          onClick={() => setAdding(true)}
        >
          + Add note
        </button>
      </div>
      {adding && (
        <form
          className="mb-4"
          onSubmit={(e) => {
            e.preventDefault();
            onNote(contactId, draft, referralId, () => {
              setDraft("");
              setAdding(false);
            });
          }}
        >
          <Field label="New note">
            <textarea
              className={FIELD}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={5000}
              rows={3}
              required
              autoFocus
              disabled={pending}
            />
          </Field>
          <div className="mt-2 flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setAdding(false)}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={pending || !draft.trim()}>
              {pending ? "Saving..." : "Save note"}
            </Button>
          </div>
        </form>
      )}
      {notes.length ? (
        <ol className="space-y-4">
          {notes.map((note) => (
            <li key={note.id}>
              <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-ink-2">
                {note.text}
              </p>
              <time
                suppressHydrationWarning
                className="mt-1 block text-[11px] text-ink-2"
                dateTime={new Date(note.createdAt).toISOString()}
              >
                {new Date(note.createdAt).toLocaleDateString("en-US", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                })}
              </time>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-[12px] text-ink-2">No notes yet.</p>
      )}
    </section>
  );
}

export function ReferralDetail({
  contact,
  referral,
  linked,
  notes,
  jobs,
  today,
  pending,
  onEdit,
  onStatus,
  onFollowUp,
  onArchive,
  onNote,
}: {
  contact: ReferralContact;
  referral?: JobReferral;
  linked: JobReferral[];
  notes: ReferralNote[];
  jobs: ReferralJob[];
  today: string;
  pending: boolean;
  onEdit: (editor: ReferralEditor) => void;
  onStatus: (id: string, status: ReferralStatus) => void;
  onFollowUp: (target: ReferralTarget, input: FollowUp) => void;
  onArchive: (target: ReferralTarget, archived: boolean) => void;
  onNote: (
    contactId: string,
    note: string,
    referralId?: string,
    done?: () => void,
  ) => void;
}) {
  const target: ReferralTarget = {
    kind: referral ? "referral" : "contact",
    id: referral?.id ?? contact.id,
  };
  const archived = referral?.archived ?? contact.archived;
  const profile = safeReferralUrl(contact.profileUrl);
  const shownNotes = notes.filter(
    (n) =>
      n.contactId === contact.id && (!referral || n.referralId === referral.id),
  );
  return (
    <div
      className="rounded-md border border-line bg-surface p-4"
      aria-label={referral ? "Referral details" : "Contact details"}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="break-words text-[16px] font-semibold tracking-tight">
            {contact.name}
          </h2>
          <p className="mt-0.5 text-[12px] text-ink-2">
            {[contact.company, contact.relationship]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Edit contact"
          disabled={pending}
          onClick={() => onEdit({ kind: "contact", record: contact })}
        >
          <Pencil className="size-3.5" />
        </Button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ReferralBadge
          value={contact.availability}
          label={AVAILABILITY[contact.availability]}
        />
        {contact.archived && (
          <span className="text-[12px] text-ink-2">Archived contact</span>
        )}
      </div>
      {(contact.email || profile) && (
        <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-accent">
          {contact.email && (
            <a
              className="break-all hover:underline"
              href={"mailto:" + contact.email}
            >
              {contact.email}
            </a>
          )}
          {profile && (
            <a
              className="inline-flex items-center gap-0.5 hover:underline"
              href={profile}
              target="_blank"
              rel="noopener noreferrer"
            >
              Profile <ArrowUpRight className="size-3" />
            </a>
          )}
        </div>
      )}
      {!referral && (
        <FollowUpSection
          record={contact}
          target={target}
          today={today}
          pending={pending}
          onChange={onFollowUp}
        />
      )}
      <div className="my-4 border-t border-line" />
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[12px] font-medium">
          {referral ? "Job referral" : "Job referrals · " + linked.length}
        </h3>
        {!contact.archived && (
          <button
            type="button"
            className="inline-flex items-center gap-0.5 text-[12px] text-accent hover:underline"
            disabled={pending}
            onClick={() => onEdit({ kind: "referral", contactId: contact.id })}
          >
            <Plus className="size-3" />
            Log referral
          </button>
        )}
      </div>
      {(referral ? [referral] : linked).map((r) => (
        <JobSummary
          key={r.id}
          referral={r}
          job={jobs.find((j) => j.short === r.jobShort)}
          today={today}
          pending={pending}
          onStatus={onStatus}
          onFollowUp={onFollowUp}
          onEdit={onEdit}
        />
      ))}
      {!referral && !linked.length && (
        <p className="text-[12px] text-ink-2">No jobs linked yet.</p>
      )}
      <Notes
        key={target.kind + target.id}
        notes={shownNotes}
        contactId={contact.id}
        referralId={referral?.id}
        pending={pending}
        onNote={onNote}
      />
      <div className="mt-4 border-t border-line pt-3">
        <Button
          variant="ghost"
          size="sm"
          className="text-ink-2"
          disabled={pending}
          onClick={() => onArchive(target, !archived)}
        >
          {archived ? (
            <RotateCcw className="size-3.5" />
          ) : (
            <Archive className="size-3.5" />
          )}
          {archived ? "Restore" : "Archive"} {referral ? "referral" : "contact"}
        </Button>
      </div>
    </div>
  );
}
