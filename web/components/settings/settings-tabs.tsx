import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * The small switch at the top of the Settings pages. Appearance, Watch and
 * Connections live on sibling routes, so this is plain next/link navigation
 * (no in-place switching like the app's ViewSwitch).
 */

const TABS = [
  { id: "appearance", label: "Appearance", href: "/settings" },
  { id: "watch", label: "Watch", href: "/settings/watch" },
  { id: "connections", label: "Connections", href: "/settings/connections" },
] as const;

export type SettingsTabId = (typeof TABS)[number]["id"];

export function SettingsTabs({ active }: { active: SettingsTabId }) {
  return (
    <div
      role="tablist"
      aria-label="Settings sections"
      className="mb-4 inline-flex overflow-hidden rounded-md border border-line bg-surface"
    >
      {TABS.map((tab) => {
        const isActive = tab.id === active;
        return (
          <Link
            key={tab.id}
            href={tab.href}
            role="tab"
            aria-selected={isActive}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "px-3 py-1.5 text-[12px] font-medium text-ink-2 transition-colors hover:text-ink",
              isActive && "bg-chip font-semibold text-ink"
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
