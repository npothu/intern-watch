"use client";

import { useState } from "react";

import type { CreateManualApplicationRequest } from "@/lib/convex";
import { MANUAL_APPLICATION_LIMITS } from "../../../shared/applications";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { STATUS_LABELS, STATUS_ORDER } from "@/components/tracker/tracker-lib";

export type ApplicationSubmitResult =
  | { ok: true }
  | { ok: false; error: string };

const fieldClass =
  "w-full rounded-md border border-line-2 bg-bg px-3 py-2 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-2/70 focus:border-accent";

export function CreateApplicationDialog({
  open,
  onOpenChange,
  initialCompany = "",
  initialStatus = "applied",
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialCompany?: string;
  initialStatus?: string;
  onSubmit: (request: CreateManualApplicationRequest) => Promise<ApplicationSubmitResult>;
}) {
  const [company, setCompany] = useState(initialCompany);
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [appliedDate, setAppliedDate] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [lastOpen, setLastOpen] = useState(false);
  const [requestId, setRequestId] = useState("");

  if (open !== lastOpen) {
    setLastOpen(open);
    if (open) {
      setCompany(initialCompany);
      setTitle("");
      setLocation("");
      setUrl("");
      setNote("");
      setStatus(initialStatus);
      setAppliedDate("");
      setError("");
      setPending(false);
      setRequestId(crypto.randomUUID());
    }
  }

  async function submit() {
    if (!company.trim() || pending) return;
    setPending(true);
    setError("");
    const result = await onSubmit({
      requestId: requestId || crypto.randomUUID(),
      draft: {
        company,
        title,
        location,
        url,
        note,
        status,
        appliedDate,
      },
    });
    setPending(false);
    if (result.ok) onOpenChange(false);
    else setError(result.error);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Add an application</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block text-[12.5px] font-medium text-ink">
            Company
            <input
              autoFocus
              required
              value={company}
              maxLength={MANUAL_APPLICATION_LIMITS.company}
              onChange={(event) => setCompany(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.metaKey) {
                  event.preventDefault();
                  submit();
                }
              }}
              placeholder="Company name"
              className={`${fieldClass} mt-1`}
            />
          </label>

          <details className="group rounded-md border border-line bg-surface">
            <summary className="cursor-pointer list-none px-3 py-2 text-[12.5px] font-medium text-accent marker:hidden">
              <span className="group-open:hidden">Add role, link, date, or notes</span>
              <span className="hidden group-open:inline">Application details</span>
            </summary>
            <div className="grid gap-3 border-t border-line px-3 py-3 sm:grid-cols-2">
              <label className="text-[12px] font-medium text-ink">
                Role
                <input
                  value={title}
                  maxLength={MANUAL_APPLICATION_LIMITS.title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Software Engineering Intern"
                  className={`${fieldClass} mt-1`}
                />
              </label>
              <label className="text-[12px] font-medium text-ink">
                Location
                <input
                  value={location}
                  maxLength={MANUAL_APPLICATION_LIMITS.location}
                  onChange={(event) => setLocation(event.target.value)}
                  placeholder="Austin, TX or Remote"
                  className={`${fieldClass} mt-1`}
                />
              </label>
              <label className="text-[12px] font-medium text-ink sm:col-span-2">
                Job link
                <input
                  type="url"
                  value={url}
                  maxLength={MANUAL_APPLICATION_LIMITS.url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://..."
                  className={`${fieldClass} mt-1`}
                />
              </label>
              <label className="text-[12px] font-medium text-ink">
                Status
                <select
                  value={status}
                  onChange={(event) => setStatus(event.target.value)}
                  className={`${fieldClass} mt-1`}
                >
                  {STATUS_ORDER.map((item) => (
                    <option key={item} value={item}>{STATUS_LABELS[item]}</option>
                  ))}
                </select>
              </label>
              <label className="text-[12px] font-medium text-ink">
                Applied date
                <input
                  type="date"
                  value={appliedDate}
                  onChange={(event) => setAppliedDate(event.target.value)}
                  className={`${fieldClass} mt-1`}
                />
              </label>
              <label className="text-[12px] font-medium text-ink sm:col-span-2">
                Note
                <textarea
                  value={note}
                  maxLength={MANUAL_APPLICATION_LIMITS.note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Recruiter, referral, deadline, or anything else"
                  rows={3}
                  className={`${fieldClass} mt-1 resize-y`}
                />
              </label>
            </div>
          </details>

          {error && (
            <p role="alert" aria-live="polite" className="text-[12px] text-red">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!company.trim() || pending}>
            {pending ? "Adding..." : "Add application"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
