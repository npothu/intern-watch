"use client";

import { ClerkProvider } from "@clerk/nextjs";
import { useTheme } from "next-themes";
import { DARK_PALETTES, LIGHT_PALETTES } from "@/lib/palette";
import { useDarkPalette, useLightPalette } from "@/components/settings/use-palette-preference";

export function ClerkThemeProvider({ children }: { children: React.ReactNode }) {
  const { resolvedTheme } = useTheme();
  const lightPalette = useLightPalette();
  const darkPalette = useDarkPalette();
  const p =
    resolvedTheme === "dark" ? DARK_PALETTES[darkPalette] : LIGHT_PALETTES[lightPalette];

  return (
    <ClerkProvider
      appearance={{
        variables: {
          // Clerk generates shade scales from these colors and needs concrete
          // values, so they come from the active palette's table entry.
          colorPrimary: p.accent,
          colorPrimaryForeground: p.accentInk,
          colorNeutral: p.ink,
          colorDanger: p.red,
          colorBackground: "var(--surface)",
          colorForeground: "var(--ink)",
          colorMutedForeground: "var(--ink-2)",
          colorMuted: "var(--chip)",
          colorInput: "var(--bg)",
          colorInputForeground: "var(--ink)",
          colorBorder: "var(--line-2)",
          colorRing: "var(--accent)",
          // next/font's variable from app/layout.tsx, set on <html>.
          fontFamily: "var(--font-instrument-sans), system-ui, sans-serif",
          borderRadius: "6px",
        },
        elements: {
          socialButtonsBlockButton: { color: "var(--ink)" },
        },
      }}
    >
      {children}
    </ClerkProvider>
  );
}
