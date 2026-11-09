import { SettingsSection, SettingsRow } from "@/components/settings/settings-section";
import { ThemeControl } from "@/components/settings/theme-control";
import { MotionControl } from "@/components/settings/motion-control";
import { PaletteControl } from "@/components/settings/palette-control";
import { FORM_COLUMN } from "@/lib/layout";
import { LoadedAt } from "@/components/loaded-at";
import { SettingsTabs } from "@/components/settings/settings-tabs";

export const metadata = { title: "Settings - intern-baddie" };

/**
 * Settings, reachable from the header's Settings pill (and the phone's avatar
 * menu) - preferences you set once, not a surface you visit often.
 *
 * It sits in the app's shared 1360px column (so its left edge matches every
 * other tab) but caps its content at 640px (FORM_COLUMN, shared by the three
 * Settings pages): a column of label/control rows just reads as a
 * mostly-empty page at full width. 640px keeps rows dense and readable
 * without forcing the label and control onto separate lines on a normal
 * window.
 */
export default function SettingsPage() {
  return (
    <div className={FORM_COLUMN}>
      <LoadedAt />
      <div className="mb-4">
        <h1 className="text-[15px] font-semibold text-ink">Settings</h1>
      </div>
      <SettingsTabs active="appearance" />
      <SettingsSection title="Appearance">
        <SettingsRow label="Theme" description="Light, dark, or match your system.">
          <ThemeControl />
        </SettingsRow>
        <SettingsRow label="Palette" description="Colors used in light and dark mode, saved on this device.">
          <PaletteControl />
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
