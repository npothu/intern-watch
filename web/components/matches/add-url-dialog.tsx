"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
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

const POLL_INTERVAL = 1500;
const POLL_TIMEOUT = 30000;

type Phase = "idle" | "submitting" | "polling" | "done" | "failed";

export function AddUrlDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearPoll() {
    if (pollRef.current) clearInterval(pollRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    pollRef.current = null;
    timeoutRef.current = null;
  }

  useEffect(() => {
    return () => clearPoll();
  }, []);

  // reset handled in onOpenChange to avoid setState-in-effect

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
    setPhase("submitting");
    const res = await addJobUrl(trimmed);
    if (!res.ok) {
      setError(res.error);
      setPhase("failed");
      return;
    }
    if (res.status === "already_exists") {
      toast.info("Already in your matches.");
      setOpen(false);
      setUrl("");
      // Refresh anyway: the row exists but may be sitting behind a filter, or
      // may have landed since this page was rendered. Without it "already in
      // your matches" points at a list that might not show it.
      router.refresh();
      return;
    }
    // polling
    setPhase("polling");
    const ingestId = res.ingestId;
    let elapsed = 0;
    pollRef.current = setInterval(async () => {
      elapsed += POLL_INTERVAL;
      if (elapsed >= POLL_TIMEOUT) {
        clearPoll();
        setError("Taking longer than expected — check your matches in a moment.");
        setPhase("failed");
        return;
      }
      const row = await getIngestStatusAction(ingestId);
      if (!row) return;
      if (row.status === "done") {
        clearPoll();
        toast.success("Added to your matches.");
        setOpen(false);
        setUrl("");
        setPhase("done");
        router.refresh();
      } else if (row.status === "failed") {
        clearPoll();
        setError(row.error || "Failed to ingest this URL.");
        setPhase("failed");
      } else if (row.status === "already_exists") {
        clearPoll();
        toast.info("Already in your matches.");
        setOpen(false);
        setUrl("");
        setPhase("done");
        router.refresh();
      }
    }, POLL_INTERVAL);

    // absolute timeout fallback
    timeoutRef.current = setTimeout(() => {
      clearPoll();
      if (phase !== "done") {
        setError("Timed out — please refresh and check your matches.");
        setPhase("failed");
      }
    }, POLL_TIMEOUT + 2000);
  }

  const busy = phase === "submitting" || phase === "polling";

  const handleOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v) {
      setError(null);
      setPhase("idle");
      clearPoll();
    }
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
              disabled={busy}
            />
            <p className="mt-1.5 text-xs text-ink-2">
              Paste any public job posting link. We&apos;ll fetch it and add it to your matches.
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
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={busy} className="min-w-[110px]">
              {busy ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {phase === "submitting" ? "Adding…" : "Fetching…"}
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
