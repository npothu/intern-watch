import { ViewSwitch } from "@/components/nav/view-switch";

export default function LoadingReferrals() {
  return (
    <div className="mx-auto max-w-[1060px] px-5 pt-5 pb-24">
      <ViewSwitch active="referrals" />
      <p role="status" className="mt-6 text-sm text-ink-2">
        Loading referrals...
      </p>
    </div>
  );
}
