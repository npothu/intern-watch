"use client";

// Settings > Watch: the watcher preferences a person changes a few times a
// year. One form object mirrors the Convex `watch` shape block for block;
// Save replaces the whole object (never a field-level patch), and nothing
// takes effect until the watcher's next run overlays it on the yaml. The
// sticky bar says exactly that, with the run's ETA, so a save never reads
// as "done" when the emails have not changed yet.
//
// Where the initial values come from, in priority order: what the user
// saved here before; else what the watcher last reported (the yaml, with
// term rows and tracker employers only it can compute); else built-in
// defaults. The report is also the only source for the tracker-derived
// companies and the digest recipients, since the page cannot read the yaml.

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { SettingsRow, SettingsSection } from "@/components/settings/settings-section";
import type { Preset, WatchPrefs, WatchReport } from "@/lib/convex";
import { saveWatchSettings } from "@/app/(app)/settings/watch/watch-actions";
import {
  SEASONS,
  dayFromIso,
  shortDate,
  termRows,
  termSeason,
  type Season,
  type TermRow,
} from "@/lib/terms";

// -- form model ---------------------------------------------------------------

type Form = {
  terms: { leadWeeks: number; horizonMonths: number; include: string[]; exclude: string[] };
  rules: Record<Season, Preset>;
  priority: { companies: string[]; fromTracker: boolean; emailImmediately: boolean; subjectNames: boolean };
  location: { remoteCounts: boolean };
  email: { sendAtLocal: number[]; timezone: string; to: string[] };
};

const DEFAULTS: Form = {
  terms: { leadWeeks: 3, horizonMonths: 14, include: [], exclude: [] },
  rules: { Spring: "top_atl_remote", Summer: "anything", Fall: "top_atl_remote" },
  priority: { companies: [], fromTracker: true, emailImmediately: true, subjectNames: true },
  location: { remoteCounts: true },
  email: { sendAtLocal: [8], timezone: "America/New_York", to: [] },
};

const PRESET_LABEL: Record<Preset, string> = {
  top_atl_remote: "Top company, Atlanta, remote",
  priority_only: "Priority companies only",
  anything: "Anything",
};

const LEAD_OPTIONS = [1, 2, 3, 4, 6, 8];
const HORIZON_OPTIONS = [6, 9, 12, 14, 18, 24];
const TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "UTC",
];
const WATCH_INTERVAL_MS = 2 * 60 * 60 * 1000; // watch.yml's cron

function fromReport(report: WatchReport | null): Partial<Form> {
  if (!report) return {};
  const out: Partial<Form> = {};
  const t = report.terms;
  if (t && Number.isInteger(t.lead_weeks) && Number.isInteger(t.horizon_months)) {
    out.terms = {
      leadWeeks: t.lead_weeks,
      horizonMonths: t.horizon_months,
      include: t.include ?? [],
      exclude: t.exclude ?? [],
    };
  }
  if (report.rules && !report.rules.legacy) {
    out.rules = { ...DEFAULTS.rules };
    for (const s of SEASONS) {
      const p = report.rules[s];
      if (p) out.rules[s] = p;
    }
  }
  if (report.priority) {
    out.priority = {
      companies: report.priority.companies ?? [],
      fromTracker: Boolean(report.priority.from_tracker),
      emailImmediately: Boolean(report.priority.email_immediately),
      subjectNames: report.priority.subject_names !== false,
    };
  }
  if (report.location) out.location = { remoteCounts: report.location.remote_counts !== false };
  if (report.email) {
    out.email = {
      sendAtLocal: report.email.send_at_local?.length ? report.email.send_at_local : DEFAULTS.email.sendAtLocal,
      timezone: report.email.timezone || DEFAULTS.email.timezone,
      to: report.email.to ?? [],
    };
  }
  return out;
}

function fromSaved(saved: WatchPrefs | null): Partial<Form> {
  if (!saved) return {};
  const out: Partial<Form> = {};
  if (saved.terms) out.terms = { ...saved.terms };
  if (saved.rules) out.rules = { ...DEFAULTS.rules, ...saved.rules };
  if (saved.priority) out.priority = { ...saved.priority };
  if (saved.location) out.location = { ...saved.location };
  if (saved.email) out.email = { ...saved.email };
  return out;
}

