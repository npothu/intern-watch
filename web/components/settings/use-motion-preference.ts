"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  motionPreferenceListeners,
  readMotionPreference,
  type MotionPreference,
} from "@/lib/motion-preference";

/**
 * Hooks for lib/motion-preference.ts, split into their own "use client" file
 * because app/layout.tsx (a Server Component) imports that module directly
 * for MOTION_PREFERENCE_INIT_SCRIPT - a module reachable from a Server
 * Component can't also export React's client-only hooks.
 */

function subscribeMotionPreference(cb: () => void) {
  motionPreferenceListeners.add(cb);
  return () => motionPreferenceListeners.delete(cb);
}
const serverSnapshot = (): MotionPreference => "system";

export function useMotionPreference(): MotionPreference {
  return useSyncExternalStore(subscribeMotionPreference, readMotionPreference, serverSnapshot);
}

/** Whether the OS is currently asking for reduced motion, live-updated. */
export function useOsReducesMotion(): boolean {
  const subscribeOs = useCallback((cb: () => void) => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
  }, []);
  const snapshot = useCallback(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    []
  );
  return useSyncExternalStore(subscribeOs, snapshot, () => false);
}
