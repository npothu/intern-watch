"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function ResumeJdPrompt({
  open,
  company,
  title,
  onOpenChange,
  onBuildWithoutJd,
  onSaveAndBuild,
}: {
  open: boolean;
  company: string;
  title: string;
  onOpenChange: (open: boolean) => void;
  onBuildWithoutJd: () => void;
  onSaveAndBuild: (jdText: string) => void;
}) {
  const [jdText, setJdText] = useState("");

  const clean = jdText.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-amber" />
            Add the job description first?
          </DialogTitle>
          <DialogDescription>
            No job description is saved for {title} at {company}. Without one,
            the builder will try the posting URL and may have to tailor from only
            the job title.
          </DialogDescription>
        </DialogHeader>

        <div>
          <label
            htmlFor="resume-build-jd"
            className="mb-1.5 block text-[12px] font-medium text-ink"
          >
            Job description
          </label>
          <textarea
            id="resume-build-jd"
            value={jdText}
            maxLength={20_000}
            onChange={(event) => setJdText(event.target.value)}
            placeholder="Paste the full job description here..."
            className="min-h-[180px] w-full resize-y rounded-md border border-line-2 bg-bg px-3 py-2 text-[12.5px] text-ink outline-none transition-colors placeholder:text-ink-2 focus:border-accent"
          />
          <p className="mt-1 text-[11px] text-ink-2">
            Saved to this job and reused for future rebuilds and edit requests.
          </p>
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <Button variant="ghost" onClick={onBuildWithoutJd}>
            Build without JD
          </Button>
          <Button disabled={!clean} onClick={() => onSaveAndBuild(clean)}>
            Save JD and build
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
