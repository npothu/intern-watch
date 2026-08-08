"use client";

import { FilterPills, type PillOption } from "@/components/filter-pills";
import {
  isEffectivelyReduced,
  setMotionPreference,
  type MotionPreference,
} from "@/lib/motion-preference";
import { useMotionPreference, useOsReducesMotion } from "@/components/settings/use-motion-preference";
import { MotionPreviewSwatch } from "@/components/settings/motion-preview-swatch";

const OPTIONS: PillOption[] = [
  { key: "system", label: "System" },
  { key: "full", label: "Full" },
  { key: "reduced", label: "Reduced" },
];

/** State-aware helper line - the one thing on this page users actually came
 *  for, since a bare on/off toggle can't explain *why* nothing is animating. */
function helperText(pref: MotionPreference, osReduces: boolean): string {
  switch (pref) {
    case "system":
      return osReduces
        ? "Your system is asking for reduced motion right now, so animations are off. Pick Full to see them anyway."
        : "Following your system's motion setting - animations are currently on.";
    case "full":
      return osReduces
        ? "Always animated, even though your system is asking for reduced motion."
        : "Always animated.";
    case "reduced":
      return "Never animated, even though your system currently allows motion.";
  }
}

export function MotionControl() {
  const pref = useMotionPreference();
  const osReduces = useOsReducesMotion();
  const suppressed = isEffectivelyReduced(pref, osReduces);

  return (
    <div className="flex flex-col gap-2.5">
      <FilterPills
        label="Animation"
        options={OPTIONS}
        value={pref}
        onChange={(key) => setMotionPreference(key as MotionPreference)}
      />
      <p className="text-[12px] leading-snug text-ink-2">{helperText(pref, osReduces)}</p>
      <MotionPreviewSwatch suppressed={suppressed} />
    </div>
  );
}
