import { expect, test } from "vitest";
import { decryptJson, encryptJson, maskTail } from "./credentials_crypto";

// Unit tests for the pure crypto layer only. The credential endpoints
// themselves need a live Convex backend (and are exercised by the real
// connections page), so these stay focused on the properties that must hold
// no matter the caller: round-tripping, per-encrypt IV freshness, GCM
// authentication, and safe failure when the key rotates.

const KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="; // 32 bytes of 0..9a-f
const OTHER_KEY = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg=";

test("round trip: decrypt(encrypt(x)) deep-equals x", async () => {
  const value = { apiKey: "AIzaSyD-abc-123", projectId: "proj_123" };
  const sealed = await encryptJson(KEY, value);
  const opened = await decryptJson<typeof value>(KEY, sealed.ciphertext, sealed.iv);
  expect(opened).toEqual(value);
});

test("two encrypts of the same value differ in iv and ciphertext", async () => {
  const value = { token: "the-same-secret-value" };
  const a = await encryptJson(KEY, value);
  const b = await encryptJson(KEY, value);
  expect(a.iv).not.toBe(b.iv);
  expect(a.ciphertext).not.toBe(b.ciphertext);
});

test("decrypting with a different key throws the friendly error", async () => {
  const sealed = await encryptJson(KEY, { n: 1 });
  await expect(
    decryptJson(OTHER_KEY, sealed.ciphertext, sealed.iv),
  ).rejects.toThrow("CREDENTIALS_KEY may have changed");
});

test("tampering with one base64 char of the ciphertext throws", async () => {
  const sealed = await encryptJson(KEY, { n: 1 });
  // Flip a single character in the middle of the ciphertext. GCM must reject
  // this - a changed ciphertext fails the auth tag even if the key is right.
  const chars = sealed.ciphertext.split("");
  const idx = Math.floor(chars.length / 2);
  chars[idx] = chars[idx] === "A" ? "B" : "A";
  const tampered = chars.join("");
  await expect(
    decryptJson(KEY, tampered, sealed.iv),
  ).rejects.toThrow("CREDENTIALS_KEY may have changed");
});

test("maskTail shows only the last 4 chars, and short values are undefined", () => {
  expect(maskTail("AIzaSyDxxxxxxxx7f2c")?.endsWith("7f2c")).toBe(true);
  expect(maskTail("abc")).toBeUndefined();
});
