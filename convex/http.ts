import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";

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

export default http;
