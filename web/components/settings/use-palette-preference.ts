"use client";

import { useSyncExternalStore } from "react";
import {
  DEFAULT_DARK_PALETTE,
  DEFAULT_LIGHT_PALETTE,
  paletteListeners,
  readPalette,
  type DarkPalette,
  type LightPalette,
} from "@/lib/palette";

/**
 * Hooks for lib/palette.ts, split out for the same Server Component reason
 * as use-motion-preference.ts. The server snapshot is the default palette,
 * so the first client render matches the server and updates right after.
 */

function subscribe(cb: () => void) {
  paletteListeners.add(cb);
  return () => paletteListeners.delete(cb);
}

const readLight = () => readPalette("light");
const readDark = () => readPalette("dark");

export function useLightPalette(): LightPalette {
  return useSyncExternalStore(subscribe, readLight, () => DEFAULT_LIGHT_PALETTE);
}

export function useDarkPalette(): DarkPalette {
  return useSyncExternalStore(subscribe, readDark, () => DEFAULT_DARK_PALETTE);
}
