"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { CopyField } from "@/components/settings/copy-field";
import {
  saveClientCredentials,
  savePushToken,
  savePubSubTopic,
  verifyPush,
} from "@/app/(app)/settings/connections/google/google-actions";
import type { EnvPresence } from "@/app/(app)/settings/connections/google/google-actions";

/**
 * The Google connect wizard. Six steps; the first three are manual checkboxes
 * kept in localStorage under `iw:google:step`, while steps 4-6 derive their
 * "done" from real server state (deployment env presence, an OAuth credential
 * row, and a live push confirmation) instead of a checkbox. Nothing here ever
 * renders a secret value that came from the server - deployment env values
 * appear only as present/absent, and the one token shown comes from the
 * browser's own memory.
 *
 * Navigation is explicit: the user clicks Next/Back to move, and each action
 * that completes a step advances the pane itself. That keeps Back working as
 * a plain "review the previous step" control with no derived clamping that
 * would yank the user forward again.
 */

const STORAGE_KEY = "iw:google:step";

const STEPS = [
  { id: "cloud-project", title: "Create a Cloud project" },
  { id: "enable-apis", title: "Enable the Gmail API" },
  { id: "oauth-client", title: "Create an OAuth client" },
  { id: "credentials", title: "Paste client ID and secret" },
  { id: "signin", title: "Sign in with Google" },
  { id: "push", title: "Turn on push" },
] as const;

type StepIndex = number; // 1-based step number

/** Read the manual step ticks out of localStorage, tolerating absence/corruption. */
function readManual(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Corrupt or unavailable storage must not break the wizard - start fresh.
    return {};
  }
}

function writeManual(id: string) {
  try {
    const next = { ...readManual(), [id]: true };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be unavailable (e.g. private mode) - the in-memory state
    // still reflects the tick for this session even though it won't persist.
  }
}

