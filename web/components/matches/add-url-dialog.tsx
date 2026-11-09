"use client";

import { useState } from "react";
import { Plus, Loader2, Check, X, Info } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { addJobUrl, getIngestStatusAction, type AddUrlResult } from "@/app/(app)/ingest-actions";
import { useSyncRefresh } from "@/lib/sync-pulse";
import { boardYamlRow, gapMessage, MAX_BULK_LINKS, parseLinks, type GapInfo } from "@/lib/bulk-links";

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

// A hand-added posting is one the watcher missed. When its board isn't
// polled, say so; when a yaml row would fix that (the ATS has an adapter),
// hand the row over. The weekly coverage-gaps issue lists both kinds.
function showGapHint(gap: GapInfo) {
  const msg = gapMessage(gap);
  if (!msg) return;
  const row = boardYamlRow(gap);
  toast.info(msg, row
    ? {
        description: "Add the board to data/ats_boards.yaml so the next one isn't missed.",
        duration: 12000,
        action: { label: "Copy row", onClick: () => void navigator.clipboard?.writeText(row) },
      }
    : { duration: 8000 });
}

const RATE_RETRY_MS = 7000;
const RATE_RETRIES = 9;

// Submits one link, waiting out the per-minute ingest rate limit (bulk pastes
// can exceed it) instead of failing the rest of the batch.
async function addWithRetry(url: string, foundVia: string): Promise<AddUrlResult> {
  for (let attempt = 0; ; attempt++) {
    const res = await addJobUrl(url, foundVia).catch(
      (e): AddUrlResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
    if (res.ok || !/per minute/i.test(res.error) || attempt >= RATE_RETRIES) return res;
    await new Promise((r) => setTimeout(r, RATE_RETRY_MS));
  }
}

type LinkState = "queued" | "adding" | "fetching" | "added" | "exists" | "failed" | "slow";
type LinkRow = { url: string; state: LinkState; error?: string; gap?: GapInfo };

async function waitForIngest(ingestId: string): Promise<{ state: LinkState; error?: string }> {
  const deadline = Date.now() + POLL_TIMEOUT;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    const row = await getIngestStatusAction(ingestId).catch(() => null);
    if (row?.status === "done") return { state: "added" };
    if (row?.status === "already_exists") return { state: "exists" };
    if (row?.status === "failed") return { state: "failed", error: row.error || "Failed to ingest." };
  }
  return { state: "slow" };
}

const VIA_KEY = "addUrl.foundVia";
const VIA_SUGGESTIONS = ["instagram", "linkedin", "discord", "friend", "career fair", "newsletter"];

