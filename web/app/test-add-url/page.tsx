export default function TestAddUrl() {
  return (
    <div className="mx-auto w-full max-w-[1060px] px-5 py-5">
      <h1 className="mb-4 text-lg font-semibold">Add URL Dialog — visual test</h1>
      <div className="flex items-center gap-2 mb-4">
        <input placeholder="Search company, title, location..." className="flex-1 rounded-[5px] border border-line-2 bg-surface px-2.5 py-1.5 text-[13px]" />
        <button className="h-8 gap-1.5 rounded-full border border-line-2 bg-surface px-3 text-[13px] font-medium inline-flex items-center">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg> Add URL
        </button>
      </div>
      <div className="rounded-xl border bg-popover p-4 max-w-[480px] mx-auto shadow">
        <h2 className="text-[16px] font-semibold">Add a job URL</h2>
        <input className="flex h-9 w-full rounded-md border border-line-2 bg-surface px-3 py-2 text-sm mt-3" placeholder="https://boards.greenhouse.io/company/jobs/123" />
        <p className="mt-1.5 text-xs text-ink-2">Paste any public job posting link. We will fetch it and add it to your matches.</p>
        <div className="flex justify-end gap-2 pt-3">
          <button className="px-3 py-1.5 text-sm">Cancel</button>
          <button className="px-4 py-1.5 text-sm bg-black text-white rounded">Add to matches</button>
        </div>
      </div>
      <div className="rounded-md border border-line bg-surface mt-6">
        <div className="px-4 py-8 text-center">
          <p className="text-[14px] font-medium">No matches yet.</p>
          <p className="mt-1 text-[13px] text-ink-2">Matches will land here — or add a job URL manually.</p>
          <div className="mt-4 flex justify-center">
            <button className="h-8 gap-1.5 rounded-full border border-line-2 bg-surface px-3 text-[13px] font-medium inline-flex items-center">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg> Add URL
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
