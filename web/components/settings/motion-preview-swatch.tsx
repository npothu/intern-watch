"use client";

import { useState } from "react";

/**
 * Small, self-contained proof that the setting actually did something -
 * click Replay and watch (or don't). Deliberately driven by a real CSS
 * `animation` with a delay and `fill: both`, the same shape as the app's
 * other entrance animations, so this swatch exercises the actual
 * `@media`/`data-reduce-motion` suppression rules in globals.css rather than
 * just reflecting the setting back as text. The keyframes are scoped to this
 * component (kept next to the thing that owns them, the pattern lib/motion.ts
 * uses for its WAAPI keyframes) rather than added to globals.css.
 */
export function MotionPreviewSwatch({ suppressed }: { suppressed: boolean }) {
  const [token, setToken] = useState(0);

  return (
    <div className="flex items-center gap-3">
      <style>{`
        @keyframes iwSettingsPreview {
          from { opacity: 0; transform: translateY(6px) scale(0.92); }
          to   { opacity: 1; transform: none; }
        }
      `}</style>
      <button
        type="button"
        onClick={() => setToken((t) => t + 1)}
        className="rounded-md border border-line-2 bg-bg px-2.5 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:border-ink-2"
      >
        Replay
      </button>
      <div
        key={token}
        aria-hidden
        className="size-6 shrink-0 rounded-[6px] bg-accent"
        style={{
          animation: "iwSettingsPreview 550ms cubic-bezier(0.34, 1.56, 0.64, 1) 160ms both",
        }}
      />
      <span className="text-[12px] text-ink-2">
        {suppressed ? "instant - motion suppressed" : "animates in"}
      </span>
    </div>
  );
}
