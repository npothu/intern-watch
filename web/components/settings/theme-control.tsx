"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { FilterPills, type PillOption } from "@/components/filter-pills";

/** True only once mounted on the client - useSyncExternalStore forces the
 *  post-hydration re-render React wants here without an effect-driven
 *  setState (flagged by this repo's lint config as a cascading-render risk). */
function useMounted(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
}

/**
 * A second, labelled way to set the theme next-themes already drives via the
 * header's icon toggle (site-header.tsx, untouched). Same preference, same
 * shape as the motion control below, so it earns a place on this page.
 */

const OPTIONS: PillOption[] = [
  { key: "system", label: "System" },
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
];

export function ThemeControl() {
  const { theme, setTheme } = useTheme();
  // next-themes reports `theme` as undefined until mounted, so the pill
  // selection is gated the same way the header toggle's icons implicitly
  // are - server and first client render both show "system" active.
  const mounted = useMounted();

  return (
    <FilterPills
      label="Theme"
      options={OPTIONS}
      value={mounted ? theme ?? "system" : "system"}
      onChange={(key) => setTheme(key)}
    />
  );
}