function initialForm(saved: WatchPrefs | null, report: WatchReport | null): Form {
  return { ...DEFAULTS, ...fromReport(report), ...fromSaved(saved) };
}

/** What Save sends. Email is omitted while there are no recipients so the
 *  yaml's list stays in force rather than failing validation. */
function toPayload(form: Form): WatchPrefs {
  return {
    terms: form.terms,
    rules: form.rules,
    priority: form.priority,
    location: form.location,
    ...(form.email.to.length ? { email: form.email } : {}),
  };
}

// -- small controls, in the house style ---------------------------------------

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const SELECT =
  "rounded-md border border-line-2 bg-bg px-2.5 py-1.5 text-[12.5px] text-ink outline-none transition-colors focus:border-accent";
const LINK = "text-[11.5px] font-medium text-accent hover:underline";

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cn(
        "relative h-[17px] w-[30px] shrink-0 cursor-pointer rounded-full transition-colors",
        on ? "bg-accent" : "bg-line-2",
        FOCUS
      )}
    >
      <span
        className={cn(
          "absolute left-[2px] top-[2px] h-[13px] w-[13px] rounded-full bg-surface shadow-sm transition-transform",
          on && "translate-x-[13px]"
        )}
      />
    </button>
  );
}

function Check({
  on,
  onChange,
  children,
  hint,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={cn("flex cursor-pointer items-start gap-2 text-left", FOCUS)}
    >
      <span
        className={cn(
          "mt-[1px] grid size-[15px] shrink-0 place-items-center rounded-[4px] border text-[10px] font-bold",
          on ? "border-accent bg-accent text-accent-ink" : "border-line-2 bg-bg"
        )}
      >
        {on ? "✓" : ""}
      </span>
      <span className="text-[13px] text-ink">
        {children}
        {hint && <span className="block text-[11.5px] text-ink-2">{hint}</span>}
      </span>
    </button>
  );
}

/** Removable chips plus an inline add box. Enter or a comma adds; Backspace
 *  on an empty box removes the last chip; leaving the box adds what is typed. */
function ChipInput({
  values,
  onChange,
  placeholder,
  label,
  type = "text",
}: {
  values: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  label: string;
  type?: "text" | "email";
}) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const parts = draft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) {
      const seen = new Set(values.map((v) => v.toLowerCase()));
      const fresh = parts.filter((p) => !seen.has(p.toLowerCase()));
      if (fresh.length) onChange([...values, ...fresh]);
    }
    setDraft("");
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {values.map((v) => (
        <span
          key={v}
          className="inline-flex items-center gap-1.5 rounded-full bg-chip py-1 pl-2.5 pr-1.5 text-[12.5px] font-medium text-ink"
        >
          {v}
          <button
            type="button"
            aria-label={`Remove ${v}`}
            onClick={() => onChange(values.filter((x) => x !== v))}
            className={cn(
              "grid size-[14px] place-items-center rounded-full text-[11px] text-ink-2 hover:bg-line-2 hover:text-ink",
              FOCUS
            )}
          >
            ×
          </button>
        </span>
      ))}
      <input
        type={type}
        aria-label={label}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (e.key === "Backspace" && !draft && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        className="min-w-[140px] flex-1 bg-transparent px-1 py-1 text-[12.5px] text-ink outline-none placeholder:text-ink-2"
      />
    </div>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-[11.5px] leading-snug text-ink-2">{children}</p>;
}

// -- the page body --------------------------------------------------------------

