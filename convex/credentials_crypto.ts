/** AES-256-GCM encrypt/decrypt for per-user third-party credentials.
 *
 * Pure and testable: no Convex imports, no node built-ins. The Convex runtime
 * provides Web Crypto (crypto.subtle), which every environment here runs, so
 * there is deliberately no "use node" directive and no node `crypto` - a pure
 * JS runtime can both encrypt (putCredential) and decrypt (testCredential /
 * getCredentialFields / resolveGeminiKey).
 *
 * The key is a 32-byte value, base64, supplied by the CREDENTIALS_KEY env var.
 * Rotating CREDENTIALS_KEY invalidates every stored secret (GCM fails the
 * tag), which the friendly error message below explains rather than leaking
 * the raw subtle.encrypt/decrypt failure.
 */

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  // atob lives on the global in the Convex runtime; no node Buffer here.
  const bin = atob(b64);
  // Build on a fresh ArrayBuffer so callers can hand the result to crypto
  // WebCrypto (which rejects ArrayBufferLike inputs under strict typings).
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  // btoa only accepts a binary string, so spread the bytes char-by-char.
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
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
    base64ToBytes(key),
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
      base64ToBytes(key),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
    const decrypted = await subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(iv) },
      keyBytes,
      base64ToBytes(ciphertext),
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
