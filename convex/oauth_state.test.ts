import { describe, expect, test } from "vitest";
import { newState, signState, verifyState, STATE_TTL_MS } from "./oauth_state";
// The web-side mirror. Importing both here is the whole point of this file:
// the signer and the verifier live in different bundles and cannot import each
// other, so nothing but a test can prove they still agree.
import {
  newState as webNewState,
  signState as webSignState,
} from "../web/lib/oauth-state";

const SECRET = "test-tracker-secret";
const OTHER = "a-different-secret";

describe("oauth state: signing", () => {
  test("a state signed here verifies here", async () => {
    const s = newState("nathan", "https://app.example.com", "https://x.convex.site/gmail/callback");
    const signed = await signState(SECRET, s);
    await expect(verifyState(SECRET, signed)).resolves.toEqual(s);
  });

  test("a state signed by the WEB mirror verifies on the Convex side", async () => {
    // This is the real production path: the Next route signs, the Convex
    // httpAction verifies. If the two copies drift, this fails here rather
    // than as an unexplained "invalid or expired link" in someone's browser.
    const s = webNewState("nathan", "https://app.example.com", "https://x.convex.site/gmail/callback");
    const signed = await webSignState(SECRET, s);
    await expect(verifyState(SECRET, signed)).resolves.toEqual(s);
  });

  test("both copies produce byte-identical output for the same input", async () => {
    const s = { user: "u", origin: "https://x.test", redirectUri: "https://x.convex.site/gmail/callback", nonce: "n", exp: 1 };
    expect(await webSignState(SECRET, s)).toBe(await signState(SECRET, s));
  });

  test("the mirrors agree on the TTL", async () => {
    const a = newState("u", "https://x.test", "https://x.convex.site/gmail/callback", 1000);
    const b = webNewState("u", "https://x.test", "https://x.convex.site/gmail/callback", 1000);
    expect(a.exp).toBe(b.exp);
    expect(a.exp).toBe(1000 + STATE_TTL_MS);
  });
});

describe("oauth state: rejection", () => {
  test("a different secret does not verify", async () => {
    const signed = await signState(SECRET, newState("nathan", "https://app.example.com", "https://x.convex.site/gmail/callback"));
    await expect(verifyState(OTHER, signed)).resolves.toBeNull();
  });

  test("tampering with the user is rejected", async () => {
    // The attack this defends against: swapping the user so a mailbox is
    // grafted onto someone else's account.
    const signed = await signState(SECRET, newState("victim", "https://app.example.com", "https://x.convex.site/gmail/callback"));
    const [payload, sig] = signed.split(".");
    const decoded = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
    );
    decoded.user = "attacker";
    const forged = Buffer.from(JSON.stringify(decoded))
      .toString("base64url");
    await expect(verifyState(SECRET, `${forged}.${sig}`)).resolves.toBeNull();
  });

  test("tampering with the return origin is rejected", async () => {
    // The origin rides inside the signature precisely so this cannot become an
    // open redirect.
    const signed = await signState(SECRET, newState("nathan", "https://app.example.com", "https://x.convex.site/gmail/callback"));
    const [payload, sig] = signed.split(".");
    const decoded = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
    );
    decoded.origin = "https://evil.example.com";
    const forged = Buffer.from(JSON.stringify(decoded)).toString("base64url");
    await expect(verifyState(SECRET, `${forged}.${sig}`)).resolves.toBeNull();
  });

  test("an expired state is rejected", async () => {
    const s = newState("nathan", "https://app.example.com", "https://x.convex.site/gmail/callback", 0);
    const signed = await signState(SECRET, s);
    await expect(verifyState(SECRET, signed, STATE_TTL_MS + 1)).resolves.toBeNull();
    // ...and is still good just before it lapses.
    await expect(verifyState(SECRET, signed, STATE_TTL_MS - 1)).resolves.toEqual(s);
  });

  test("garbage shapes are rejected rather than throwing", async () => {
    for (const bad of ["", ".", "nodot", "a.b", "....", "%%%.%%%"]) {
      await expect(verifyState(SECRET, bad)).resolves.toBeNull();
    }
  });

  test("a well-signed payload missing required fields is rejected", async () => {
    // Signature valid, contents useless - the verifier must not hand a caller
    // a half-built state just because the HMAC checked out.
    const payload = Buffer.from(JSON.stringify({ user: "u" })).toString("base64url");
    const signed = await signState(SECRET, { user: "u" } as never);
    const sig = signed.split(".")[1];
    await expect(verifyState(SECRET, `${payload}.${sig}`)).resolves.toBeNull();
  });
});
