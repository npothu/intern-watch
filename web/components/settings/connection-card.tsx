"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  saveCredential,
  testCredential,
  removeCredential,
} from "@/app/(app)/settings/connections/connections-actions";
import type { CredentialRow } from "@/lib/convex";

/**
 * One provider card on the Connections page. Secrets are write-only: a saved
 * credential is shown as its hint (never echoed into an input) behind a
 * Replace button that reveals empty fields. Every mutation runs through the
 * server actions and revalidates the page, so the fresh row arrives on the
 * next render.
 */

// The mock's .conn / .inp classes mapped to this app's token classes.
const CONN = "rounded-md border border-line bg-surface px-4 py-3.5";
const CONN_DASHED = "rounded-md border border-dashed border-line px-4 py-3.5";
const CONN_ICO =
  "size-[30px] shrink-0 grid place-items-center rounded-md bg-chip text-[12px] font-bold text-ink-2";
const CONN_ICO_ACCENT = "bg-accent/15 text-accent";
const CONN_NAME = "min-w-0 text-[13.5px] font-semibold text-ink";
const CONN_WHY = "mt-0.5 min-w-0 text-[12px] text-ink-2 break-words";
const CONN_DETAIL = "mt-3 border-t border-line pt-3";
const INP =
  "w-full min-w-0 rounded-md border border-line-2 bg-bg px-2.5 py-1.5 text-[12.5px] text-ink outline-none transition-colors focus:border-accent placeholder:text-ink-2";
const SECRET_VAL = "rounded bg-chip px-1.5 py-0.5 font-mono text-[11.5px]";
const CHIP = "rounded-full bg-chip px-2 py-0.5 text-[10.5px] font-semibold text-ink-2";

/** Per-provider card spec - defined in connections-list.tsx as data. */
export type ProviderField = {
  key: string;
  label: string;
  type: "text" | "password";
  placeholder?: string;
  mono?: boolean;
};

export type ProviderDef = {
  provider: string;
  icon: string;
  accent?: boolean;
  title: string;
  why: string;
  /** Marks the Gemini card - rendered first, emphasized while absent. */
  required?: boolean;
  /** Google only: the card's only action navigates to a setup route. */
  linkHref?: string;
  /** Gemini's static model chip. */
  model?: string;
  fields?: ProviderField[];
};

/** Status dot pill - ok/warn/err/off map to the token-pair classes. */
export function Pill({
  variant,
  children,
}: {
  variant: "ok" | "warn" | "err" | "off";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold",
        variant === "ok" && "bg-accent/12 text-accent",
        variant === "warn" && "bg-amber/14 text-amber",
        variant === "err" && "bg-red/13 text-red",
        variant === "off" && "bg-chip text-ink-2"
      )}
    >
      <span aria-hidden className="size-[5px] rounded-full bg-current" />
      {children}
    </span>
  );
}

function StatusPill({ row }: { row?: CredentialRow }) {
  if (!row) return <Pill variant="off">Not set up</Pill>;
  if (row.status === "ok") return <Pill variant="ok">Connected</Pill>;
  if (row.status === "error") return <Pill variant="err">Needs attention</Pill>;
  return <Pill variant="off">Saved</Pill>;
}

/** Compact relative timestamp - "never" when there's no record to show. */
function timeAgo(ts?: number): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: ProviderField;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-[12px] text-ink-2">{field.label}</span>
      <input
        type={field.type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
        autoComplete="off"
        spellCheck={false}
        className={cn(INP, field.mono && "font-mono text-[11.5px]")}
      />
    </label>
  );
}

