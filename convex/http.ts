import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { verifyState } from "./oauth_state";

const http = httpRouter();

// Gmail push delivery (Pub/Sub push subscription).
//
// This handler is a DOORBELL ONLY. Pub/Sub gives the handler ~10s to ack, and
// any real Gmail work blows that deadline, so the handler merely validates the
// push token, decodes the envelope, stamps lastPushAt via notePush, and
// schedules the internal `sync` action to do the actual work. Everything here
// must stay O(ms).
//
// A valid-token push is ALWAYS acked (204), even when the body is malformed -
// a 500 would make Pub/Sub retry-storm. The retry concerns of a bad payload
// are Pub/Sub's problem to solve by tuning the subscription, not ours.

http.route({
  path: "/gmail/push",
  method: "POST",
  handler: async (ctx, request) => {
    const token = new URL(request.url).searchParams.get("token");
    if (token !== process.env.MAIL_PUSH_TOKEN) {
      return new Response("forbidden", { status: 403 });
    }

    let emailAddress: string | undefined;
    try {
      const body: unknown = await request.json();
      const data =
        typeof body === "object" && body !== null && "message" in body
          ? (body as { message: { data?: unknown } }).message?.data
          : undefined;
      if (typeof data === "string") {
        // The envelope's message.data is base64-encoded JSON of the push
        // payload: { emailAddress, historyId } (historyId is unused in Phase 1
        // but is what a later phase resumes the history cursor from).
        // Web-standard atob/TextDecoder, NOT Buffer: HTTP actions run in
        // Convex's default runtime, which has no Node globals (the test VM
        // does, so a Buffer regression would pass tests and die in prod).
        const bin = atob(data);
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        const decoded = JSON.parse(new TextDecoder().decode(bytes));
        emailAddress = typeof decoded.emailAddress === "string" ? decoded.emailAddress : undefined;
      }
    } catch (err) {
      // Malformed body with a valid token still acks (204) so Pub/Sub doesn't
      // retry-storm on a bad payload.
      console.warn("malformed gmail push body", err);
    }

    if (emailAddress) {
      await ctx.runMutation(internal.mail.notePush, { email: emailAddress });
    }
    // 204 must not carry a body (Fetch spec) - a body would throw.
    return new Response(null, { status: 204 });
  },
});

// Google OAuth callback.
//
// It lives here, on the Convex SITE origin, rather than on the Next app for one
// reason: this is where the refresh token can be exchanged and encrypted
// without ever crossing another process. The web app never sees the token, so
// there is no second place it could be logged, cached, or leaked.
//
// The consequence is that this handler has NO session - it is reached by a
// browser redirect from Google, not by a call from the app. Everything it needs
// to know about who authorised comes from the signed `state` (oauth_state.ts).
//
// Every exit path here is a REDIRECT back to the wizard rather than a bare
// error page: a user who lands on raw JSON at the end of an OAuth dance has no
// idea what to do next.
http.route({
  path: "/gmail/callback",
  method: "GET",
  handler: async (ctx, request) => {
    const url = new URL(request.url);
    const rawState = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code");
    const googleError = url.searchParams.get("error");

    const secret = process.env.TRACKER_SECRET;
    const state = secret ? await verifyState(secret, rawState) : null;

    // With no trustworthy state there is nowhere safe to send the browser: the
    // return origin lives INSIDE the signature, so a tampered state has no
    // usable origin either. This is the one path that must answer in plain
    // text, and it deliberately says nothing about why.
    if (!state) {
      return new Response(
        "This sign-in link is invalid or has expired. Start the connection again from Settings.",
        { status: 400, headers: { "Content-Type": "text/plain" } },
      );
    }

    // Never throws. state.origin is a free-text env var upstream (APP_ORIGIN),
    // so a value like "jobs.example.com" with no scheme makes `new URL` throw -
    // and it threw AFTER the mailbox was already connected, inside the try,
    // whose catch called this same helper and threw identically. The user ended
    // a successful consent flow on a bare 500 and retried, burning a nonce and
    // re-storing the token each time.
    // Never throws. state.origin comes from APP_ORIGIN, a free-text env var, so
    // a value like "jobs.example.com" with no scheme makes `new URL` throw -
    // and it threw AFTER the mailbox was connected, inside the try whose catch
    // called this same helper and threw identically, ending a successful
    // consent flow on a bare 500.
    //
    // `connected` says whether the mailbox actually got linked before we lost
    // the ability to redirect. Without it this page told a user who pressed
    // Cancel that their mailbox "may have been connected", which is both wrong
    // and alarming.
    const back = (params: Record<string, string>, connected = false) => {
      let target: URL;
      try {
        target = new URL("/settings/connections/google", state.origin);
      } catch {
        return new Response(
          connected
            ? "Your mailbox was connected, but this deployment's APP_ORIGIN is not a valid URL (it needs an https:// prefix), so you could not be sent back automatically. Open Settings to confirm."
            : "Google sign-in did not complete, and this deployment's APP_ORIGIN is not a valid URL (it needs an https:// prefix), so you could not be sent back automatically. Open Settings to try again.",
          { status: 500, headers: { "Content-Type": "text/plain" } },
        );
      }
      for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v);
      return new Response(null, { status: 302, headers: { Location: target.toString() } });
    };

    // The user pressed Cancel on Google's consent screen, or Google refused.
    if (googleError) return back({ googleError });
    if (!code) return back({ googleError: "no_code" });

    // Spend the nonce BEFORE the exchange. A signature only proves this state
    // was issued by us, never that it has not already been used, and the value
    // is visible in browser history and proxy logs - so without this a captured
    // state could be replayed with a code from the attacker's own consent to
    // repoint the victim's mailbox.
    const fresh = await ctx.runMutation(internal.mail.consumeOAuthNonce, {
      nonce: state.nonce,
      user: state.user,
    });
    if (!fresh) {
      return back({
        googleError:
          "This sign-in link was already used or has expired. Start the connection again.",
      });
    }

    try {
      const email = await ctx.runAction(internal.mail.completeOAuth, {
        user: state.user,
        code,
        // The value THIS flow actually sent to Google, carried in the signed
        // state rather than rebuilt here - see oauth_state.ts.
        redirectUri: state.redirectUri,
      });
      // Second argument: the mailbox IS linked at this point, so if the
      // redirect itself fails the message must say so rather than imply doubt.
      return back({ connected: email }, true);
    } catch (err) {
      // The real reason (bad client secret, mismatched redirect URI, revoked
      // consent) is the only thing that makes this fixable, so it rides back to
      // the wizard instead of being swallowed into a generic failure.
      return back({
        googleError: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      });
    }
  },
});

export default http;