/** A fresh 32-char base64url token from CSPRNG bytes (never Math.random). */
function randomToken(): string {
  // 24 bytes base64url-encode to exactly 32 chars with no padding.
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Shown instead of a URL when the Convex SITE origin is unknown. Guessing here
 * would be worse than saying nothing: the whole point of these two fields is
 * that Google and Pub/Sub match them character for character, so a plausible
 * but wrong origin costs more debugging than an explicit gap.
 */
function SiteUrlMissing() {
  return (
    <div className="rounded-md border border-amber/45 bg-amber/10 px-3 py-2">
      <p className="text-[11.5px] text-amber">
        Set <code className="font-mono">CONVEX_SITE_URL</code> on the web app so this URL can be
        built. It is the Convex HTTP-actions origin (the{" "}
        <code className="font-mono">.convex.site</code> domain, or the sibling port of a local
        deployment), which is not the same as{" "}
        <code className="font-mono">CONVEX_URL</code>.
      </p>
    </div>
  );
}

/**
 * The calm substitute for the wizard's write controls when the signed-in user
 * is not on ADMIN_TRACKER_USERS. The instructions above stay visible - only the
 * deployment-wide write UI is gated, and the server actions re-check anyway.
 */
function AdminOnlyNote() {
  return (
    <div className="mt-3 rounded-md border border-line bg-surface px-3 py-2.5">
      <p className="text-[12.5px] text-ink">
        Only an administrator can change the deployment&apos;s Google configuration.
      </p>
      <p className="mt-1 text-[11.5px] text-ink-2">
        These settings are shared by every user of this deployment. Ask an
        admin to run this step from their own account.
      </p>
    </div>
  );
}

/**
 * Shown when the client id and secret are already on the deployment. The step
 * is finished regardless of how they got there, so the only useful thing this
 * pane can do is say so and move on.
 */
function AlreadySetNote({
  onNext,
  canReplace,
  onReplace,
}: {
  onNext: () => void;
  canReplace: boolean;
  onReplace: () => void;
}) {
  return (
    <div className="mt-3">
      <div className="rounded-md border border-line bg-surface px-3 py-2.5">
        <p className="text-[12.5px] text-ink">
          Client ID and secret are already set on this deployment.
        </p>
        <p className="mt-1 text-[11.5px] text-ink-2">
          Nothing to do here. Values are never read back for display - only
          their presence is checked.
        </p>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={BTN_PRIMARY} onClick={onNext}>
          Continue
        </button>
        {canReplace && (
          <button type="button" className={BTN_GHOST} onClick={onReplace}>
            Replace them
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Shown when this step genuinely cannot proceed: nothing is set AND there is no
 * admin key to write with.
 *
 * It names the way out rather than only the blocker. The previous version said
 * "CONVEX_ADMIN_KEY is not set - set it on the server", which dead-ends exactly
 * the non-technical user this wizard exists for: it does not say where the key
 * comes from, that it belongs on the WEB server rather than on Convex, or that
 * the whole step can be skipped with two CLI commands.
 */
function NoAdminKeyNote({ siteUrl }: { siteUrl: string }) {
  const prod = siteUrl.includes(".convex.site") ? " --prod" : "";
  return (
    <div className="mt-3 rounded-md border border-amber/45 bg-amber/10 px-3 py-2.5">
      <p className="text-[12.5px] text-amber">
        This step needs <code className="font-mono">CONVEX_ADMIN_KEY</code>, which is not set.
      </p>
      <p className="mt-2 text-[11.5px] text-ink-2">
        <strong className="text-ink">Skip it instead (no key needed).</strong> Set the
        two values yourself and press Continue:
      </p>
      <pre className="mt-1.5 overflow-x-auto rounded bg-chip px-2.5 py-2 font-mono text-[11px] text-ink-2">
{`npx convex env set${prod} GMAIL_CLIENT_ID <client-id>
npx convex env set${prod} GMAIL_CLIENT_SECRET <secret>`}
      </pre>
      <p className="mt-2 text-[11.5px] text-ink-2">
        <strong className="text-ink">Or enable this step:</strong> generate a deploy key in
        the Convex dashboard under Settings, then set it as{" "}
        <code className="font-mono">CONVEX_ADMIN_KEY</code> on the <em>web</em> server
        (Vercel env or <code className="font-mono">web/.env.local</code>) and redeploy. Note
        that key can write any deployment variable, so the CLI route above leaves
        less lying around.
      </p>
    </div>
  );
}

const INP =
  "w-full min-w-0 rounded-md border border-line-2 bg-bg px-2.5 py-1.5 text-[12.5px] text-ink outline-none transition-colors focus:border-accent placeholder:text-ink-2";
const BTN_PRIMARY =
  "rounded-md border border-accent bg-accent px-3 py-1.5 text-[12px] font-semibold text-accent-ink disabled:pointer-events-none disabled:opacity-50";
const BTN_GHOST =
  "rounded-md border border-transparent bg-transparent px-3 py-1.5 text-[12px] font-medium text-ink-2 hover:bg-chip hover:text-ink";
const BTN_SECONDARY =
  "rounded-md border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-ink hover:border-ink-2";

export function GoogleWizard({
  convexSiteUrl,
  presence,
  googleConnected,
  adminAvailable,
  routeWired,
  routeBlockers,
  clientConfigured,
  admin,
  connectedEmail,
  alreadyConnectedEmail,
  oauthError,
}: {
  convexSiteUrl: string;
  presence: EnvPresence;
  /** Whether a `google` credential row exists (step 5's real-state "done"). */
  googleConnected: boolean;
  /** Whether CONVEX_ADMIN_KEY is set so steps 4 and 6 can write. */
  adminAvailable: boolean;
  /** Whether /api/google/start can run: client id, signing secret, site origin. */
  routeWired: boolean;
  /** Human names of the preconditions that are missing, when it cannot. */
  routeBlockers: string[];
  /** Whether the CONVEX deployment has the client id and secret. This is the
   *  authority for step 4, not getEnvPresence - those values are never set on
   *  the web server, so presence there is always false. */
  clientConfigured: boolean;
  /** A mailbox already linked before this visit. Rendered as standing state,
   *  never as "you just connected", which is what connectedEmail means. */
  alreadyConnectedEmail?: string;
  /** Whether the signed-in user may write deployment-wide env vars. */
  admin: boolean;
  /** Set by the callback redirect on success - the mailbox that got linked. */
  connectedEmail?: string;
  /** Set by the callback redirect on failure - Google's reason, verbatim. */
  oauthError?: string;
}) {
  const [manual, setManual] = useState<Record<string, boolean>>(readManual);
  // Land on the step the user just came back to, not on step 1 - being bounced
  // to the start of a six-step wizard after finishing the hard part reads as
  // "it did not work" even when it did.
  const [pane, setPane] = useState<StepIndex>(connectedEmail || oauthError ? 5 : 1);
  const [presenceState, setPresenceState] = useState<EnvPresence>(presence);
  const [pushToken, setPushToken] = useState("");
  const [pushVerified, setPushVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  // Showing the step-4 form over already-set values, without pretending they
  // are gone. Cancelling is just clearing this.
  const [replacing, setReplacing] = useState(false);
  const [topic, setTopic] = useState("");

  // Step 4's "done" is what the CONVEX deployment holds - the values live
  // there, not on this server, so getEnvPresence reports false for them no
  // matter how many times the wizard saves. Reading presence here is what kept
  // step 5 disabled after a successful step 4. `savedClient` lets an in-session
  // save flip it without a reload.
  const [savedClient, setSavedClient] = useState(false);
  const step4Done = clientConfigured || savedClient;

  // Memoized so the rail badges compute against one stable snapshot.
  const done = useMemo<Record<StepIndex, boolean>>(
    () => ({
      1: manual[STEPS[0].id] === true,
      2: manual[STEPS[1].id] === true,
      3: manual[STEPS[2].id] === true,
      4: step4Done,
      5: googleConnected,
      // Step 6 turns green only after a live push is confirmed.
      6: pushVerified,
    }),
    [manual, step4Done, googleConnected, pushVerified]
  );

  function tick(id: string) {
    writeManual(id);
    setManual(readManual());
    setError(null);
  }

  function show(nextPane: StepIndex) {
    setPane(Math.min(6, Math.max(1, nextPane)));
    setError(null);
    setSavedMsg(null);
  }

  async function onSaveClient() {
    if (!clientId.trim() || !clientSecret.trim()) {
      setError("Paste both the client ID and the client secret first.");
      return;
    }
    setBusy(true);
    setError(null);
    setSavedMsg(null);
    try {
      const res = await saveClientCredentials(clientId.trim(), clientSecret.trim());
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setPresenceState(res.presence ?? presenceState);
      setSavedMsg("Saved to the deployment");
      // The write went to Convex, so this server's presence will not reflect
      // it - trust the successful save instead of re-reading a value that
      // lives somewhere else.
      setSavedClient(true);
      setReplacing(false);
      if (pane === 4) show(5);
    } finally {
      setBusy(false);
    }
  }

  async function onGenerateToken() {
    setBusy(true);
    setError(null);
    setSavedMsg(null);
    try {
      const token = randomToken();
      const res = await savePushToken(token);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // The token lives only in browser memory - keep it here so the endpoint
      // can be shown once. After a reload it is gone and only presence remains.
      setPushToken(token);
      setPresenceState(res.presence ?? presenceState);
      setSavedMsg("Saved to the deployment");
    } finally {
      setBusy(false);
    }
  }

  async function onSaveTopic() {
    if (!topic.trim()) {
      setError("Paste the Pub/Sub topic first.");
      return;
    }
    setBusy(true);
    setError(null);
    setSavedMsg(null);
    try {
      const res = await savePubSubTopic(topic.trim());
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setPresenceState(res.presence ?? presenceState);
      setSavedMsg("Saved to the deployment");
    } finally {
      setBusy(false);
    }
  }

  async function onVerifyPush() {
    setBusy(true);
    setError(null);
    setSavedMsg(null);
    try {
      const res = await verifyPush();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setPushVerified(true);
      setSavedMsg("Push verified");
    } finally {
      setBusy(false);
    }
  }

  const adminUnavailable = !adminAvailable;
  const oauthDisabled = !routeWired || !step4Done;
  const oauthTitle = !routeWired
    ? "OAuth route not wired yet"
    : !step4Done
      ? "Complete the previous step first"
      : undefined;

  return (
    <div className="mx-auto w-full max-w-[640px] px-5 pb-24 pt-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <Link
            href="/settings/connections"
            className="shrink-0 text-[12px] font-medium text-accent hover:underline"
          >
            &larr; Connections
          </Link>
          <h1 className="min-w-0 text-[15px] font-semibold text-ink">Connect Google</h1>
        </div>
        <span className="shrink-0 rounded-full bg-chip px-2.5 py-0.5 text-[11px] font-semibold text-ink-2">
          Step {pane} of 6
        </span>
      </div>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-[208px_minmax(0,1fr)]">
        {/* Left rail: the six steps with a done/current/pending badge each. */}
        <ol className="min-w-0 text-[12.5px]">
          {STEPS.map((step, idx) => {
            const n = (idx + 1) as StepIndex;
            const isNow = n === pane;
            return (
              <li key={step.id} className="flex gap-2.5 py-1.5 min-w-0">
                <span
                  className={cn(
                    "size-[19px] grid shrink-0 place-items-center rounded-full text-[10.5px] font-bold",
                    done[n]
                      ? "bg-accent text-accent-ink"
                      : isNow
                        ? "bg-ink text-bg"
                        : "bg-chip text-ink-2"
                  )}
                >
                  {done[n] ? "\u2713" : n}
                </span>
                <span
                  className={cn(
                    "min-w-0 overflow-wrap-anywhere",
                    isNow ? "font-semibold text-ink" : "text-ink-2"
                  )}
                >
                  {step.title}
                </span>
              </li>
            );
          })}
        </ol>

        {/* Right pane: the active step's content. */}
        <div className="min-w-0 rounded-md border border-line bg-surface p-4">
          {error && (
            <p className="mb-3 rounded-md border border-red/20 bg-red/10 px-3 py-2 text-[12px] text-red">
              {error}
            </p>
          )}
          {savedMsg && (
            <p className="mb-3 rounded-md border border-accent/20 bg-accent/10 px-3 py-2 text-[12px] text-accent">
              {savedMsg}
            </p>
          )}

          {pane === 1 && (
            <div className="min-w-0">
              <h2 className="text-[13.5px] font-semibold text-ink">
                Create a Google Cloud project
              </h2>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-[12.5px] text-ink-2 min-w-0">
                <li>
                  Open{" "}
                  <Link
                    href="https://console.cloud.google.com/projectcreate"
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline"
                  >
                    console.cloud.google.com/projectcreate
                  </Link>{" "}
                  and create a new project (any project you own works).
                </li>
              </ol>
              <div className="mt-4 flex items-center gap-2.5">
                <button
                  type="button"
                  className={BTN_PRIMARY}
                  onClick={() => {
                    tick(STEPS[0].id);
                    show(2);
                  }}
                >
                  I have created it
                </button>
                <button type="button" className={BTN_GHOST} onClick={() => show(pane - 1)}>
                  Back
                </button>
              </div>
            </div>
          )}

          {pane === 2 && (
            <div className="min-w-0">
              <h2 className="text-[13.5px] font-semibold text-ink">
                Enable the Gmail API and the Pub/Sub API
              </h2>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-[12.5px] text-ink-2 min-w-0">
                <li>
                  In the project you just made, open{" "}
                  <Link
                    href="https://console.cloud.google.com/apis/library"
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline"
                  >
                    the API library
                  </Link>
                  .
                </li>
                <li>
                  Enable the <b className="text-ink">Gmail API</b>.
                </li>
                <li>
                  Enable the <b className="text-ink">Cloud Pub/Sub API</b>.
                </li>
              </ol>
              <div className="mt-4 flex items-center gap-2.5">
                <button
                  type="button"
                  className={BTN_PRIMARY}
                  onClick={() => {
                    tick(STEPS[1].id);
                    show(3);
                  }}
                >
                  I have enabled them
                </button>
                <button type="button" className={BTN_GHOST} onClick={() => show(pane - 1)}>
                  Back
                </button>
              </div>
            </div>
          )}

          {pane === 3 && (
            <div className="min-w-0">
              <h2 className="text-[13.5px] font-semibold text-ink">Create an OAuth client</h2>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-[12.5px] text-ink-2 min-w-0">
                <li>
                  Open <b className="text-ink">APIs &amp; Services &rarr; Credentials</b> in the
                  project you just made.
                </li>
                <li>
                  Create credentials &rarr; OAuth client ID &rarr;{" "}
                  <b className="text-ink">Web application</b>.
                </li>
                <li>
                  Under <b className="text-ink">Authorized redirect URIs</b>, paste this exactly:
                </li>
              </ol>
              <div className="mt-2.5">
                {convexSiteUrl ? (
                  <CopyField value={`${convexSiteUrl}/gmail/callback`} label="Redirect URI" />
                ) : (
                  <SiteUrlMissing />
                )}
              </div>
              {convexSiteUrl && (
                <p className="mt-2 text-[11px] text-ink-2">
                  Google matches this character for character. A trailing slash is a different URI.
                </p>
              )}

              <div className="mt-4 border-t border-line pt-3">
                <p className="text-[11px] text-ink-2">
                  Also add yourself as a test user on the consent screen, or Google will block the
                  sign-in in step 5.
                </p>
                <div className="mt-3 flex items-center gap-2.5">
                  <button
                    type="button"
                    className={BTN_PRIMARY}
                    onClick={() => {
                      tick(STEPS[2].id);
                      show(4);
                    }}
                  >
                    I have created it
                  </button>
                  <button type="button" className={BTN_GHOST} onClick={() => show(pane - 1)}>
                    Back
                  </button>
                </div>
              </div>
            </div>
          )}

          {pane === 4 && (
            <div className="min-w-0">
              <h2 className="text-[13.5px] font-semibold text-ink">Paste client ID and secret</h2>
              {/* Presence is checked BEFORE the admin key on purpose. This step
                  exists to get two values onto the deployment; if they are
                  already there - set by the CLI, or by someone else - the step
                  is done, and the admin key is irrelevant to saying so. Keying
                  the whole pane on the admin key made it show a red "cannot
                  write" error while the sidebar showed the same step with a
                  green checkmark, on the same screen. */}
              {step4Done && !replacing ? (
                <AlreadySetNote
                  onNext={() => show(5)}
                  canReplace={admin && !adminUnavailable}
                  // `replacing` is a separate flag rather than faking presence
                  // to false. Clearing presence also cleared step4Done, which
                  // disabled step 5's sign-in even though the deployment still
                  // held valid credentials - and there was no way back short of
                  // a page reload.
                  onReplace={() => setReplacing(true)}
                />
              ) : !admin ? (
                <AdminOnlyNote />
              ) : adminUnavailable ? (
                <NoAdminKeyNote siteUrl={convexSiteUrl} />
              ) : (
                <>
                  <div className="mt-3 grid items-start gap-2.5 sm:grid-cols-2">
                    <label className="block min-w-0">
                      <span className="mb-1 block text-[12px] text-ink-2">Client ID</span>
                      <input
                        type="text"
                        value={clientId}
                        onChange={(e) => setClientId(e.target.value)}
                        placeholder="1234567890-...apps.googleusercontent.com"
                        autoComplete="off"
                        spellCheck={false}
                        className={`${INP} font-mono text-[11.5px]`}
                      />
                    </label>
                    <label className="block min-w-0">
                      <span className="mb-1 block text-[12px] text-ink-2">Client secret</span>
                      <input
                        type="password"
                        value={clientSecret}
                        onChange={(e) => setClientSecret(e.target.value)}
                        placeholder="GOCSPX-..."
                        autoComplete="off"
                        spellCheck={false}
                        className={`${INP} font-mono text-[11.5px]`}
                      />
                    </label>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={BTN_PRIMARY}
                      onClick={onSaveClient}
                      disabled={busy}
                    >
                      {busy ? "Saving..." : "Save"}
                    </button>
                    {/* Only offered when there is something to go back TO.
                        Opening this form over working credentials with no way
                        out was the trap. */}
                    {replacing && (
                      <button
                        type="button"
                        className={BTN_GHOST}
                        onClick={() => setReplacing(false)}
                        disabled={busy}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                  <p className="mt-3 text-[11px] text-ink-2">
                    Saved to the Convex deployment, not to your account. Functions pick the new
                    value up on their next run.
                  </p>
                </>
              )}
            </div>
          )}

          {pane === 5 && (
            <div className="min-w-0">
              <h2 className="text-[13.5px] font-semibold text-ink">Sign in with Google</h2>
              <p className="mt-2 text-[12px] text-ink-2">
                Authorize the app with the Gmail account you apply from. Google returns you
                here when it is done. Read-only access to Gmail, nothing else, and you can
                revoke it at any time from your Google account.
              </p>
              {/* Standing state, distinct from "you just connected". Showing
                  the stored address as a success banner made a FAILED return
                  render green and red at once, with a stale mailbox presented
                  as the one just linked. */}
              {/* Shown alongside a failure too, not just on a clean visit. A
                  failed re-authorisation leaves the PREVIOUS mailbox linked
                  and the rail still green, so hiding it here left the user
                  unable to tell what state they were actually in. Neutral
                  styling keeps it from reading as success. */}
              {!connectedEmail && alreadyConnectedEmail && (
                <div className="mt-3 rounded-md border border-line bg-surface px-3 py-2.5">
                  <p className="text-[12.5px] text-ink">
                    Currently linked:{" "}
                    <span className="font-mono">{alreadyConnectedEmail}</span>
                  </p>
                  <p className="mt-1 text-[11.5px] text-ink-2">
                    {oauthError
                      ? "That sign-in did not go through, so this mailbox is still the one being watched."
                      : "Signing in again replaces it with whichever account you choose."}
                  </p>
                </div>
              )}
              {connectedEmail && (
                <div className="mt-3 rounded-md border border-accent/45 bg-accent/10 px-3 py-2.5">
                  <p className="text-[12.5px] text-accent">
                    Connected <span className="font-mono">{connectedEmail}</span>.
                  </p>
                  <p className="mt-1 text-[11.5px] text-ink-2">
                    Naming the mailbox matters: signing in with the wrong Google
                    account is easy to do and otherwise invisible.
                  </p>
                </div>
              )}
              {oauthError && (
                <div className="mt-3 rounded-md border border-red/45 bg-red/10 px-3 py-2.5">
                  <p className="text-[12.5px] text-red">
                    Google sign-in did not finish: {oauthError}
                  </p>
                  <p className="mt-1 text-[11.5px] text-ink-2">
                    If it mentions the redirect URI, it must match the one in step 3
                    exactly, including https and with no trailing slash.
                  </p>
                </div>
              )}
              {routeWired ? (
                <div className="mt-3 min-w-0">
                  {/* A plain link, not a fetch: this has to be a top-level
                      navigation so Google's consent screen owns the tab.
                      When it cannot run, render a real disabled <button>
                      instead of a pointer-events-none anchor: that style
                      suppresses hover, which silently swallows the title and
                      leaves a dead control with no stated reason. The reason
                      is also printed below, since a tooltip is invisible on
                      touch devices either way. */}
                  {oauthDisabled ? (
                    <>
                      <button
                        type="button"
                        disabled
                        className={cn(BTN_PRIMARY, "w-full sm:w-auto")}
                        title={oauthTitle}
                      >
                        Sign in with Google
                      </button>
                      <p className="mt-2 text-[11.5px] text-amber">{oauthTitle}</p>
                    </>
                  ) : (
                    <a
                      href="/api/google/start"
                      className={cn(BTN_PRIMARY, "inline-flex w-full justify-center sm:w-auto")}
                    >
                      Sign in with Google
                    </a>
                  )}
                  <p className="mt-2 text-[11px] text-ink-2">
                    Prefer the terminal? <code className="font-mono">python -m src.mail_auth</code>{" "}
                    does the same thing.
                  </p>
                </div>
              ) : (
                <div className="mt-3 min-w-0">
                  {/* Name what is missing. Collapsing three separate causes into
                      one boolean and then showing only the CLI fallback made a
                      missing variable read as "this feature was never built" -
                      the opposite of the degrade-loudly rule mail-sync follows
                      elsewhere with its own missing[] list. */}
                  {routeBlockers.length > 0 && (
                    <div className="mb-3 rounded-md border border-amber/45 bg-amber/10 px-3 py-2.5">
                      <p className="text-[12px] text-amber">
                        In-browser sign-in is unavailable until these are set:
                      </p>
                      <ul className="mt-1 list-disc pl-4 text-[11.5px] text-ink-2">
                        {routeBlockers.map((b) => (
                          <li key={b}>{b}</li>
                        ))}
                      </ul>
                      <p className="mt-1.5 text-[11.5px] text-ink-2">
                        The CLI below works regardless.
                      </p>
                    </div>
                  )}
                  <CopyField
                    label="Run this from the repo root"
                    value="python -m src.mail_auth"
                  />
                  <p className="mt-2 text-[11px] text-ink-2">
                    Add <code className="font-mono">GMAIL_CLIENT_ID</code> and{" "}
                    <code className="font-mono">GMAIL_CLIENT_SECRET</code> to your local{" "}
                    <code className="font-mono">.env</code> first. Step 4 saved them to the
                    Convex deployment, which this CLI does not read - it needs its own copy.
                  </p>
                  <p className="mt-1 text-[11px] text-ink-2">
                    It stores the refresh token in Convex and arms the Gmail watch, so this step
                    goes green on its own once it finishes.
                  </p>
                </div>
              )}
            </div>
          )}
          {pane === 6 && (
            <div className="min-w-0">
              <h2 className="text-[13.5px] font-semibold text-ink">Turn on push</h2>

              {!admin ? (
                <AdminOnlyNote />
              ) : adminUnavailable ? (
                <p className="mt-3 text-[12px] text-red">
                  CONVEX_ADMIN_KEY is not set - the Google wizard cannot write deployment settings.
                  Set it on the server to configure push.
                </p>
              ) : (
                <>
                  <div className="mt-3 rounded-md border border-line p-3">
                    <div className="flex flex-wrap items-center gap-2.5">
                      <button
                        type="button"
                        className={BTN_SECONDARY}
                        onClick={onGenerateToken}
                        disabled={busy}
                      >
                        {busy ? "Saving..." : "Generate token"}
                      </button>
                      <span className="min-w-0 text-[11.5px] text-ink-2">
                        A random 32-char MAIL_PUSH_TOKEN for the push endpoint.
                      </span>
                    </div>

                    {pushToken && !convexSiteUrl ? (
                      <div className="mt-3">
                        <SiteUrlMissing />
                      </div>
                    ) : null}
                    {pushToken && convexSiteUrl ? (
                      <div className="mt-3">
                        <CopyField
                          label="Push endpoint (paste into the Pub/Sub push subscription)"
                          value={`${convexSiteUrl}/gmail/push?token=${pushToken}`}
                        />
                        <p className="mt-2 text-[11px] text-ink-2">
                          This token is shown once while it is still in browser memory. After a
                          reload it is gone and the endpoint can only be rebuilt by generating a
                          new one.
                        </p>
                      </div>
                    ) : presenceState.pushToken ? (
                      <p className="mt-3 text-[11.5px] text-ink-2">
                        Set - generate a new one to see the endpoint again.
                      </p>
                    ) : (
                      <p className="mt-3 text-[11.5px] text-ink-2">Not set yet.</p>
                    )}
                  </div>

                  <div className="mt-3">
                    <label className="block min-w-0">
                      <span className="mb-1 block text-[12px] text-ink-2">Pub/Sub topic</span>
                      <input
                        type="text"
                        value={topic}
                        onChange={(e) => setTopic(e.target.value)}
                        placeholder="projects/<project-id>/topics/<topic>"
                        autoComplete="off"
                        spellCheck={false}
                        className={`${INP} font-mono text-[11.5px]`}
                      />
                    </label>
                    <button
                      type="button"
                      className={`${BTN_PRIMARY} mt-2`}
                      onClick={onSaveTopic}
                      disabled={busy}
                    >
                      {busy ? "Saving..." : "Save topic"}
                    </button>
                  </div>

                  <div className="mt-4 border-t border-line pt-3">
                    <p className="mb-2 text-[11px] text-ink-2">
                      Point the Pub/Sub push subscription at the endpoint above, then confirm a
                      real push lands. The step only turns green once one does.
                    </p>
                    <button
                      type="button"
                      className={BTN_SECONDARY}
                      onClick={onVerifyPush}
                      disabled={busy}
                    >
                      {busy ? "Checking..." : "Verify push"}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