/** The read-only key/value block for the two providers that surface one. */
function DetailBlock({ def, row }: { def: ProviderDef; row: CredentialRow }) {
  const rows: { label: string; node: React.ReactNode }[] = [];
  if (def.provider === "gemini") {
    rows.push(
      { label: "Key", node: <span className={SECRET_VAL}>{row.hint ?? "set"}</span> },
      { label: "Model", node: <span className={CHIP}>{def.model}</span> },
      { label: "Last check", node: <span>{timeAgo(row.lastCheckedAt)}</span> }
    );
  } else if (def.provider === "google") {
    rows.push(
      { label: "Account", node: <span className="break-words">{row.label ?? "-"}</span> },
      { label: "Last sync", node: <span>{timeAgo(row.lastCheckedAt)}</span> }
    );
  }
  if (!rows.length) return null;
  return (
    <dl className="mt-3 grid grid-cols-[minmax(0,116px)_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t border-line pt-3 text-[12px]">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="min-w-0 text-ink-2">{r.label}</dt>
          <dd className="min-w-0 break-words">{r.node}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ConnectionCard({
  def,
  row,
}: {
  def: ProviderDef;
  row?: CredentialRow;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  // A stored card shows detail until "Replace" opens the (always empty) form;
  // an unconfigured card shows its form straight away.
  const [editing, setEditing] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; detail: string } | null>(
    null
  );
  const [saving, startSave] = useTransition();
  const [testing, startTesting] = useTransition();
  const [removing, startRemoving] = useTransition();

  const showForm = editing || !row;
  const linkHref = def.linkHref;

  const setValue = (key: string, v: string) =>
    setValues((prev) => ({ ...prev, [key]: v }));

  const reset = () => {
    setValues({});
    setEditing(false);
    setTestResult(null);
  };

  const onSave = (e: React.FormEvent) => {
    e.preventDefault();
    const fields = Object.fromEntries(
      (def.fields ?? []).map((f) => [f.key, (values[f.key] ?? "").trim()])
    );
    startSave(async () => {
      const res = await saveCredential(def.provider, fields);
      if (res.ok) {
        toast.success("Connection saved");
        reset();
      } else {
        toast.error(res.error);
      }
    });
  };

  const onTest = () => {
    startTesting(async () => {
      const res = await testCredential(def.provider);
      if (res.ok) {
        // Prefer the provider's own verdict ("Responded in 34 ms") over a
        // generic success line - it is the difference between "we called
        // something" and "this key works".
        setTestResult({
          ok: true,
          detail: res.detail ?? "Working - the saved credential accepts a request.",
        });
      } else {
        setTestResult({ ok: false, detail: res.error });
      }
    });
  };

  const onRemove = () => {
    startRemoving(async () => {
      const res = await removeCredential(def.provider);
      if (res.ok) {
        toast.success("Connection removed");
        reset();
      } else {
        toast.error(res.error);
      }
    });
  };

  const actions = () => {
    // Google's only action is navigating to its setup route.
    if (linkHref) {
      return (
        <Button asChild size="sm" variant="default">
          <Link href={linkHref}>{row ? "Manage" : "Set up"}</Link>
        </Button>
      );
    }
    // Unconfigured: the form is always open, so just the primary action.
    if (!row) {
      return (
        <Button type="submit" size="sm" variant="default" disabled={saving}>
          {saving ? "Saving..." : "Connect"}
        </Button>
      );
    }
    // Replacing an existing credential: save or back out to the read-only view.
    if (editing) {
      return (
        <>
          <Button type="submit" size="sm" variant="default" disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={reset}
            disabled={saving}
          >
            Cancel
          </Button>
        </>
      );
    }
    return (
      <>
        <Button type="button" size="sm" variant="secondary" onClick={onTest} disabled={testing}>
          {testing ? "Testing..." : "Test"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => {
            setValues({});
            setEditing(true);
            setTestResult(null);
          }}
        >
          Replace
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-red hover:text-red"
          onClick={onRemove}
          disabled={removing}
        >
          {removing ? "Removing..." : "Remove"}
        </Button>
      </>
    );
  };

  return (
    <form
      onSubmit={onSave}
      className={cn(
        "min-w-0",
        def.required && !row
          ? cn(CONN, "border-amber/45")
          : row
            ? CONN
            : CONN_DASHED
      )}
    >
      <div className="flex items-start gap-[11px] min-w-0">
        <div
          aria-hidden
          className={cn(CONN_ICO, def.accent && CONN_ICO_ACCENT)}
        >
          {def.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <span className={CONN_NAME}>{def.title}</span>
            <StatusPill row={row} />
          </div>
          <p className={CONN_WHY}>{def.why}</p>
          {def.required && !row && (
            <p className="mt-0.5 text-[12px] text-amber">
              Required - matches and inbox fall back to rules-only until this is set.
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {actions()}
        </div>
      </div>

      {row && !showForm && <DetailBlock def={def} row={row} />}

      {showForm && def.fields && (
        <div className={CONN_DETAIL}>
          <div
            className={cn(
              "grid items-start gap-2.5",
              def.fields.length > 1 && "sm:grid-cols-2"
            )}
          >
            {def.fields.map((f) => (
              <FieldInput
                key={f.key}
                field={f}
                value={values[f.key] ?? ""}
                onChange={(v) => setValue(f.key, v)}
              />
            ))}
          </div>
        </div>
      )}

      {testResult && (
        <p
          className={cn(
            "mt-2 text-[11.5px]",
            testResult.ok ? "text-accent" : "text-red"
          )}
        >
          {testResult.detail}
        </p>
      )}

      {/* The stored lastError is the result of the LAST test, so once a live
          testResult is on screen the two say the same thing and the card shows
          the identical red sentence twice. Only fall back to the stored one
          when there is no fresher result to show. */}
      {!testResult && row?.lastError && (
        <p className="mt-1.5 text-[11px] text-red">{row.lastError}</p>
      )}
    </form>
  );
}
