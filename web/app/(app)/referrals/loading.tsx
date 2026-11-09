import { PAGE } from "@/lib/layout";

export default function LoadingReferrals() {
  return (
    <div className={PAGE}>
      <p role="status" className="text-sm text-ink-2">
        Loading referrals...
      </p>
    </div>
  );
}
