"use client";

import { useEffect, useRef, useState } from "react";
import type { ProfileV2 } from "@/lib/profile";

/** Displays the exact PDF export, including every page and its real wrapping. */
export function ComposePreview({
  profile,
  variant,
  onPages,
}: {
  profile: ProfileV2;
  variant: string;
  onPages: (pages: number | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [rendered, setRendered] = useState("");
  const [retry, setRetry] = useState(0);
  const draft = JSON.stringify(profile);
  const revision = variant + draft + retry;
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let loading: import("pdfjs-dist").PDFDocumentLoadingTask | undefined;
    onPages(null);
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/resume/export", {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: draft, variant, format: "pdf" }),
        });
        if (!response.ok)
          throw new Error("Preview could not be rendered. Try again.");
        const data = await response.arrayBuffer();
        const pdfjs = await import("pdfjs-dist");
        if (disposed) return;
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/build/pdf.worker.min.mjs",
          import.meta.url,
        ).toString();
        loading = pdfjs.getDocument({ data });
        const pdf = await loading.promise;
        const fragment = document.createDocumentFragment();
        for (let index = 1; index <= pdf.numPages; index++) {
          const page = await pdf.getPage(index);
          if (disposed) return;
          const viewport = page.getViewport({ scale: 1.75 });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.className = "mb-4 h-auto w-full bg-white shadow-sm";
          canvas.setAttribute("role", "img");
          canvas.setAttribute(
            "aria-label",
            `Resume page ${index} of ${pdf.numPages}`,
          );
          await page.render({ canvas, viewport }).promise;
          fragment.appendChild(canvas);
        }
        if (disposed) return;
        host.current?.replaceChildren(fragment);
        setError("");
        setRendered(revision);
        onPages(pdf.numPages);
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : "Preview failed.");
          setRendered(revision);
        }
      }
    }, 650);
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
      void loading?.destroy();
    };
  }, [draft, variant, revision, onPages]);
  const updating = rendered !== revision;
  return (
    <div className="rounded-lg border border-line bg-chip/60 p-3 sm:p-4">
      <div className="mb-3 flex items-center justify-between text-xs text-ink-2">
        <span>PDF preview · US Letter</span>
        <span role="status">
          {updating ? "Updating…" : error ? "Unavailable" : "Up to date"}
        </span>
      </div>
      {error && !updating && (
        <div
          role="alert"
          className="mb-3 rounded-md bg-surface p-3 text-sm text-red"
        >
          {error}{" "}
          <button className="underline" onClick={() => setRetry((n) => n + 1)}>
            Retry
          </button>
        </div>
      )}
      <div
        ref={host}
        className={updating ? "opacity-40" : ""}
        aria-busy={updating}
      />
      {!rendered && (
        <div className="aspect-[612/792] animate-pulse rounded bg-surface" />
      )}
    </div>
  );
}
