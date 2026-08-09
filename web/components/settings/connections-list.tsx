"use client";

// The Connections page's ordered provider list. Kept as data (not copies of
// JSX) so the shared card layout lives in exactly one place and the order is
// explicit.
//
// This list is deliberately SHORT, and shrinking it was the point. It used to
// also collect Browserbase, jobright and SMTP credentials - all of which the
// Convex backend never read. Their real consumers are environment variables in
// the Python pipeline, so the cards stored real secrets (including a jobright
// account password) that did nothing, which is both pure liability and the
// single most phishing-like thing the app did. Do not add a card back here
// until something in convex/ actually reads that credential.
//
// The Gemini card is gone for a different reason: the resume model is no
// longer a required key, so it gets its own card (ResumeModelCard) that leads
// with "this already works" instead of an empty password field.

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ConnectionCard, Pill, type ProviderDef } from "./connection-card";
import { ResumeModelCard } from "./resume-model-card";
import { Button } from "@/components/ui/button";
import { removeCredential } from "@/app/(app)/settings/connections/connections-actions";
import type { CredentialRow, MailSyncStatus, ResumeLlm } from "@/lib/convex";

/** Providers the resume-model card owns. Their rows are keys, not orphans. */
const LLM_PROVIDERS = ["gemini", "anthropic", "openai", "openrouter"];

export const PROVIDERS: ProviderDef[] = [
  {
    provider: "google",
    icon: "M",
    accent: true,
    title: "Google - Gmail",
    why: "Watches application email and moves tracker rows to interviewing, offer or rejected on its own.",
    linkHref: "/settings/connections/google",
  },
];

export function ConnectionsList({
  rows,
  llm,
  mailSync,
}: {
  rows: CredentialRow[];
  llm: ResumeLlm;
  mailSync: MailSyncStatus;
}) {
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  // Anything stored that no card on this page can now show or delete.
  const orphaned = rows.filter(
    (r) =>
      !LLM_PROVIDERS.includes(r.provider) &&
      !PROVIDERS.some((p) => p.provider === r.provider),
  );

  // These four buckets are exhaustive on purpose: every provider lands in
  // exactly one, so the counts always sum to PROVIDERS.length. An earlier
  // version counted only ok / error / missing, which silently dropped a saved
  // but never-tested row - the page then read "0 connected, 0 needs attention,
  // 4 not set up" while showing five cards, one of them saved.
  const known = PROVIDERS.filter((p) => byProvider.has(p.provider)).map(
    (p) => byProvider.get(p.provider)!
  );
  const connected = known.filter((r) => r.status === "ok").length;
  const needsAttention = known.filter((r) => r.status === "error").length;
  const saved = known.filter((r) => r.status !== "ok" && r.status !== "error").length;
  const notSetUp = PROVIDERS.length - known.length;

  // Only non-empty buckets are shown, so the row stays short once things are
  // configured, but what is shown always adds up to the number of cards below.
  // Declared as its own const so the object literals get the contextual type;
  // chaining .filter() directly onto an annotated literal widens `variant`
  // back to plain string.
  const allPills: { key: string; variant: "ok" | "err" | "warn" | "off"; label: string }[] = [
    { key: "ok", variant: "ok", label: `${connected} connected` },
    { key: "err", variant: "err", label: `${needsAttention} needs attention` },
    { key: "saved", variant: "warn", label: `${saved} saved, not tested` },
    { key: "off", variant: "off", label: `${notSetUp} not set up` },
  ];
  const summary = allPills.filter((s) => !s.label.startsWith("0 "));

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[12px]">
        {summary.map((s) => (
          <Pill key={s.key} variant={s.variant}>
            {s.label}
          </Pill>
        ))}
      </div>

      <div className="flex flex-col gap-2.5">
        {/* First, because it is the one every user has - it needs no setup and
            it is the card most likely to answer "can I change the model?". */}
        <ResumeModelCard llm={llm} keysByProvider={Object.fromEntries(byProvider)} />
        {/* Mail-sync is opt-in. When the deployment never set it up, say so
            plainly and name the missing variables - a card that just sits
            there unconnected reads as broken rather than as switched off. */}
        {!mailSync.enabled && (
          <div className="rounded-md border border-dashed border-line bg-surface px-4 py-3.5">
            <div className="text-[13px] font-semibold text-ink">
              Mail-sync is off on this deployment
            </div>
            <p className="mt-1 text-[12px] text-ink-2">
              Everything else works without it. Turn it on by setting{" "}
              {mailSync.missing.length ? (
                <>
                  {mailSync.missing.map((m, i) => (
                    <span key={m}>
                      {i > 0 && ", "}
                      <code className="rounded bg-chip px-1 py-0.5 font-mono text-[11px]">
                        {m}
                      </code>
                    </span>
                  ))}{" "}
                </>
              ) : (
                "the Gmail variables "
              )}
              on the deployment, then connecting Google below.
            </p>
          </div>
        )}
        {PROVIDERS.map((def) => (
          <ConnectionCard key={def.provider} def={def} row={byProvider.get(def.provider)} />
        ))}

        {/* Credentials saved through cards that no longer exist. Removing the
            collection UI does not remove the collected data: those rows stay
            encrypted in the database, and without this there would be nowhere
            in the app to delete a jobright password or a Browserbase key the
            backend never reads. Shown only when such a row actually exists. */}
        <OrphanedCredentials rows={orphaned} />
      </div>
    </>
  );
}

function OrphanedCredentials({ rows }: { rows: CredentialRow[] }) {
  const [gone, setGone] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const left = rows.filter((r) => !gone.includes(r.provider));
  if (!left.length) return null;

  const drop = (provider: string) => {
    start(async () => {
      const res = await removeCredential(provider);
      if (res.ok) {
        setGone((g) => [...g, provider]);
        toast.success(`Removed the stored ${provider} credential.`);
      } else {
        toast.error(res.error);
      }
    });
  };

  return (
    <div className="rounded-md border border-amber/45 bg-amber/5 px-4 py-3.5">
      <div className="text-[13px] font-semibold text-ink">No longer used</div>
      <p className="mt-1 text-[12px] text-ink-2">
        These were saved by an older version of this page. Nothing reads them
        any more, so they are worth deleting.
      </p>
      <div className="mt-2.5 flex flex-col gap-1.5">
        {left.map((r) => (
          <div key={r.provider} className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] font-medium text-ink">{r.provider}</span>
            {r.hint && (
              <code className="rounded bg-chip px-1.5 py-0.5 font-mono text-[11px] text-ink-2">
                {r.hint}
              </code>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="text-red"
              disabled={pending}
              onClick={() => drop(r.provider)}
            >
              Remove
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
