import { resolveTrackerUser } from "@/lib/user";
import { getReferrals } from "@/lib/convex";
import { loadCore } from "@/lib/app-data";
import { buildReferralJobs } from "@/lib/referral-jobs";
import { Referrals } from "@/components/referrals/referrals";
import { LoadedAt } from "@/components/loaded-at";

export const dynamic = "force-dynamic";
export const metadata = { title: "Referrals | intern-baddie" };

export default async function ReferralsPage() {
  const user = await resolveTrackerUser();
  if (!user) return null;
  // Matches and ledger through lib/app-data's per-request cache, which the
  // layout's header counts read too - one Convex query each, not two.
  const [data, core] = await Promise.all([getReferrals(user), loadCore(user)]);
  return (
    <>
      <LoadedAt />
      <Referrals data={data} jobs={buildReferralJobs(core.matches, core.ledger)} />
    </>
  );
}
