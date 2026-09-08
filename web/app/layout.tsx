import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { MOTION_PREFERENCE_INIT_SCRIPT } from "@/lib/motion-preference";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Internbaddie",
  description: "Your private internship tracker",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        {/* Switzer from Fontshare - the only brand font. */}
        <link
          rel="stylesheet"
          href="https://api.fontshare.com/v2/css?f[]=switzer@400,500,600&display=swap"
        />
      </head>
      <body className="min-h-full flex flex-col bg-bg text-ink">
        {/* Stamps the motion-preference attribute before first paint, same
            technique next-themes uses below for `class` - runs first so
            neither script races the other for a visible flash. */}
        <script
          dangerouslySetInnerHTML={{ __html: MOTION_PREFERENCE_INIT_SCRIPT }}
        />
        <ThemeProvider>
          <ClerkProvider
            appearance={{
              variables: {
                colorPrimary: "#33604a",
                colorPrimaryForeground: "#f2f8f4",
                colorBackground: "var(--surface)",
                colorForeground: "var(--ink)",
                colorMutedForeground: "var(--ink-2)",
                colorNeutral: "#6b6557",
                colorMuted: "var(--chip)",
                colorInput: "var(--bg)",
                colorInputForeground: "var(--ink)",
                colorBorder: "var(--line-2)",
                colorRing: "var(--accent)",
                colorDanger: "#a8402f",
                fontFamily: '"Switzer", system-ui, sans-serif',
                borderRadius: "6px",
              },
            }}
          >
            {children}
          </ClerkProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