export function WatchSettings({
  savedWatch,
  savedAt,
  report,
  watcherPushedAt,
  todayIso,
  nowMs,
}: {
  savedWatch: WatchPrefs | null;
  savedAt: number | null;
  report: WatchReport | null;
  watcherPushedAt: number | null;
  /** Server-rendered "today" so the term rows hydrate identically. */
  todayIso: string;
  /** Server-rendered clock for the ETA and "saved 5m ago" lines: render
   *  stays pure, and a stale minute on a long-open tab is harmless. */
  nowMs: number;
}) {
  const router = useRouter();
  const [baseline, setBaseline] = useState<Form>(() => initialForm(savedWatch, report));
  const [form, setForm] = useState<Form>(baseline);
  const [pending, start] = useTransition();
  const today = useMemo(() => dayFromIso(todayIso), [todayIso]);

  const patch = useCallback(<K extends keyof Form>(key: K, value: Partial<Form[K]>) => {
    setForm((f) => ({ ...f, [key]: { ...f[key], ...value } }));
  }, []);

  const changed = (Object.keys(form) as (keyof Form)[]).filter(
    (k) => JSON.stringify(form[k]) !== JSON.stringify(baseline[k])
  );
  const dirty = changed.length > 0;

  const rows = useMemo(() => termRows(form.terms, today), [form.terms, today]);
  const wantedBySeason = useMemo(() => {
    const out: Record<Season, string[]> = { Spring: [], Summer: [], Fall: [] };
    for (const r of rows) {
      const s = termSeason(r.term);
      if (r.wanted && s) out[s].push(r.term);
    }
    return out;
  }, [rows]);

  const toggleTerm = (row: TermRow) => {
    const { include, exclude } = form.terms;
    const without = (list: string[]) => list.filter((t) => t !== row.term);
    switch (row.status) {
      case "auto":
        patch("terms", { exclude: [...exclude, row.term] });
        break;
      case "excluded":
        patch("terms", { exclude: without(exclude) });
        break;
      case "included":
        patch("terms", { include: without(include) });
        break;
      default: // past | beyond
        patch("terms", { include: [...include, row.term] });
    }
  };

  const save = () => {
    start(async () => {
      const res = await saveWatchSettings(toPayload(form));
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setBaseline(form);
      toast.success("Saved. The watcher picks it up on its next run.");
      router.refresh();
    });
  };

  const discard = () => setForm(baseline);

  // "in about 1h 10m": the cron is every 2h, so the next run is roughly two
  // hours after the last push the store saw. Never shown as a promise.
  const eta = useMemo(() => {
    if (!watcherPushedAt) return null;
    const ms = watcherPushedAt + WATCH_INTERVAL_MS - nowMs;
    if (ms <= 0) return "due now";
    const mins = Math.round(ms / 60000);
    return mins >= 60 ? `in about ${Math.floor(mins / 60)}h ${mins % 60}m` : `in about ${mins}m`;
  }, [watcherPushedAt, nowMs]);

  const trackerCompanies = report?.priority?.tracker_companies ?? [];
  const noReport = !report;

  return (
    <div className="flex flex-col gap-3.5">
      {noReport && (
        <p className="rounded-md border border-dashed border-line px-3.5 py-2.5 text-[12px] leading-snug text-ink-2">
          The watcher hasn&apos;t reported its configuration to this deployment yet. The values below
          are defaults until it runs once; anything you save here still wins over the yaml.
        </p>
      )}

      {/* ---------------------------------------------------------- Terms */}
      <SettingsSection title="Terms">
        <SettingsRow
          label="Wanted terms"
          description={`Any term starting ${form.terms.leadWeeks} weeks to ${form.terms.horizonMonths} months out. Terms move in and out on their own; flip one to override.`}
        >
          <ul className="flex flex-col">
            {rows.map((row) => (
              <li key={row.term} className="flex items-center gap-2.5 py-1.5">
                <Switch on={row.wanted} onChange={() => toggleTerm(row)} label={`Want ${row.term}`} />
                <span
                  className={cn(
                    "min-w-[96px] text-[13px] font-medium text-ink",
                    !row.wanted && "text-ink-2 line-through decoration-line-2"
                  )}
                >
                  {row.term}
                </span>
                <span className="flex-1 text-[11.5px] text-ink-2">{termMeta(row, today)}</span>
                {(row.status === "included" || row.status === "excluded") && (
                  <>
                    <span className="rounded-[4px] bg-[color-mix(in_srgb,var(--color-amber)_18%,transparent)] px-1.5 py-[2px] text-[11px] font-semibold text-amber">
                      override
                    </span>
                    <button type="button" onClick={() => toggleTerm(row)} className={cn(LINK, FOCUS)}>
                      Reset
                    </button>
                  </>
                )}
                {(row.status === "past" || row.status === "beyond") && (
                  <button type="button" onClick={() => toggleTerm(row)} className={cn(LINK, FOCUS)}>
                    Include anyway
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-col gap-1.5 text-[11.5px] leading-snug text-ink-2">
            <label className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span>Stop wanting a term</span>
              <select
                aria-label="Lead time"
                className={cn(SELECT, "py-1")}
                value={form.terms.leadWeeks}
                onChange={(e) => patch("terms", { leadWeeks: Number(e.target.value) })}
              >
                {LEAD_OPTIONS.map((w) => (
                  <option key={w} value={w}>
                    {w} week{w === 1 ? "" : "s"}
                  </option>
                ))}
              </select>
              <span>before it starts.</span>
            </label>
            <label className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span>Start wanting a term</span>
              <select
                aria-label="Horizon"
                className={cn(SELECT, "py-1")}
                value={form.terms.horizonMonths}
                onChange={(e) => patch("terms", { horizonMonths: Number(e.target.value) })}
              >
                {HORIZON_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m} months
                  </option>
                ))}
              </select>
              <span>ahead of its start.</span>
            </label>
          </div>
        </SettingsRow>

        <SettingsRow
          label="What a job needs"
          description="Per season, on top of the role filter. Off-season terms are usually where you want to be picky."
        >
          <div className="grid grid-cols-[72px_1fr] items-center gap-x-3 gap-y-1.5">
            {SEASONS.map((season) => (
              <SeasonRule
                key={season}
                season={season}
                terms={wantedBySeason[season]}
                value={form.rules[season]}
                onChange={(p) => patch("rules", { [season]: p } as Partial<Form["rules"]>)}
              />
            ))}
          </div>
          {report?.rules?.legacy && (
            <Hint>
              The yaml still uses a hand-written <code className="rounded bg-chip px-1 font-mono text-[11px]">rules:</code>{" "}
              block; saving here switches the watcher to these presets.
            </Hint>
          )}
        </SettingsRow>

        <p className="border-t border-dashed border-line px-4 py-2.5 text-[11.5px] leading-snug text-ink-2">
          <span className="font-semibold text-amber">Rejected jobs are final.</span> Turning a term back on
          picks up new postings only; jobs the watcher already rejected while it was off do not come back.
        </p>
      </SettingsSection>

      {/* ------------------------------------------------------- Priority */}
      <SettingsSection title="Priority companies">
        <SettingsRow
          label="Companies"
          description="The short list you would drop everything for. Aliases from the top-company list apply, so AWS counts as Amazon."
        >
          <ChipInput
            values={form.priority.companies}
            onChange={(companies) => patch("priority", { companies })}
            placeholder="Add a company…"
            label="Priority companies"
          />
          <Hint>Accepted for any wanted term, whatever the season&apos;s rule says.</Hint>
        </SettingsRow>

        <SettingsRow label="From your tracker" description="Companies you applied to or heard back from count too.">
          <div className="flex items-center gap-2 text-[13px] text-ink">
            <Switch
              on={form.priority.fromTracker}
              onChange={(fromTracker) => patch("priority", { fromTracker })}
              label="Count tracker companies as priority"
            />
            <span>
              {form.priority.fromTracker ? "On" : "Off"}
              {trackerCompanies.length > 0 && ` · ${trackerCompanies.length} compan${trackerCompanies.length === 1 ? "y" : "ies"}`}
            </span>
          </div>
          {form.priority.fromTracker && trackerCompanies.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {trackerCompanies.slice(0, 8).map((c) => (
                <span
                  key={c}
                  className="rounded-full border border-dashed border-line-2 px-2.5 py-1 text-[12.5px] text-ink-2"
                >
                  {c}
                </span>
              ))}
              {trackerCompanies.length > 8 && (
                <span className="rounded-full border border-dashed border-line-2 px-2.5 py-1 text-[12.5px] text-ink-2">
                  +{trackerCompanies.length - 8}
                </span>
              )}
            </div>
          )}
        </SettingsRow>

        <SettingsRow label="When one shows up">
          <div className="flex flex-col gap-2">
            <Check
              on={form.priority.emailImmediately}
              onChange={(emailImmediately) => patch("priority", { emailImmediately })}
              hint="Sent on the run that found it, instead of waiting for the digest. Jobright rows can vanish within hours."
            >
              Email me right away
            </Check>
            <Check
              on={form.priority.subjectNames}
              onChange={(subjectNames) => patch("priority", { subjectNames })}
              hint={`"intern-watch: 7 new · Microsoft, Meta" instead of "7 new".`}
            >
              Name the companies in the digest subject
            </Check>
            <p className="pl-[23px] text-[11.5px] text-ink-2">
              Priority rows always sit first in Matches, the digest, and the dashboard issue.
            </p>
          </div>
        </SettingsRow>
      </SettingsSection>

      {/* ------------------------------------------------------- Location */}
      <SettingsSection title="Location">
        <SettingsRow label="Home metro" description={`Jobs inside the radius pass the "Atlanta" part of a season's rule.`}>
          <div className="text-[13px] text-ink">
            {report?.location?.metro ?? "Atlanta, GA"} · within {report?.location?.radius_miles ?? 35} mi
          </div>
          <Hint>
            Covers Alpharetta, Marietta, Sandy Springs and the rest of the metro list. Other metros aren&apos;t
            supported yet, so this one is read-only.
          </Hint>
        </SettingsRow>
        <SettingsRow label="Remote">
          <div className="flex items-center gap-2 text-[13px] text-ink">
            <Switch
              on={form.location.remoteCounts}
              onChange={(remoteCounts) => patch("location", { remoteCounts })}
              label="Remote roles count as local"
            />
            <span>Remote roles count as local</span>
          </div>
        </SettingsRow>
      </SettingsSection>

      {/* ---------------------------------------------------------- Email */}
      <SettingsSection title="Email">
        <SettingsRow label="Daily digest" description="Everything found since the last one, grouped by term, priority first.">
          <div className="flex flex-wrap items-center gap-2">
            {form.email.sendAtLocal.map((hour, i) => (
              <span key={`${hour}-${i}`} className="inline-flex items-center gap-1">
                <select
                  aria-label={`Digest time ${i + 1}`}
                  className={SELECT}
                  value={hour}
                  onChange={(e) => {
                    const next = [...form.email.sendAtLocal];
                    next[i] = Number(e.target.value);
                    patch("email", { sendAtLocal: next });
                  }}
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </select>
                {form.email.sendAtLocal.length > 1 && (
                  <button
                    type="button"
                    aria-label="Remove this time"
                    onClick={() =>
                      patch("email", { sendAtLocal: form.email.sendAtLocal.filter((_, j) => j !== i) })
                    }
                    className={cn("px-1 text-[13px] text-ink-2 hover:text-ink", FOCUS)}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            <select
              aria-label="Timezone"
              className={SELECT}
              value={form.email.timezone}
              onChange={(e) => patch("email", { timezone: e.target.value })}
            >
              {[...new Set([form.email.timezone, ...TIMEZONES])].map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
            {form.email.sendAtLocal.length < 4 && (
              <button
                type="button"
                onClick={() => patch("email", { sendAtLocal: [...form.email.sendAtLocal, 18] })}
                className={cn(LINK, FOCUS)}
              >
                + add a time
              </button>
            )}
          </div>
        </SettingsRow>
        <SettingsRow label="Recipients" description="Priority alerts go to everyone here as well.">
          <ChipInput
            values={form.email.to}
            onChange={(to) => patch("email", { to })}
            placeholder="Add an address…"
            label="Digest recipients"
            type="email"
          />
          {form.email.to.length === 0 && (
            <Hint>
              No recipients on record yet: the yaml&apos;s list stays in force until you add one here.
            </Hint>
          )}
        </SettingsRow>
      </SettingsSection>

      {/* ------------------------------------------------------- save bar */}
      <div
        className={cn(
          "sticky bottom-4 flex items-center gap-2.5 rounded-[10px] border bg-surface py-2.5 pl-3.5 pr-3 shadow-lg transition-colors",
          dirty ? "border-line-2" : "border-line"
        )}
      >
        <div className="flex-1 text-[12px] text-ink-2">
          {dirty ? (
            <>
              <span className="font-semibold text-ink">
                {changed.length} unsaved change{changed.length === 1 ? "" : "s"}
              </span>{" "}
              · live on the next run{eta ? ` ${eta}` : ""}
            </>
          ) : savedAt ? (
            <>Saved {relative(savedAt, nowMs)} · the watcher applies it on every run</>
          ) : (
            <>Nothing saved from here yet · the watcher runs on the yaml</>
          )}
        </div>
        <button
          type="button"
          onClick={discard}
          disabled={!dirty || pending}
          className={cn(
            "h-[30px] rounded-lg border border-line bg-bg px-3 text-[13px] font-medium text-ink hover:bg-chip disabled:opacity-50",
            FOCUS
          )}
        >
          Discard
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!dirty || pending}
          className={cn(
            "h-[30px] rounded-lg bg-accent px-3.5 text-[13px] font-medium text-accent-ink hover:opacity-85 disabled:opacity-50",
            FOCUS
          )}
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </div>

      <p className="text-[11.5px] leading-snug text-ink-2">
        Keywords, sources and the LLM block stay in the yaml on purpose: a bad keyword rejects jobs silently and
        forever, and this page cannot show you what it cost.
        {report?.reported_at && <> Last watcher report: {relative(Date.parse(report.reported_at), nowMs)}.</>}
      </p>
    </div>
  );
}

function SeasonRule({
  season,
  terms,
  value,
  onChange,
}: {
  season: Season;
  terms: string[];
  value: Preset;
  onChange: (p: Preset) => void;
}) {
  return (
    <>
      <span className={cn("text-[13px] font-medium", terms.length ? "text-ink" : "text-ink-2")}>{season}</span>
      <div className="flex min-w-0 items-center gap-2">
        <select
          aria-label={`${season} rule`}
          className={cn(SELECT, "min-w-0 flex-1")}
          value={value}
          onChange={(e) => onChange(e.target.value as Preset)}
        >
          {(Object.keys(PRESET_LABEL) as Preset[]).map((p) => (
            <option key={p} value={p}>
              {PRESET_LABEL[p]}
            </option>
          ))}
        </select>
        <span className="hidden shrink-0 text-[11.5px] text-ink-2 sm:inline">
          {terms.length ? terms.join(", ") : "no term wanted"}
        </span>
      </div>
    </>
  );
}

function termMeta(row: TermRow, today: ReturnType<typeof dayFromIso>): string {
  const started = row.start <= isoToday(today);
  const start = `${started ? "started" : "starts"} ${shortDate(row.start, today)}`;
  switch (row.status) {
    case "past":
      return `${start} · dropped ${shortDate(row.dropsOn, today)}`;
    case "beyond":
      return `${start} · outside the window`;
    case "auto":
      return `${start} · drops ${shortDate(row.dropsOn, today)}`;
    case "included":
      return `${start} · pinned`;
    case "excluded":
      return `${start} · excluded`;
  }
}

function isoToday(t: ReturnType<typeof dayFromIso>): string {
  return `${t.y}-${String(t.m).padStart(2, "0")}-${String(t.d).padStart(2, "0")}`;
}

function hourLabel(h: number): string {
  const suffix = h < 12 ? "am" : "pm";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve}:00 ${suffix}`;
}

function relative(ms: number, nowMs: number): string {
  const diff = nowMs - ms;
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
