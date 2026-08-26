/**
 * Save a fetched file with the browser's native download, using the name the
 * server chose. Pure helpers first so the parsing is unit-testable; the DOM
 * part is a one-liner.
 */

/**
 * The filename in a Content-Disposition header, preferring the RFC 5987
 * `filename*=UTF-8''...` form over the quoted ASCII fallback. Null when the
 * header names nothing usable.
 */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (encoded) {
    try {
      const name = decodeURIComponent(encoded[1].trim());
      if (name) return name;
    } catch {
      // fall through to the plain form
    }
  }
  const quoted = /filename\s*=\s*"([^"]*)"/.exec(header);
  if (quoted?.[1]) return quoted[1];
  const bare = /filename\s*=\s*([^;\s"]+)/.exec(header);
  return bare?.[1] || null;
}

/** Trigger a native download of `blob` as `filename`. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has been handed to the download manager; revoking
  // synchronously makes some browsers abort the save.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
