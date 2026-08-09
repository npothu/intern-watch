"use client";

// The resume-model card.
//
// This replaces a mandatory "Gemini API key" field, and the difference is the
// whole point rather than a cosmetic one. The old card said, in effect, "enter
// a bearer secret or this feature does nothing" - a toll gate, asking the user
// to accept real risk (a key that can spend money, held by someone else) for no
// benefit they could name. This card leads with the fact that tailoring already
// works, and offers a key as an UPGRADE that buys something concrete: a
// different model, and no daily limit.
//
// Consequences for the layout, in priority order:
//  1. The default state is a complete, working sentence. A user who never
//     opens this card is not missing anything, and the card says so.
//  2. The key input is behind a disclosure. Anything that looks like a required
//     field reintroduces the toll-gate reading, however it is worded.
//  3. The daily allowance is stated as a fact about the shared model, not as a
//     warning, and it names the way out.

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  saveResumeModel,
  saveCredential,
  removeCredential,
  testCredential,
} from "@/app/(app)/settings/connections/connections-actions";
import type { CredentialRow, ResumeLlm } from "@/lib/convex";

const CARD = "rounded-md border border-line bg-surface px-4 py-3.5";
const INP =
  "w-full min-w-0 rounded-md border border-line-2 bg-bg px-2.5 py-1.5 text-[12.5px] text-ink outline-none transition-colors focus:border-accent placeholder:text-ink-2";
const LABEL = "mb-1 block text-[11px] font-medium text-ink-2";

/** Mirrors convex/llm_providers.ts. Kept in sync by hand - the Convex module
 *  cannot be imported into the web bundle, and duplicating four labels is
 *  cheaper than a shared package for this. */
const PROVIDER_LABEL: Record<string, string> = {
  gemini: "Gemini",
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};
const SUGGESTED: Record<string, string[]> = {
  gemini: ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-pro"],
  anthropic: ["claude-haiku-4-5-20251001", "claude-sonnet-5", "claude-opus-5"],
  openai: ["gpt-5.1-mini", "gpt-5.1"],
  openrouter: [
    "google/gemini-2.5-flash-lite",
    "anthropic/claude-sonnet-5",
    "deepseek/deepseek-v4-flash-0731",
  ],
};
const KEY_PLACEHOLDER: Record<string, string> = {
  gemini: "AIza...",
  anthropic: "sk-ant-...",
  openai: "sk-...",
  openrouter: "sk-or-...",
};

export function ResumeModelCard({
  llm,
  keyRow,
}: {
  llm: ResumeLlm;
  /** The stored key for the CURRENTLY chosen provider, if any. */
  keyRow?: CredentialRow;
}) {
  // "" means "use whatever the operator provides" - the default, and the state
  // a user who never touches this page is in.
  const [provider, setProvider] = useState(llm.provider ?? "");
  const [model, setModel] = useState(llm.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [pending, start] = useTransition();

  const usingOwn = provider !== "";
  const hasStoredKey = Boolean(keyRow && keyRow.provider === provider);
  const remaining = Math.max(0, llm.dailyCap - llm.usedToday);

  const save = () => {
    start(async () => {
      // The key, if one was typed, must land before the preference: a build that
      // races in between would otherwise pick the new provider and find no key
      // for it, and silently fall back to the shared model.
      if (usingOwn && apiKey.trim()) {
        const saved = await saveCredential(provider, { apiKey: apiKey.trim() });
        if (!saved.ok) {
          toast.error(saved.error);
          return;
        }
        setApiKey("");
        setShowKey(false);
      }
      const res = await saveResumeModel(usingOwn ? provider : null, model.trim() || null);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        usingOwn
          ? `Resumes will use ${PROVIDER_LABEL[provider]}.`
          : "Resumes will use the shared model."
      );
    });
  };

  const test = () => {
    start(async () => {
      const res = await testCredential(provider);
      if (res.ok) toast.success(res.detail ?? "Key works.");
      else toast.error(res.error);
    });
  };

  const clearKey = () => {
    start(async () => {
      const res = await removeCredential(provider);
      if (res.ok) toast.success("Key removed. Resumes will use the shared model.");
      else toast.error(res.error);
    });
  };

  return (
    <div className={CARD}>
      <div className="flex min-w-0 items-start gap-3">
        <div className="grid size-[30px] shrink-0 place-items-center rounded-md bg-accent/15 text-[12px] font-bold text-accent">
          ✍
        </div>
        <div className="min-w-0 flex-1">
          <div className="min-w-0 text-[13.5px] font-semibold text-ink">Resume model</div>
          <p className="mt-0.5 min-w-0 break-words text-[12px] text-ink-2">
            Rewrites your bullets against each job description. This works out of
            the box - there is nothing to set up.
          </p>
        </div>
      </div>

      <div className="mt-3 border-t border-line pt-3">
        <label className="block min-w-0">
          <span className={LABEL}>Model</span>
          <select
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              // A model name is provider-specific, so carrying it across a
              // provider change would send a name the new API has never heard of.
              setModel("");
            }}
            className={INP}
          >
            <option value="">
              Shared model - {llm.defaultModel} (default, no setup)
            </option>
            {Object.keys(PROVIDER_LABEL).map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABEL[p]} - with my own API key
              </option>
            ))}
          </select>
        </label>

        {!usingOwn && (
          <p className="mt-2 text-[11.5px] text-ink-2">
            {remaining} of {llm.dailyCap} tailored builds left today on the shared
            model. Bring your own key to lift the limit and pick a different model.
          </p>
        )}

        {usingOwn && (
          <div className="mt-3 space-y-3">
            <label className="block min-w-0">
              <span className={LABEL}>Model name</span>
              <input
                list="resume-model-suggestions"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={SUGGESTED[provider]?.[0]}
                className={INP}
              />
              {/* A datalist, not a select: a new model must not need a deploy
                  to become usable, so the list suggests without restricting. */}
              <datalist id="resume-model-suggestions">
                {(SUGGESTED[provider] ?? []).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <span className="mt-1 block text-[11px] text-ink-2">
                Leave blank for {PROVIDER_LABEL[provider]}&rsquo;s default.
              </span>
            </label>

            <div className="min-w-0">
              <span className={LABEL}>
                {PROVIDER_LABEL[provider]} API key
              </span>
              {hasStoredKey && !showKey ? (
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-chip px-1.5 py-0.5 font-mono text-[11.5px] text-ink-2">
                    {keyRow?.hint ?? "saved"}
                  </code>
                  <Button size="sm" variant="ghost" onClick={() => setShowKey(true)}>
                    Replace
                  </Button>
                  <Button size="sm" variant="ghost" disabled={pending} onClick={test}>
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-red"
                    disabled={pending}
                    onClick={clearKey}
                  >
                    Remove
                  </Button>
                </div>
              ) : (
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={KEY_PLACEHOLDER[provider]}
                  className={cn(INP, "font-mono")}
                />
              )}
              <span className="mt-1 block text-[11px] text-ink-2">
                Used only for your resume builds, and never for anyone else&rsquo;s.
                Remove it any time to go back to the shared model.
              </span>
            </div>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={pending} onClick={save}>
            {pending ? "Saving..." : "Save"}
          </Button>
          {usingOwn && !hasStoredKey && !apiKey.trim() && (
            <span className="text-[11.5px] text-amber">
              Add a key, or your builds keep using the shared model.
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
