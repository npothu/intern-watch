import { resolveTrackerUser } from "@/lib/user";
import { listCredentials, getResumeLlm, getMailSyncStatus } from "@/lib/convex";
import { ViewSwitch } from "@/components/nav/view-switch";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { ConnectionsList } from "@/components/settings/connections-list";
import { DeployChecklist } from "@/components/settings/deploy-checklist";

export const metadata = { title: "Connections - intern-watch" };

export const dynamic = "force-dynamic";

/**
 * Settings -> Connections. The resume-model card (which needs no setup), then
 * the provider cards that do, then the read-only deploy-time env checklist.
 * Secrets are never rendered here - the client components own save/test/remove
 * and this page only loads which providers have a credential on file.
 *
 * Both loads tolerate failure: a Convex hiccup should degrade this page to
 * "nothing configured" rather than blanking Settings entirely.
 */
export default async function ConnectionsPage() {
  const user = await resolveTrackerUser();
  if (!user) return null; // layout already rendered NotProvisioned
  const [rows, llm, mailSync] = await Promise.all([
    listCredentials(user).catch(() => []),
    getResumeLlm(user).catch(() => null),
    // Assume enabled if the check itself fails: claiming a working feature is
    // off is the more confusing of the two wrong answers.
    getMailSyncStatus().catch(() => ({ enabled: true, missing: [] })),
  ]);

  return (
    <div className="mx-auto w-full max-w-[640px] px-5 pb-24 pt-5">
      {/* Same header treatment as the other Settings pages: title left, the
          surface switch right (Settings has no cell, so it renders
          all-inactive purely as the way back to Matches, Tracker or Inbox). */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h1 className="text-[15px] font-semibold text-ink">Settings</h1>
        <ViewSwitch active={null} />
      </div>
      <SettingsTabs active="connections" />

      <div className="mb-7">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-2">
            Your connections
          </h2>
          <span className="rounded-full bg-chip px-2 py-0.5 font-mono text-[10.5px] text-ink-2">
            stored encrypted in Convex
          </span>
        </div>
        <ConnectionsList
          rows={rows}
          llm={
            llm ?? {
              provider: null,
              model: null,
              defaultProvider: "gemini",
              defaultModel: "gemini-flash-lite-latest",
              dailyCap: 25,
              usedToday: 0,
            }
          }
          mailSync={mailSync}
        />
      </div>

      <DeployChecklist />
    </div>
  );
}
