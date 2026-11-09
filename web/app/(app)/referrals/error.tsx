"use client";

import { Button } from "@/components/ui/button";
import { PAGE_CONTAINER } from "@/lib/layout";

export default function ReferralError({ reset }: { reset: () => void }) {
  return (
    <div className={`${PAGE_CONTAINER} pt-5 pb-24 min-[700px]:pt-7`}>
      <div
        role="alert"
        className="rounded-md border border-line bg-surface p-5"
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
