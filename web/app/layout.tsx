import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { MOTION_PREFERENCE_INIT_SCRIPT } from "@/lib/motion-preference";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "intern-watch",
  description: "Internship triage for intern-watch",
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
          <ClerkProvider>{children}</ClerkProvider>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
