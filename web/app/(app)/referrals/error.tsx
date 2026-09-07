"use client";

import { ViewSwitch } from "@/components/nav/view-switch";
import { Button } from "@/components/ui/button";

export default function ReferralError({ reset }: { reset: () => void }) {
  return (
    <div className="mx-auto max-w-[1060px] px-5 pt-5 pb-24">
      <ViewSwitch active="referrals" />
      <div
        role="alert"
        className="mt-6 rounded-md border border-line bg-surface p-5"
      >
        <p className="text-sm">Couldn&apos;t load your referrals.</p>
        <p className="mt-1 text-sm text-ink-2">Please try again in a moment.</p>
        <Button className="mt-4" variant="outline" onClick={reset}>
          Try again
        </Button>
      </div>
    </div>
  );
}
