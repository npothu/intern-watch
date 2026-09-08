"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AVAILABILITY,
  REFERRAL_STATUS,
  type ContactInput,
  type ReferralInput,
  type ReferralContact,
  type JobReferral,
  type ReferralJob,
} from "@/lib/referrals";
import { normCompany } from "@/lib/company";

export const FIELD =
  "w-full min-w-0 rounded-md border border-line-2 bg-bg px-2.5 py-2 text-base text-ink outline-none focus:border-accent sm:text-[13px]";
export function Field({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label
      className={
        wide
          ? "col-span-full block text-[12px] text-ink-2"
          : "block min-w-0 text-[12px] text-ink-2"
      }
    >
      <span className="mb-1.5 block">{label}</span>
      {children}
    </label>
  );
}

export type ReferralEditor =
  | { kind: "contact"; record?: ReferralContact }
  | {
      kind: "referral";
      record?: JobReferral;
      contactId?: string;
      jobShort?: string;
      draft?: ReferralInput;
    };

const EMPTY_CONTACT: ContactInput = {
  name: "",
  company: "",
  email: "",
  profileUrl: "",
  relationship: "",
  availability: "can_refer",
  followUpOn: "",
  nextStep: "",
};
const EMPTY_REFERRAL: ReferralInput = {
  contactId: "",
  jobShort: "",
  company: "",
  title: "",
  url: "",
  term: "",
  requisitionId: "",
  status: "planned",
  followUpOn: "",
  nextStep: "",
};

