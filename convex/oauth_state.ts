// Signed state for the Google OAuth round trip.
//
// The consent flow starts on the Next.js server and comes back to a Convex
// httpAction on a DIFFERENT origin, so the callback has no session to read: the
// only thing telling it which tracker user just authorised a mailbox is the
// `state` parameter Google echoes back. That parameter travels through the
// user's browser and through Google, so it must be treated as attacker
// controlled. Unsigned, it would be an account-takeover primitive - anyone
// could hand the callback `state=<someone-else>` and graft their own mailbox,
// or their own refresh token, onto that person's account.
//
// So it is HMAC-SHA256 signed with TRACKER_SECRET, which both sides already
// hold and which never leaves either server. The payload also carries:
//  - `nonce`, so two flows started in different tabs cannot be confused,
//  - `exp`, so a state captured from a browser history or a proxy log stops
//    working (10 minutes is far longer than a consent screen takes),
//  - `origin`, the web app's own origin to return to. Carrying it INSIDE the
//    signature is what makes the redirect safe: the value is written by our
//    own start route and any tampering invalidates the signature, so there is
//    no open redirect and no new environment variable to keep in sync.
//
// Pure and dependency-free (Web Crypto only), so the sign/verify pair is unit
// tested without a deployment on either side.

export type OAuthState = {
  /** Tracker user key the mailbox will be attached to. */
  user: string;
  /** Web app origin to send the browser back to when the exchange finishes. */
  origin: string;
  /** Random per-flow value. */
  nonce: string;
  /** Epoch ms after which this state is refused. */
  exp: number;
};

/** How long a started flow stays valid. Generous next to a consent screen. */
export const STATE_TTL_MS = 10 * 60 * 1000;

// base64url, because the value rides in a query string.
function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return toBase64Url(new Uint8Array(sig));
}

/** `<payload>.<signature>`, safe to put in a URL. */
export async function signState(secret: string, state: OAuthState): Promise<string> {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(state)));
  return `${payload}.${await hmac(secret, payload)}`;
}

/**
 * Verify and decode. Returns null for anything untrustworthy - a bad shape, a
 * bad signature, or an expired state - so the caller has exactly one failure
 * branch and can never accidentally treat a rejected state as usable.
 *
 * `now` is injected so expiry is testable without waiting.
 */
export async function verifyState(
  secret: string,
  raw: string,
  now: number = Date.now(),
): Promise<OAuthState | null> {
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const provided = raw.slice(dot + 1);

  const expected = await hmac(secret, payload);
  // Constant-time-ish compare. The lengths are fixed for a given hash, and
  // bailing early on a length mismatch leaks nothing an attacker cannot see.
  if (provided.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  if (diff !== 0) return null;

  try {
    const decoded = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    const { user, origin, nonce, exp } = decoded as Partial<OAuthState>;
    if (
      typeof user !== "string" ||
      typeof origin !== "string" ||
      typeof nonce !== "string" ||
      typeof exp !== "number" ||
      !user ||
      !origin
    ) {
      return null;
    }
    if (exp <= now) return null;
    return { user, origin, nonce, exp };
  } catch {
    return null;
  }
}

/** A fresh state for a flow started now. */
export function newState(user: string, origin: string, now: number = Date.now()): OAuthState {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return { user, origin, nonce: toBase64Url(bytes), exp: now + STATE_TTL_MS };
}
