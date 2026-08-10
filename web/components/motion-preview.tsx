"use client";

import { setMotionPreference } from "@/lib/motion-preference";
import {
  useMotionPreference,
  useOsReducesMotion,
} from "@/components/settings/use-motion-preference";

/**
 * Development affordance for reviewing the motion work on a machine whose OS
 * has animations turned off.
 *
 * This uses the same preference store as Settings. Keeping a second storage
 * key here used to race the root preference initializer during hydration and
 * remove a persisted Full override on every development page load.
 */

/** The labelled switch itself. */
export function MotionPreviewToggle() {
  const preference = useMotionPreference();
  const osReduces = useOsReducesMotion();
  const on = preference === "full";

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-line bg-surface px-3 py-2 text-[12.5px]">
      <label className="flex cursor-pointer items-center gap-2 font-medium text-ink">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) =>
            setMotionPreference(e.target.checked ? "full" : "system")
          }
          className="size-3.5 accent-[var(--color-accent)]"
        />
        Force motion
      </label>
      <span className="text-ink-2">
        {osReduces
          ? "this system asks for reduced motion, so animations stay suppressed until you tick this"
          : "this system allows motion; animations already play normally"}
      </span>
    </div>
  );
}
