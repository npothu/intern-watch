import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

// Everything in this app is live, per-user data served from Convex behind
// auth, so every route stays dynamic. This also keeps ClerkProvider (which
// needs a real publishable key) from being prerendered at build time with
// dummy env values. Theming is driven purely by `prefers-color-scheme` in
// globals.css (the approved spec's approach), so no ThemeProvider is needed.
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
        <ClerkProvider>{children}</ClerkProvider>
        <Toaster />
      </body>
    </html>
  );
}
