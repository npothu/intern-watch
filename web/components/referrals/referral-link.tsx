"use client";

import Link from "next/link";
import { Users } from "lucide-react";

export function ReferralLink({ short }: { short: string }) {
  return (
    <Link
      href={"/referrals?new=1&job=" + encodeURIComponent(short)}
      onClick={(e) => e.stopPropagation()}
      aria-label="Log a referral"
      title="Log a referral"
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-2 transition-colors hover:bg-chip hover:text-accent"
    >
      <Users className="size-3.5" />
    </Link>
  );
}
