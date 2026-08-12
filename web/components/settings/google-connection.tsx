import Link from "next/link";
import { CheckCircle2, Mail, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

export function GoogleConnection({
  available,
  connectedEmail,
  alreadyConnectedEmail,
  oauthError,
}: {
  /** Whether the deployment operator has configured every OAuth prerequisite. */
  available: boolean;
  /** The mailbox connected by the callback that led to this render. */
  connectedEmail?: string;
  /** The mailbox already connected before this visit. */
  alreadyConnectedEmail?: string;
  /** A failed or cancelled OAuth callback. */
  oauthError?: string;
}) {
  const currentEmail = connectedEmail ?? alreadyConnectedEmail;

  return (
    <div className="mx-auto w-full max-w-[560px] px-5 pb-24 pt-5">
      <div className="mb-4 flex min-w-0 items-center gap-2.5">
        <Link
          href="/settings/connections"
          className="shrink-0 text-[12px] font-medium text-accent hover:underline"
        >
          &larr; Connections
        </Link>
        <h1 className="min-w-0 text-[15px] font-semibold text-ink">Connect Gmail</h1>
      </div>

      <section className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="border-b border-line px-5 py-5">
          <div className="flex items-start gap-3.5">
            <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
              <Mail aria-hidden className="size-5" />
            </div>
            <div className="min-w-0">
              <h2 className="text-[15px] font-semibold text-ink">
                {currentEmail ? "Gmail is connected" : "Connect your Gmail account"}
              </h2>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
                Intern Watch reads application-related email to keep your tracker updated with
                interviews, offers, and rejections.
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-4 px-5 py-5">
          {connectedEmail && (
            <div className="flex items-start gap-2.5 rounded-md border border-accent/35 bg-accent/10 px-3 py-2.5">
              <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" />
              <div className="min-w-0">
                <p className="text-[12.5px] font-medium text-accent">Connection complete</p>
                <p className="mt-0.5 break-all font-mono text-[11.5px] text-ink-2">
                  {connectedEmail}
                </p>
              </div>
            </div>
          )}

          {oauthError && (
            <div className="rounded-md border border-red/35 bg-red/10 px-3 py-2.5">
              <p className="text-[12.5px] font-medium text-red">
                Google sign-in did not finish
              </p>
              <p className="mt-1 break-words text-[11.5px] text-ink-2">{oauthError}</p>
              {alreadyConnectedEmail && (
                <p className="mt-1.5 text-[11.5px] text-ink-2">
                  Your existing Gmail connection is still active.
                </p>
              )}
            </div>
          )}

          {!connectedEmail && currentEmail && (
            <div className="rounded-md border border-line bg-bg px-3 py-2.5">
              <p className="text-[11px] font-medium uppercase tracking-[0.07em] text-ink-2">
                Connected account
              </p>
              <p className="mt-1 break-all font-mono text-[12px] text-ink">{currentEmail}</p>
            </div>
          )}

          {available ? (
            <div>
              <Button asChild className="w-full sm:w-auto">
                <a href="/api/google/start">
                  {currentEmail ? "Choose a different Gmail account" : "Continue with Google"}
                </a>
              </Button>
              {currentEmail && (
                <p className="mt-2 text-[11.5px] text-ink-2">
                  Connecting another account replaces the current Gmail connection.
                </p>
              )}
            </div>
          ) : (
            <div className="rounded-md border border-amber/35 bg-amber/10 px-3 py-2.5">
              <p className="text-[12.5px] font-medium text-amber">
                Gmail connection is temporarily unavailable
              </p>
              <p className="mt-1 text-[11.5px] text-ink-2">
                The deployment administrator needs to finish configuring Google sign-in.
              </p>
            </div>
          )}

          <div className="flex items-start gap-2 border-t border-line pt-4 text-[11.5px] leading-relaxed text-ink-2">
            <ShieldCheck aria-hidden className="mt-0.5 size-3.5 shrink-0 text-accent" />
            <p>
              Access is read-only. Intern Watch cannot send, edit, or delete your email, and you
              can revoke access from your Google account at any time.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
