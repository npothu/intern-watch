import { SettingsSection, SettingsRow } from "@/components/settings/settings-section";
import { ThemeControl } from "@/components/settings/theme-control";
import { MotionControl } from "@/components/settings/motion-control";
import { ViewSwitch } from "@/components/nav/view-switch";
import { SettingsTabs } from "@/components/settings/settings-tabs";

export const metadata = { title: "Settings - intern-watch" };

/**
 * Settings, reachable from the user-profile dropdown rather than the top nav
 * - preferences you set once, not a surface you visit often.
 *
 * Narrower than the app's usual max-w-[1060px]: that width suits the wide
 * triage tables elsewhere, but a column of label/control rows just reads as
 * a mostly-empty page at that width. 640px keeps rows dense and readable
 * without forcing the label and control onto separate lines on a normal
 * window.
 */
export default function SettingsPage() {
  return (
    <div className="mx-auto w-full max-w-[640px] px-5 pb-24 pt-5">
      {/* Same treatment as Resume: Settings has no cell of its own, so the
          switch renders all-inactive purely as the way back to Matches,
          Tracker or Inbox. The two cell-less surfaces have to agree, or the
          way out of one is not the way out of the other. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h1 className="text-[15px] font-semibold text-ink">Settings</h1>
        <ViewSwitch active={null} />
      </div>
      <SettingsTabs active="appearance" />
      <SettingsSection title="Appearance">
        <SettingsRow label="Theme" description="Light, dark, or match your system.">
          <ThemeControl />
        </SettingsRow>
        <SettingsRow
          label="Animation"
          description="Controls every animation in the app, including the ones the header's theme toggle plays."
        >
          <MotionControl />
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
