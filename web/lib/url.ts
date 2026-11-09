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
