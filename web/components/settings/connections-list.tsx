"use client";

// The Connections page's ordered provider list. Kept as data (not five copies
// of JSX) so the card rendering, whose layout is shared, lives in exactly one
// place and the order is explicit. Gemini is first and required: the first-run
// state the mock's warning describes is just this card absent with its
// emphasized border.

import { ConnectionCard, Pill, type ProviderDef } from "./connection-card";
import type { CredentialRow } from "@/lib/convex";

export const PROVIDERS: ProviderDef[] = [
  {
    provider: "gemini",
    icon: "G",
    accent: true,
    title: "Gemini",
    why: "Classifies ambiguous jobs, scores resumes against a JD, and triages your inbox.",
    required: true,
    model: "gemini-flash-lite-latest",
    fields: [{ key: "apiKey", label: "API key", type: "password", placeholder: "AIza..." }],
  },
  {
    provider: "google",
    icon: "M",
    accent: true,
    title: "Google - Gmail",
    why: "Watches application email and moves tracker rows to interviewing, offer or rejected on its own.",
    linkHref: "/settings/connections/google",
  },
  {
    provider: "browserbase",
    icon: "B",
    title: "Browserbase",
    why: "Required for auto-apply. Until it is set, the Apply button stays manual.",
    fields: [
      { key: "apiKey", label: "API key", type: "password", placeholder: "bb_live_...", mono: true },
      { key: "projectId", label: "Project ID", type: "text", placeholder: "0d3f1c2e-...", mono: true },
    ],
  },
  {
    provider: "jobright",
    icon: "j",
    title: "jobright.ai",
    why: "Turns jobright match links into the employer's real apply URL. Without it, matches still arrive, they just point at jobright.",
    fields: [
      { key: "email", label: "Email", type: "text", placeholder: "you@example.com" },
      { key: "password", label: "Password", type: "password", placeholder: "••••••••" },
    ],
  },
  {
    provider: "smtp",
    icon: "@",
    title: "Digest email",
    why: "Sends the batched match email at 8pm, 8am and 2pm ET. Gmail app password, not your login.",
    fields: [
      { key: "address", label: "From address", type: "text", placeholder: "you@gmail.com" },
      { key: "appPassword", label: "App password", type: "password", placeholder: "16-char password" },
    ],
  },
];

export function ConnectionsList({ rows }: { rows: CredentialRow[] }) {
  const byProvider = new Map(rows.map((r) => [r.provider, r]));

  const connected = rows.filter((r) => r.status === "ok").length;
  const needsAttention = rows.filter((r) => r.status === "error").length;
  const notSetUp = PROVIDERS.filter((p) => !byProvider.has(p.provider)).length;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[12px]">
        <Pill variant="ok">{connected} connected</Pill>
        <Pill variant="err">{needsAttention} needs attention</Pill>
        <Pill variant="off">{notSetUp} not set up</Pill>
      </div>

      <div className="flex flex-col gap-2.5">
        {PROVIDERS.map((def) => (
          <ConnectionCard key={def.provider} def={def} row={byProvider.get(def.provider)} />
        ))}
      </div>
    </>
  );
}
