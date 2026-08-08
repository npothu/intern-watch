"use client";

import { useState } from "react";

/**
 * A read-only, one-click-to-copy value line used throughout the Google wizard
 * to hand the user exact strings to paste elsewhere (the OAuth redirect URI,
 * the push endpoint). Wraps or scrolls horizontally rather than pushing the
 * page out of shape on narrow screens.
 */

const FACE =
  "w-full min-w-0 rounded-md border border-line-2 bg-chip px-2.5 py-1.5 font-mono text-[11.5px] text-ink outline-none focus:border-accent";
const COPY =
  "flex shrink-0 items-center gap-1 rounded-md border border-line bg-surface px-2.5 py-1.5 text-[11.5px] font-medium text-ink";

export function CopyField({
  value,
  label,
  multiline = false,
}: {
  value: string;
  /** Optional label shown above the field. */
  label?: string;
  /** Taller textarea for longer strings that should wrap instead of scroll. */
  multiline?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      // Revert the button label after a beat so the next copy reads fresh.
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. permission denied) - keep the field
      // selectable so the value is still reachable by hand.
      setCopied(false);
    }
  }

  return (
    <div className="min-w-0">
      {label && (
        <span className="mb-1 block text-[12px] text-ink-2">{label}</span>
      )}
      <div className="flex items-start gap-[7px] min-w-0">
        {multiline ? (
          <textarea
            readOnly
            value={value}
            aria-label={label ?? "Copyable value"}
            spellCheck={false}
            rows={2}
            className={`${FACE} resize-none break-words leading-snug`}
          />
        ) : (
          <input
            readOnly
            value={value}
            aria-label={label ?? "Copyable value"}
            spellCheck={false}
            onFocus={(e) => e.currentTarget.select()}
            className={`${FACE} truncate`}
          />
        )}
        <button type="button" onClick={onCopy} className={COPY}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
