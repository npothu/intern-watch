import { resolveTrackerUser } from "@/lib/user";
import { getReferrals, getMatches, getLedger } from "@/lib/convex";
import { buildReferralJobs } from "@/lib/referral-jobs";
import { Referrals } from "@/components/referrals/referrals";
import { LoadedAt } from "@/components/loaded-at";

export const dynamic = "force-dynamic";
export const metadata = { title: "Referrals | intern-baddie" };

export default async function ReferralsPage() {
  const user = await resolveTrackerUser();
  if (!user) return null;
  const [data, matches, ledger] = await Promise.all([
    getReferrals(user),
    getMatches(user),
    getLedger(user),
  ]);
  return (
    <>
      <LoadedAt />
      <Referrals data={data} jobs={buildReferralJobs(matches, ledger)} />
    </>
  );
}
