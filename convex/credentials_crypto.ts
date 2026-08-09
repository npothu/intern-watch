/** AES-256-GCM encrypt/decrypt for per-user third-party credentials.
 *
 * Pure and testable: no Convex imports, no node built-ins. The Convex runtime
 * provides Web Crypto (crypto.subtle), which every environment here runs, so
 * there is deliberately no "use node" directive and no node `crypto` - a pure
 * JS runtime can both encrypt (putCredential) and decrypt (testCredential /
 * getCredentialFields / resolveProviderKey).
 *
 * The key is a 32-byte value, base64, supplied by the CREDENTIALS_KEY env var.
 * Rotating CREDENTIALS_KEY invalidates every stored secret (GCM fails the
 * tag), which the friendly error message below explains rather than leaking
 * the raw subtle.encrypt/decrypt failure.
 */

/**
 * Returns a real `ArrayBuffer`, not a `Uint8Array`, and that is deliberate:
 * this file has to typecheck under TWO compilers with different lib
 * definitions. Convex bundles an older TypeScript that rejects the
 * `Uint8Array<ArrayBuffer>` generic form outright ("Type 'Uint8Array' is not
 * generic"), while the web workspace's newer one resolves a bare `Uint8Array`
 * to `Uint8Array<ArrayBufferLike>`, which is NOT assignable to WebCrypto's
 * `BufferSource`. `ArrayBuffer` has no type parameter and is a valid
 * BufferSource in both, so it is the one spelling that satisfies each.
 */
function base64ToBuffer(b64: string): ArrayBuffer {
  // atob lives on the global in the Convex runtime; no node Buffer here.
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

function bytesToBase64(bytes: Uint8Array): string {
  // btoa only accepts a binary string, so spread the bytes char-by-char.
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * The deployment's AES key. Throwing on an unset key is the only way to
 * guarantee we never silently store or read plaintext with a bogus key.
 * Lives here rather than in credentials.ts because mail.ts needs it too - the
 * Gmail refresh token is encrypted with the same key.
 */
export function credentialsKey(): string {
  const k = process.env.CREDENTIALS_KEY;
  if (!k) throw new Error("CREDENTIALS_KEY is not set on this deployment");
  return k;
}

/** AES-256-GCM. The key is a 32-byte value, base64, from the CREDENTIALS_KEY env var. */
export async function encryptJson(
  key: string,
  value: unknown,
): Promise<{ ciphertext: string; iv: string }> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("credentials: Web Crypto (crypto.subtle) is unavailable");
  const keyBytes = await subtle.importKey(
    "raw",
    base64ToBuffer(key),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  // Fresh random 12-byte IV per encrypt; a fixed IV would let an attacker xor
  // two ciphertexts that share a plaintext prefix.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  // Copy onto an ArrayBuffer so the WebCrypto typing is satisfied.
  const plaintext = new Uint8Array(encoded);
  const encrypted = await subtle.encrypt(
    { name: "AES-GCM", iv },
    keyBytes,
    plaintext,
  );
  // Encrypted is the ciphertext with the GCM auth tag appended - keep them
  // together so the decrypt path can hand it straight back to subtle.
  return {
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(iv),
  };
}

/** Decrypt a value produced by encryptJson, or throw if the key changed. */
export async function decryptJson<T>(
  key: string,
  ciphertext: string,
  iv: string,
): Promise<T> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("credentials: Web Crypto (crypto.subtle) is unavailable");
  try {
    const keyBytes = await subtle.importKey(
      "raw",
      base64ToBuffer(key),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    const decrypted = await subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBuffer(iv) },
      keyBytes,
      base64ToBuffer(ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(decrypted)) as T;
  } catch {
    // The most common cause of a GCM tag failure is a rotated key; surface
    // that instead of the raw crypto error, which varies by runtime.
    throw new Error("credentials: decrypt failed - CREDENTIALS_KEY may have changed");
  }
}

/** "AIzaSyD...7f2c" style. Returns undefined for values shorter than 8 chars. */
export function maskTail(secret: string): string | undefined {
  if (secret.length < 8) return undefined;
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}
