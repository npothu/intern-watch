// Web-side mirror of convex/oauth_state.ts.
//
// Deliberately NOT marked `server-only`, unlike its neighbours in this folder.
// Two reasons: nothing secret lives here (the signing secret is a parameter, so
// a client-side import could not sign anything), and the guard would break the
// cross-bundle parity test described below, which is the only thing standing
// between a drifted copy and a silent authentication failure. A redundant guard
// is not worth losing the test that matters.
//
// The two halves of the OAuth round trip run in different bundles: this app
// SIGNS the state, and a Convex httpAction VERIFIES it. A Convex module cannot
// be imported into the Next bundle, so the code is duplicated - the same
// arrangement web/lib/profile.ts has with convex/profile_schema.ts.
//
// `convex/oauth_state.ts` is the canonical copy. Duplicated signing code that
// drifts would not fail loudly - it would fail as "sign-in link is invalid",
// which reads like an expired link and would send someone hunting through
// Google Cloud settings instead. So convex/oauth_state.test.ts imports BOTH
// copies and asserts that a state signed by either verifies with the other.
// Change one, run the tests, and the other is flagged immediately.
//
// Deliberately Web Crypto rather than node:crypto, so both copies are the same
// code and the parity test is meaningful.

export type OAuthState = {
  user: string;
  origin: string;
  /** The exact redirect_uri sent to Google - see the canonical copy for why. */
  redirectUri: string;
  nonce: string;
  exp: number;
};

export const STATE_TTL_MS = 10 * 60 * 1000;

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
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

/** A fresh state for a flow started now. */
export function newState(
  user: string,
  origin: string,
  redirectUri: string,
  now: number = Date.now(),
): OAuthState {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return { user, origin, redirectUri, nonce: toBase64Url(bytes), exp: now + STATE_TTL_MS };
}