function readVia(): string {
  try {
    return localStorage.getItem(VIA_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeVia(v: string) {
  try {
    localStorage.setItem(VIA_KEY, v);
  } catch {
    /* storage unavailable: the label just isn't remembered */
  }
}

const STATE_LABEL: Record<LinkState, string> = {
  queued: "Queued",
  adding: "Adding…",
  fetching: "Fetching…",
  added: "Added",
  exists: "Already in matches",
  failed: "Failed",
  slow: "Still fetching",
};

function LinkStatus({ row }: { row: LinkRow }) {
  const busy = row.state === "adding" || row.state === "fetching";
  // Hint as soon as the add is accepted - a fetch that later fails was still
  // a miss worth closing.
  const gap = row.gap ? gapMessage(row.gap) : null;
  const yaml = row.gap ? boardYamlRow(row.gap) : null;
  return (
    <li className="flex flex-col gap-0.5 border-b border-line-2 py-1.5 last:border-b-0">
      <div className="flex items-center gap-2 text-xs">
        <span className="w-4 shrink-0">
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-2" />}
          {(row.state === "added" || row.state === "exists") && <Check className="h-3.5 w-3.5 text-accent" />}
          {row.state === "failed" && <X className="h-3.5 w-3.5 text-red" />}
        </span>
        <span className="min-w-0 flex-1 truncate text-ink-2" title={row.url}>{row.url}</span>
        <span className={row.state === "failed" ? "shrink-0 text-red" : "shrink-0 text-ink-2"}>
          {STATE_LABEL[row.state]}
        </span>
      </div>
      {row.error && <p className="pl-6 text-xs text-red">{row.error}</p>}
      {gap && (
        <p className="flex items-center gap-1.5 pl-6 text-xs text-ink-2">
          <Info className="h-3 w-3 shrink-0" />
          {gap}
          {yaml && <button
            type="button"
            className="underline underline-offset-2 hover:text-ink"
            onClick={() => {
              void navigator.clipboard?.writeText(yaml);
              toast.success("Copied the ats_boards.yaml row.");
            }}
          >
            Copy row
          </button>}
        </p>
      )}
    </li>
  );
}

export function AddUrlDialog() {
  const syncRefresh = useSyncRefresh();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [foundVia, setFoundVia] = useState(readVia);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [rows, setRows] = useState<LinkRow[] | null>(null);

  const links = parseLinks(text);

  function patchRow(i: number, patch: Partial<LinkRow>) {
    setRows((rs) => rs && rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  async function submitOne(url: string) {
    setSubmitting(true);
    const res = await addJobUrl(url, foundVia).finally(() => setSubmitting(false));
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setOpen(false);
    setText("");
    if (res.status === "already_exists") {
      toast.info("Already in your matches.");
      // Refresh anyway: the row exists but may be sitting behind a filter, or
      // may have landed since this page was rendered. Without it "already in
      // your matches" points at a list that might not show it.
      syncRefresh();
      return;
    }
    // The gap facts come back with the request itself, so a board the watcher
    // doesn't poll is named even when the fetch then fails (bot-walled
    // Workday/Oracle pages). An in_progress add follows the earlier ingest.
    showGapHint(res);
    void trackIngest(res.ingestId, syncRefresh);
  }

  // Sequential on purpose: polite to the job sites, and it keeps the
  // per-minute ingest limit from failing half the batch.
  async function submitMany(urls: string[]) {
    setSubmitting(true);
    setRows(urls.map((url) => ({ url, state: "queued" })));
    const pending: Promise<void>[] = [];
    for (const [i, url] of urls.entries()) {
      patchRow(i, { state: "adding" });
      const res = await addWithRetry(url, foundVia);
      if (!res.ok) {
        patchRow(i, { state: "failed", error: res.error });
        continue;
      }
      if (res.status === "already_exists") {
        patchRow(i, { state: "exists" });
        continue;
      }
      patchRow(i, { state: "fetching", gap: res });
      pending.push(waitForIngest(res.ingestId).then((r) => patchRow(i, r)));
    }
    await Promise.all(pending);
    setSubmitting(false);
    syncRefresh();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (links.length === 0) {
      setError(text.trim() ? "No links found — include https://" : "Please paste a URL.");
      return;
    }
    if (links.length > MAX_BULK_LINKS) {
      setError(`That's ${links.length} links — add at most ${MAX_BULK_LINKS} at a time.`);
      return;
    }
    setError(null);
    writeVia(foundVia.trim());
    if (links.length === 1) await submitOne(links[0]);
    else await submitMany(links);
  }

  const handleOpenChange = (v: boolean) => {
    if (!v && submitting && rows) return; // a batch is running; keep its status visible
    setOpen(v);
    if (!v) {
      setError(null);
      if (rows) {
        setRows(null);
        setText("");
      }
    }
  };

  const done = rows !== null && !submitting;

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
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-[16px] font-semibold">Add job URLs</DialogTitle>
        </DialogHeader>
        {rows ? (
          <div className="mt-1 space-y-3">
            <ul className="max-h-[50vh] overflow-y-auto rounded-md border border-line-2 bg-surface px-2.5">
              {rows.map((row, i) => (
                <LinkStatus key={i} row={row} />
              ))}
            </ul>
            <div className="flex justify-end pt-1">
              <Button size="sm" disabled={!done} onClick={() => handleOpenChange(false)}>
                {done ? "Done" : (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Adding…
                  </>
                )}
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-1 space-y-3">
            <div>
              <textarea
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
                }}
                rows={links.length > 1 ? 5 : 2}
                placeholder={"https://boards.greenhouse.io/company/jobs/123\none link per line, or paste several at once"}
                className="flex w-full resize-y rounded-md border border-line-2 bg-surface px-3 py-2 text-sm outline-none placeholder:text-ink-2 focus:border-accent focus:ring-1 focus:ring-accent"
                autoFocus
                disabled={submitting}
              />
              <p className="mt-1.5 text-xs text-ink-2">
                Paste one or more public job posting links (any separator). We&apos;ll fetch each in the
                background and add it to your matches.
                {links.length > 1 && <> {links.length} links found.</>}
              </p>
              <label className="mt-3 flex items-center gap-2 text-xs text-ink-2">
                Found via
                <input
                  value={foundVia}
                  onChange={(e) => setFoundVia(e.target.value)}
                  list="add-url-found-via"
                  maxLength={40}
                  placeholder="optional, e.g. instagram"
                  className="h-7 flex-1 rounded-md border border-line-2 bg-surface px-2 text-xs outline-none placeholder:text-ink-2 focus:border-accent focus:ring-1 focus:ring-accent"
                  disabled={submitting}
                />
                <datalist id="add-url-found-via">
                  {VIA_SUGGESTIONS.map((v) => (
                    <option key={v} value={v} />
                  ))}
                </datalist>
              </label>
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
                ) : links.length > 1 ? (
                  `Add ${links.length} links`
                ) : (
                  "Add to matches"
                )}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
