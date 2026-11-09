/**
 * What the Add URL dialog's field holds when it opens: the prefill the opener
 * passed (the palette's pasted link), trimmed, or empty. Never the previous
 * session's text - a Cancel or a bare "Add a job URL" must start clean.
 */
export function addUrlFieldOnOpen(detail: unknown): string {
  return typeof detail === "string" ? detail.trim() : "";
}

/** True when `text` is an absolute http(s) URL worth offering to ingest -
 *  the command palette's cue to offer "Add this job URL" for a paste. */
export function looksLikeUrl(text: string): boolean {
  const t = text.trim();
  if (!/^https?:\/\/\S+$/i.test(t)) return false;
  try {
    return Boolean(new URL(t).hostname);
  } catch {
    return false;
  }
}
