"use client";

import { ClerkProvider } from "@clerk/nextjs";
import { useTheme } from "next-themes";

export function ClerkThemeProvider({ children }: { children: React.ReactNode }) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";

  return (
    <ClerkProvider
      appearance={{
        variables: {
          // Clerk generates shade scales from these colors and needs concrete values.
          colorPrimary: dark ? "#83b79a" : "#33604a",
          colorPrimaryForeground: dark ? "#12211a" : "#f2f8f4",
          colorNeutral: dark ? "#e9e5d9" : "#211f1a",
          colorDanger: dark ? "#d3705d" : "#a8402f",
          colorBackground: "var(--surface)",
          colorForeground: "var(--ink)",
          colorMutedForeground: "var(--ink-2)",
          colorMuted: "var(--chip)",
          colorInput: "var(--bg)",
          colorInputForeground: "var(--ink)",
          colorBorder: "var(--line-2)",
          colorRing: "var(--accent)",
          fontFamily: '"Switzer", system-ui, sans-serif',
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
