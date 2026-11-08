"use client";

import { FilterPills, type PillOption } from "@/components/filter-pills";
import {
  DARK_PALETTES,
  LIGHT_PALETTES,
  setPalette,
  type DarkPalette,
  type LightPalette,
  type PaletteSwatch,
} from "@/lib/palette";
import { useDarkPalette, useLightPalette } from "@/components/settings/use-palette-preference";

/**
 * Which palette light mode and dark mode each use. Independent of the Theme
 * row above it: that picks the mode, this picks the colours inside each mode,
 * so a choice here holds even while the other mode is showing.
 */

function Swatch({ s }: { s: PaletteSwatch }) {
  return (
    <span
      aria-hidden
      className="size-3 shrink-0 rounded-full border border-line-2"
      style={{ background: `linear-gradient(135deg, ${s.bg} 50%, ${s.accent} 50%)` }}
    />
  );
}

function options(table: Record<string, PaletteSwatch>): PillOption[] {
  return Object.entries(table).map(([key, s]) => ({
    key,
    label: s.label,
    icon: <Swatch s={s} />,
  }));
}

const LIGHT_OPTIONS = options(LIGHT_PALETTES);
const DARK_OPTIONS = options(DARK_PALETTES);

export function PaletteControl() {
  const light = useLightPalette();
  const dark = useDarkPalette();

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] text-ink-2">Light</span>
        <FilterPills
          label="Light palette"
          options={LIGHT_OPTIONS}
          value={light}
          onChange={(key) => setPalette("light", key as LightPalette)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] text-ink-2">Dark</span>
        <FilterPills
          label="Dark palette"
          options={DARK_OPTIONS}
          value={dark}
          onChange={(key) => setPalette("dark", key as DarkPalette)}
        />
      </div>
    </div>
  );
}
