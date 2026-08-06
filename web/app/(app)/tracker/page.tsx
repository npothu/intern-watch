import { PlaceholderList } from "@/components/placeholder-list";

export default function TrackerPage() {
  return (
    <div className="mx-auto w-full max-w-[1060px] px-5 py-6">
      <h1 className="text-xs font-semibold uppercase tracking-[0.09em] text-ink-2">
        Tracker
      </h1>
      <p className="mt-1 mb-4 text-[12.5px] text-ink-2">
        Applications ledger goes here in a later pass.
      </p>
      <PlaceholderList />
    </div>
  );
}