export function ContactFields({
  record,
  onSubmit,
  pending,
}: {
  record?: ReferralContact;
  onSubmit: (input: ContactInput, note: string) => void;
  pending: boolean;
}) {
  const [draft, setDraft] = useState<ContactInput>(record ?? EMPTY_CONTACT);
  const [note, setNote] = useState("");
  function update<K extends keyof ContactInput>(
    key: K,
    value: ContactInput[K],
  ) {
    setDraft((d) => ({ ...d, [key]: value }));
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    // Strip saved metadata before sending a Convex-validated input object.
    const {
      name,
      company,
      email,
      profileUrl,
      relationship,
      availability,
      followUpOn,
      nextStep,
    } = draft;
    onSubmit(
      {
        name,
        company,
        email,
        profileUrl,
        relationship,
        availability,
        followUpOn,
        nextStep,
      },
      note,
    );
  }
  return (
    <form onSubmit={submit}>
      <fieldset
        disabled={pending}
        className="grid grid-cols-1 gap-3 border-0 p-0 sm:grid-cols-2"
      >
        <Field label="Name *">
          <input
            className={FIELD}
            value={draft.name}
            onChange={(e) => update("name", e.target.value)}
            required
            maxLength={200}
            autoComplete="off"
            autoFocus
          />
        </Field>
        <Field label="Company *">
          <input
            className={FIELD}
            value={draft.company}
            onChange={(e) => update("company", e.target.value)}
            required
            maxLength={200}
          />
        </Field>
        <Field label="Email">
          <input
            className={FIELD}
            type="email"
            value={draft.email}
            onChange={(e) => update("email", e.target.value)}
            maxLength={320}
          />
        </Field>
        <Field label="Profile link">
          <input
            className={FIELD}
            type="url"
            placeholder="https://linkedin.com/in/..."
            value={draft.profileUrl}
            onChange={(e) => update("profileUrl", e.target.value)}
            maxLength={2000}
          />
        </Field>
        <Field label="How you know them">
          <input
            className={FIELD}
            placeholder="Classmate, former teammate..."
            value={draft.relationship}
            onChange={(e) => update("relationship", e.target.value)}
            maxLength={200}
          />
        </Field>
        <Field label="Referral availability">
          <select
            className={FIELD}
            value={draft.availability}
            onChange={(e) =>
              update(
                "availability",
                e.target.value as ContactInput["availability"],
              )
            }
          >
            {Object.entries(AVAILABILITY).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Follow up on">
          <input
            className={FIELD}
            type="date"
            value={draft.followUpOn}
            onChange={(e) => update("followUpOn", e.target.value)}
          />
        </Field>
        <Field label="Next step">
          <input
            className={FIELD}
            value={draft.nextStep}
            onChange={(e) => update("nextStep", e.target.value)}
            placeholder="Send my resume"
            maxLength={500}
          />
        </Field>
        {!record && (
          <Field label="Notes" wide>
            <textarea
              className={FIELD}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={5000}
              rows={3}
            />
          </Field>
        )}
        <div className="col-span-full mt-2 flex items-center justify-between gap-3">
          <span className="text-[12px] text-ink-2">
            You can link a job later.
          </span>
          <Button type="submit" disabled={pending}>
            {pending ? "Saving..." : "Save contact"}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

export function JobFields({
  editor,
  contacts,
  jobs,
  onSubmit,
  onAddContact,
  pending,
}: {
  editor: Extract<ReferralEditor, { kind: "referral" }>;
  contacts: ReferralContact[];
  jobs: ReferralJob[];
  onSubmit: (input: ReferralInput) => void;
  onAddContact: (draft: ReferralInput) => void;
  pending: boolean;
}) {
  const [draft, setDraft] = useState<ReferralInput>(() => {
    if (editor.draft)
      return {
        ...editor.draft,
        contactId: editor.contactId ?? editor.draft.contactId,
      };
    if (editor.record) return editor.record;
    const job = jobs.find((j) => j.short === editor.jobShort);
    const preferred =
      contacts.find((c) => c.id === editor.contactId) ??
      contacts.find(
        (c) =>
          !c.archived &&
          job &&
          normCompany(c.company) === normCompany(job.company),
      );
    return {
      ...EMPTY_REFERRAL,
      contactId: preferred?.id ?? "",
      company: job?.company ?? preferred?.company ?? "",
      jobShort: job?.short ?? "",
      title: job?.title ?? "",
      url: job?.url ?? "",
      term: job?.term ?? "",
    };
  });
  const [jobSearch, setJobSearch] = useState("");
  const selectedContact = contacts.find((c) => c.id === draft.contactId);
  const selectedJob = jobs.find((j) => j.short === draft.jobShort);
  const availableContacts = contacts.filter(
    (c) => !c.archived || c.id === draft.contactId,
  );
  const availableJobs = jobs.filter((j) =>
    (j.company + " " + j.title).toLowerCase().includes(jobSearch.toLowerCase()),
  );
  if (selectedJob && !availableJobs.includes(selectedJob))
    availableJobs.unshift(selectedJob);
  function update<K extends keyof ReferralInput>(
    key: K,
    value: ReferralInput[K],
  ) {
    setDraft((d) => ({ ...d, [key]: value }));
  }
  function selectJob(short: string) {
    const job = jobs.find((j) => j.short === short);
    setDraft((d) => ({
      ...d,
      jobShort: short,
      ...(job
        ? {
            company: job.company,
            title: job.title,
            url: job.url,
            term: job.term,
          }
        : {}),
    }));
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    const {
      contactId,
      jobShort,
      company,
      title,
      url,
      term,
      requisitionId,
      status,
      followUpOn,
      nextStep,
    } = draft;
    onSubmit({
      contactId,
      jobShort,
      company,
      title,
      url,
      term,
      requisitionId,
      status,
      followUpOn,
      nextStep,
    });
  }
  return (
    <form onSubmit={submit}>
      <fieldset
        disabled={pending}
        className="grid grid-cols-1 gap-3 border-0 p-0 sm:grid-cols-2"
      >
        <Field label="Contact *" wide>
          <select
            className={FIELD}
            value={draft.contactId}
            required
            disabled={!!editor.record}
            onChange={(e) => {
              const contact = contacts.find((c) => c.id === e.target.value);
              setDraft((d) => ({
                ...d,
                contactId: e.target.value,
                company: !d.jobShort
                  ? (contact?.company ?? d.company)
                  : d.company,
              }));
            }}
          >
            <option value="">Choose a contact</option>
            {availableContacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.company}
                {c.archived ? " (archived)" : ""}
              </option>
            ))}
          </select>
        </Field>
        {!editor.record && (
          <button
            type="button"
            className="col-span-full justify-self-start text-[12px] text-accent hover:underline"
            onClick={() => onAddContact(draft)}
          >
            + Add a contact
          </button>
        )}
        <Field label="Find a job in Matches or Tracker" wide>
          <input
            className={FIELD}
            type="search"
            value={jobSearch}
            onChange={(e) => setJobSearch(e.target.value)}
            placeholder="Search company or job title..."
          />
        </Field>
        <Field label="Link a job" wide>
          <select
            className={FIELD}
            value={draft.jobShort}
            onChange={(e) => selectJob(e.target.value)}
          >
            <option value="">Enter job details manually</option>
            {draft.jobShort && !selectedJob && (
              <option value={draft.jobShort}>
                {draft.company} · {draft.title} (saved job)
              </option>
            )}
            {availableJobs.map((j) => (
              <option key={j.short} value={j.short}>
                {j.company} · {j.title}
                {j.term ? " · " + j.term : ""}
                {j.applicationStatus ? " · Tracker" : " · Matches"}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Company *">
          <input
            className={FIELD}
            value={draft.company}
            onChange={(e) => update("company", e.target.value)}
            required
            maxLength={200}
            readOnly={!!draft.jobShort}
          />
        </Field>
        <Field label="Job title *">
          <input
            className={FIELD}
            value={draft.title}
            onChange={(e) => update("title", e.target.value)}
            required
            maxLength={500}
            readOnly={!!draft.jobShort}
          />
        </Field>
        {selectedContact &&
          normCompany(selectedContact.company) !==
            normCompany(draft.company) && (
            <p className="col-span-full text-[12px] text-amber">
              This job is at {draft.company || "another company"};{" "}
              {selectedContact.name} is listed at {selectedContact.company}.
            </p>
          )}
        <Field label="Job URL">
          <input
            className={FIELD}
            type="url"
            value={draft.url}
            onChange={(e) => update("url", e.target.value)}
            maxLength={2000}
            readOnly={!!draft.jobShort}
          />
        </Field>
        <Field label="Requisition ID">
          <input
            className={FIELD}
            value={draft.requisitionId}
            onChange={(e) => update("requisitionId", e.target.value)}
            maxLength={200}
          />
        </Field>
        <Field label="Term">
          <input
            className={FIELD}
            value={draft.term}
            onChange={(e) => update("term", e.target.value)}
            maxLength={200}
            placeholder="Summer 2027"
            readOnly={!!draft.jobShort}
          />
        </Field>
        <Field label="Referral status">
          <select
            className={FIELD}
            value={draft.status}
            onChange={(e) =>
              update("status", e.target.value as ReferralInput["status"])
            }
          >
            {Object.entries(REFERRAL_STATUS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Follow up on">
          <input
            className={FIELD}
            type="date"
            value={draft.followUpOn}
            onChange={(e) => update("followUpOn", e.target.value)}
          />
        </Field>
        <Field label="Next step">
          <input
            className={FIELD}
            value={draft.nextStep}
            onChange={(e) => update("nextStep", e.target.value)}
            maxLength={500}
          />
        </Field>
        <div className="col-span-full mt-2 flex justify-end">
          <Button disabled={pending} type="submit">
            {pending ? "Saving..." : "Save referral"}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}

export function EditorDialog({
  editor,
  pending,
  error,
  onClose,
  children,
}: {
  editor: ReferralEditor;
  pending: boolean;
  error: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent
        className="max-h-[85dvh] overflow-y-auto sm:max-w-[600px]"
        showCloseButton={!pending}
      >
        <DialogHeader>
          <DialogTitle>
            {editor.kind === "contact"
              ? editor.record
                ? "Edit contact"
                : "Add a referral contact"
              : editor.record
                ? "Edit job referral"
                : "Log a job referral"}
          </DialogTitle>
          <DialogDescription>
            {editor.kind === "contact"
              ? "Save someone you can ask for a referral. Only name and company are required."
              : "Track this request separately from your application status."}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="rounded-md bg-red/10 p-2 text-sm text-red">
            {error}
          </p>
        )}
        {children}
      </DialogContent>
    </Dialog>
  );
}
