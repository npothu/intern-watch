import { SettingsSection, SettingsRow } from "@/components/settings/settings-section";
import { ThemeControl } from "@/components/settings/theme-control";
import { MotionControl } from "@/components/settings/motion-control";
import { PaletteControl } from "@/components/settings/palette-control";
import { PAGE_CONTAINER } from "@/lib/layout";
import { SettingsTabs } from "@/components/settings/settings-tabs";

export const metadata = { title: "Settings - intern-baddie" };

/**
 * Settings, reachable from the user-profile dropdown rather than the top nav
 * - preferences you set once, not a surface you visit often.
 *
 * It sits in the app's shared 1360px column (so its left edge matches every
 * other tab) but caps its own content at 640px: a column of label/control
 * rows just reads as a mostly-empty page at full width. 640px keeps rows
 * dense and readable without forcing the label and control onto separate
 * lines on a normal window.
 */
export default function SettingsPage() {
  return (
    <div className={`${PAGE_CONTAINER} pt-5 pb-24 min-[700px]:pt-7`}>
      <div className="max-w-[640px]">
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
    </div>
  );
}
