"use client";

import { useState } from "react";
import { Plus, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { addJobUrl, getIngestStatusAction } from "@/app/(app)/ingest-actions";
import { useSyncRefresh } from "@/lib/sync-pulse";

const POLL_INTERVAL = 1500;
const POLL_TIMEOUT = 60000;

// Follows an accepted ingest after the dialog has closed, reporting the
// outcome through one toast that starts as a spinner. Not tied to the dialog's
// lifetime: the submit returns as soon as the server accepts the URL, and the
// fetch/extract that follows can take tens of seconds.
async function trackIngest(ingestId: string, onLanded: () => void) {
  const toastId = toast.loading("Fetching job posting…");
  const deadline = Date.now() + POLL_TIMEOUT;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    const row = await getIngestStatusAction(ingestId).catch(() => null);
    if (!row) continue;
    if (row.status === "done") {
      toast.success("Added to your matches.", { id: toastId });
      onLanded();
      return;
    }
    if (row.status === "already_exists") {
      toast.info("Already in your matches.", { id: toastId });
      onLanded();
      return;
    }
    if (row.status === "failed") {
      toast.error(row.error || "Failed to ingest this URL.", { id: toastId });
      return;
    }
  }
  toast.info("Still fetching — it will appear in your matches when ready.", { id: toastId });
}

export function AddUrlDialog() {
  const syncRefresh = useSyncRefresh();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) {
      setError("Please paste a URL.");
      return;
    }
    try {
      new URL(trimmed);
    } catch {
      setError("Invalid URL — include https://");
      return;
    }
    setError(null);
    setSubmitting(true);
    const res = await addJobUrl(trimmed).finally(() => setSubmitting(false));
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setOpen(false);
    setUrl("");
    if (res.status === "already_exists") {
      toast.info("Already in your matches.");
      // Refresh anyway: the row exists but may be sitting behind a filter, or
      // may have landed since this page was rendered. Without it "already in
      // your matches" points at a list that might not show it.
      syncRefresh();
      return;
    }
    void trackIngest(res.ingestId, syncRefresh);
  }

  const handleOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v) setError(null);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 rounded-full border-line-2 bg-surface px-3 text-[13px] font-medium"
        >
          <Plus className="h-3.5 w-3.5" />
          Add URL
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="text-[16px] font-semibold">Add a job URL</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="mt-1 space-y-3">
          <div>
            <input
              type="url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                if (error) setError(null);
              }}
              placeholder="https://boards.greenhouse.io/company/jobs/123"
              className="flex h-9 w-full rounded-md border border-line-2 bg-surface px-3 py-2 text-sm outline-none placeholder:text-ink-2 focus:border-accent focus:ring-1 focus:ring-accent"
              autoFocus
              disabled={submitting}
            />
            <p className="mt-1.5 text-xs text-ink-2">
              Paste any public job posting link. We&apos;ll fetch it in the background and add it to your matches.
            </p>
            {error && (
              <p className="mt-2 rounded-md bg-red/10 px-2.5 py-1.5 text-xs font-medium text-red">
                {error}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={submitting} className="min-w-[110px]">
              {submitting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Adding…
                </>
              ) : (
                "Add to matches"
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
