import type { ReactNode } from "react";

/**
 * Titled section + labelled rows, the shape every settings page eventually
 * needs. One section ("Appearance") with two rows exists today (theme,
 * motion) - the next preference is another <SettingsRow>, not a rewrite.
 */

export function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-md border border-line bg-surface">
      <h2 className="border-b border-line px-4 py-3 text-[13px] font-semibold text-ink">
        {title}
      </h2>
      <div className="divide-y divide-line">{children}</div>
    </section>
  );
}

export function SettingsRow({
  label,
  description,
  children,
}: {
  label: string;
  /** Short helper line under the label - state-aware copy goes here. */
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5 px-4 py-3.5 sm:flex-row sm:items-start sm:gap-6">
      {/* Fixed-width label column, shrink-0 so it can't be squeezed - the
          control column (flex-1 min-w-0) absorbs the remaining width and
          wraps its own contents instead. Without shrink-0 here, a wide
          control (like the animation row's helper paragraph) claims all the
          space and crushes the label into a single-word-per-line column. */}
      <div className="shrink-0 sm:w-[180px]">
        <div className="text-[13px] font-medium text-ink">{label}</div>
        {description && (
          <p className="mt-0.5 text-[12px] leading-snug text-ink-2">{description}</p>
        )}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
