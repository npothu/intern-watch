import { PAGE_CONTAINER } from "@/lib/layout";

export default function LoadingReferrals() {
  return (
    <div className={`${PAGE_CONTAINER} pt-5 pb-24 min-[700px]:pt-7`}>
      <p role="status" className="text-sm text-ink-2">
        Loading referrals...
      </p>
    </div>
  );
}
