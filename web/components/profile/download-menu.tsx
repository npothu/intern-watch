"use client";

// "Download resume" for the profile editor: the whole bank for the selected
// variant, as a PDF or a DOCX, exactly as it stands - no JD, no tailoring, no
// one-page fit. The per-match builds on the Matches page are the fitted ones.
//
// The draft is posted as-is so the file matches the screen even while an
// autosave is still pending; the route re-checks the session and the size cap
// server-side.

import { useState } from "react";
import { toast } from "sonner";
import { Download, FileText, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ProfileV2, Variant } from "@/lib/profile";
import { filenameFromDisposition, saveBlob } from "@/lib/download";

type Format = "pdf" | "docx";

const FORMATS: { format: Format; label: string; hint: string }[] = [
  { format: "pdf", label: "PDF", hint: "Ready to send" },
  { format: "docx", label: "Word (.docx)", hint: "Editable" },
];

export function DownloadMenu(props: {
  profile: ProfileV2;
  variant: Variant;
  className?: string;
}) {
  const { profile, variant, className } = props;
  const [busy, setBusy] = useState<Format | null>(null);

  const download = async (format: Format) => {
    if (busy) return;
    setBusy(format);
    try {
      const res = await fetch("/api/resume/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: JSON.stringify(profile),
          variant,
          format,
        }),
      });
      if (!res.ok) {
        let message = "Couldn't download the resume.";
        try {
          const data = (await res.json()) as { error?: string };
          if (data.error) message = data.error;
        } catch {
          // non-JSON error body - keep the generic message
        }
        throw new Error(message);
      }
      const blob = await res.blob();
      const fallback = `resume${variant === "base" ? "" : `_${variant}`}.${format}`;
      saveBlob(blob, filenameFromDisposition(res.headers.get("Content-Disposition")) ?? fallback);
    } catch (err) {
      toast.error((err as Error).message || "Couldn't download the resume.");
    } finally {
      setBusy(null);
    }
  };

  const title = `Download the full ${variant} resume`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={busy !== null}
          aria-label={title}
          title={title}
          className={className}
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Download className="size-3.5" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="font-normal">
          Full <span className="font-semibold text-ink">{variant}</span> resume, as
          written - not fitted to one page
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {FORMATS.map((f) => (
          <DropdownMenuItem key={f.format} onSelect={() => void download(f.format)}>
            <FileText className="size-4 text-ink-2" />
            {f.label}
            <span className="ml-auto text-[11px] text-ink-2">{f.hint}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
