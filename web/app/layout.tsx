import type { Metadata } from "next";
import { Geist_Mono, Instrument_Sans } from "next/font/google";
import { ClerkThemeProvider } from "@/components/clerk-theme-provider";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { MOTION_PREFERENCE_INIT_SCRIPT } from "@/lib/motion-preference";
import { PALETTE_INIT_SCRIPT } from "@/lib/palette";
export const dynamic = "force-dynamic";

// Self-hosted by next/font; globals.css maps these variables onto
// Tailwind's --font-sans / --font-mono.
const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-instrument-sans",
});
const geistMono = Geist_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "Internbaddie",
  description: "Your private internship tracker",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${instrumentSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-bg text-ink">
        {/* Stamps the motion-preference attribute before first paint, same
            technique next-themes uses below for `class` - runs first so
            neither script races the other for a visible flash. */}
        <script
          dangerouslySetInnerHTML={{ __html: MOTION_PREFERENCE_INIT_SCRIPT }}
        />
        {/* Same technique for the light/dark palette attributes
            (lib/palette.ts); globals.css pairs them with next-themes' class. */}
        <script dangerouslySetInnerHTML={{ __html: PALETTE_INIT_SCRIPT }} />
        <ThemeProvider>
          <ClerkThemeProvider>{children}</ClerkThemeProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
