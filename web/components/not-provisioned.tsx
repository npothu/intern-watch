"use client";

import { SignOutButton } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";

/**
 * Full-page state shown when the signed-in user's email isn't in
 * TRACKER_USER_MAP. (Unauthenticated visitors are redirected to /sign-in by
 * middleware before this can render, so the signed-out case isn't handled
 * here.)
 */
export function NotProvisioned() {
  return (
    <div className="flex min-h-dvh flex-1 items-center justify-center bg-bg p-6 text-ink">
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-6 text-center">
        <div className="text-lg font-semibold tracking-tight">intern-watch</div>
        <p className="mt-3 text-sm text-ink-2">
          This account isn&apos;t provisioned.
        </p>
        <p className="mt-1 text-xs text-ink-2">
          Ask the administrator to add your email to{" "}
          <code className="text-[11px]">TRACKER_USER_MAP</code>.
        </p>
        <div className="mt-5">
          <SignOutButton>
            <Button variant="secondary" size="sm">
              Sign out
            </Button>
          </SignOutButton>
        </div>
      </div>
    </div>
  );
}
