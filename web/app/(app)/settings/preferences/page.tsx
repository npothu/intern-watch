import { resolveTrackerUser } from "@/lib/user";
import { getHealth, getWatchSettings } from "@/lib/convex";
import { ViewSwitch } from "@/components/nav/view-switch";
import { SettingsTabs } from "@/components/settings/settings-tabs";
import { Preferences } from "@/components/settings/preferences";

export const metadata = { title: "Preferences - intern-watch" };

export const dynamic = "force-dynamic";

/**
 * Settings -> Preferences: what the watcher looks for, how it tells you,
 * and how the app shows it (the Matches surface hides terms switched off
 * here and pins the priority companies).
 *
 * Two inputs, both tolerant of failure. The saved preferences and the
 * watcher's last resolved-config report come from one Convex query; the
 * health read only feeds the "applies on the next run in ~Nm" line. A
 * failed settings read degrades to an explicit "couldn't load" state rather
 * than a page of defaults that would look like the truth.
 */
export default async function PreferencesPage() {
  const user = await resolveTrackerUser();
  if (!user) return null; // layout already rendered NotProvisioned
  const [settings, health] = await Promise.all([
    getWatchSettings(user)
      .then((s) => ({ ok: true as const, ...s }))
      .catch((err: Error) => ({ ok: false as const, error: err.message })),
    getHealth(user).catch(() => null),
  ]);
  // Request time. This page is force-dynamic, so a server render is one
  // request; the client component takes the clock as props and stays pure.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const todayIso = new Date(nowMs).toISOString().slice(0, 10);

  return (
    <div className="mx-auto w-full max-w-[640px] px-5 pb-24 pt-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h1 className="text-[15px] font-semibold text-ink">Settings</h1>
        <ViewSwitch active={null} />
      </div>
      <SettingsTabs active="preferences" />
      {settings.ok ? (
        <Preferences
          savedWatch={settings.watch}
          savedAt={settings.updatedAt}
          report={settings.report}
          watcherPushedAt={health?.watcherPushedAt ?? null}
          todayIso={todayIso}
          nowMs={nowMs}
        />
      ) : (
        <div className="rounded-md border border-line bg-surface px-4 py-3.5 text-[12.5px] text-ink-2">
          <div className="text-[13px] font-semibold text-ink">Couldn&apos;t load these settings</div>
          <p className="mt-1">
            The store didn&apos;t answer ({settings.error}). The watcher keeps running on the
            configuration it already has; reload to try again.
          </p>
        </div>
      )}
    </div>
  );
}
