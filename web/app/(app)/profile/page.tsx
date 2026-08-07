import { resolveTrackerUser } from "@/lib/user";
import { fetchProfile } from "./profile-actions";
import { ProfileEditor } from "@/components/profile/profile-editor";

export const dynamic = "force-dynamic";

/**
 * Resume profile editor page. Loads the bank JSON stored as an opaque Convex
 * string and hands it to the client-side editor as initial data. The editor
 * owns round-trip fidelity: save writes the same (possibly edited) JSON back.
 */
export default async function ProfilePage() {
  const user = await resolveTrackerUser();
  if (!user) return null; // layout already rendered NotProvisioned
  const res = await fetchProfile().catch(() => ({
    ok: false as const,
    error: "Couldn't load the profile.",
  }));
  // A load failure degrades to the blank state rather than taking the page
  // down - the editor's empty state invites re-seeding from scratch.
  const data = res.ok ? res.data ?? null : null;
  return (
    <div className="mx-auto w-full max-w-[1060px] px-5 pb-24 pt-4">
      <h1 className="mb-4 text-[15px] font-semibold text-ink">Resume profile</h1>
      <ProfileEditor initialData={data} user={user} />
    </div>
  );
}
