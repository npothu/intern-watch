/**
 * Palette preference: which colour scheme the app uses in light mode and
 * which in dark mode. A second axis next to next-themes' light/dark/system
 * mode, which it never touches - next-themes still owns the `.light`/`.dark`
 * class on <html>, and this module only stamps two attributes beside it:
 *
 *   data-light-palette="pine"            (absent = fern, the default)
 *   data-dark-palette="obsidian-mono"    (absent = obsidian-fern, the default)
 *   data-dark-palette="graphite-fern"
 *
 * globals.css keys the non-default token blocks on those attributes AND the
 * mode class (`:root.light[data-light-palette="pine"]`), so the defaults stay
 * the plain `:root` / `.dark` blocks and nothing else in the app needs to
 * know palettes exist. Stored per device in localStorage, like the motion
 * preference (lib/motion-preference.ts), not in Convex.
 *
 * Deliberately hook-free for the same reason as motion-preference.ts:
 * app/layout.tsx (a Server Component) imports PALETTE_INIT_SCRIPT from here.
 * The hooks live in components/settings/use-palette-preference.ts.
 */

export type LightPalette = "fern" | "pine";
export type DarkPalette = "obsidian-fern" | "obsidian-mono" | "graphite-fern";
export type PaletteMode = "light" | "dark";

export const DEFAULT_LIGHT_PALETTE: LightPalette = "fern";
export const DEFAULT_DARK_PALETTE: DarkPalette = "obsidian-fern";

/**
 * Concrete colours per palette, for the two consumers that cannot read CSS
 * custom properties: the Settings swatches (which must show a palette that
 * is not active) and Clerk (which derives shade scales from real colours).
 * KEEP IN SYNC with the token blocks in app/globals.css.
 */
export type PaletteSpec = {
  label: string;
  bg: string;
  ink: string;
  accent: string;
  accentInk: string;
  red: string;
};

export const LIGHT_PALETTES: Record<LightPalette, PaletteSpec> = {
  fern: {
    label: "Fern",
    bg: "#f4f2ed",
    ink: "#211f1a",
    accent: "#33604a",
    accentInk: "#f2f8f4",
    red: "#a8402f",
  },
  pine: {
    label: "Pine",
    bg: "#f3f3ee",
    ink: "#1c1f1e",
    accent: "#1f4d4a",
    accentInk: "#eaf4f3",
    red: "#a63d33",
  },
};

export const DARK_PALETTES: Record<DarkPalette, PaletteSpec> = {
  "obsidian-fern": {
    label: "Obsidian",
    bg: "#0b0b0c",
    ink: "#ede9e3",
    accent: "#83b79a",
    accentInk: "#12211a",
    red: "#d3705d",
  },
  "obsidian-mono": {
    label: "Mono",
    bg: "#0b0b0c",
    ink: "#ede9e3",
    accent: "#ede9e3",
    accentInk: "#0b0b0c",
    red: "#d3705d",
  },
  "graphite-fern": {
    label: "Graphite",
    bg: "#121417",
    ink: "#e6e8ea",
    accent: "#86c5a4",
    accentInk: "#0f2219",
    red: "#e0706a",
  },
};

const MODES = {
  light: {
    attr: "data-light-palette",
    // Keeps the pre-rename "intern-watch:" prefix, matching the motion key.
    storageKey: "intern-watch:light-palette",
    fallback: DEFAULT_LIGHT_PALETTE,
    values: Object.keys(LIGHT_PALETTES),
  },
  dark: {
    attr: "data-dark-palette",
    storageKey: "intern-watch:dark-palette",
    fallback: DEFAULT_DARK_PALETTE,
    values: Object.keys(DARK_PALETTES),
  },
} as const;

type PaletteFor<M extends PaletteMode> = M extends "light" ? LightPalette : DarkPalette;

export function readPalette<M extends PaletteMode>(mode: M): PaletteFor<M> {
  const m = MODES[mode];
  try {
    const v = localStorage.getItem(m.storageKey);
    if (v !== null && (m.values as readonly string[]).includes(v)) return v as PaletteFor<M>;
  } catch {
    // storage blocked - fall through to the default
  }
  return m.fallback as PaletteFor<M>;
}

export function setPalette<M extends PaletteMode>(mode: M, value: PaletteFor<M>) {
  const m = MODES[mode];
  const html = document.documentElement;
  if (value === m.fallback) html.removeAttribute(m.attr);
  else html.setAttribute(m.attr, value);
  try {
    localStorage.setItem(m.storageKey, value);
  } catch {
    // private mode - the attribute still applies for this page
  }
  paletteListeners.forEach((cb) => cb());
}

/** Store for useSyncExternalStore, same shape as motionPreferenceListeners. */
export const paletteListeners = new Set<() => void>();

/**
 * Blocking inline script for the root layout: stamps the palette attributes
 * on <html> before first paint, so a saved non-default palette never flashes
 * the default one. Only valid, non-default values are stamped.
 */
export const PALETTE_INIT_SCRIPT = `(function(){try{var h=document.documentElement;var m=${JSON.stringify(
  Object.values(MODES).map((m) => ({ a: m.attr, k: m.storageKey, d: m.fallback, v: m.values }))
)};for(var i=0;i<m.length;i++){var v=localStorage.getItem(m[i].k);if(v&&v!==m[i].d&&m[i].v.indexOf(v)>-1)h.setAttribute(m[i].a,v);}}catch(e){}})();`;
