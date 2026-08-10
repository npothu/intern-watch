import { FORCE_MOTION_ATTR, REDUCE_MOTION_ATTR } from "./motion-constants";

/**
 * The persistent, three-way animation preference behind Settings >
 * Appearance. "system" (the default) obeys `prefers-reduced-motion` exactly
 * as the app always has; "full" and "reduced" are explicit overrides in
 * either direction, expressed as attributes on <html>:
 *
 *   full    -> data-force-motion  (pre-existing - see lib/motion.ts)
 *   reduced -> data-reduce-motion (new)
 *
 * "system" sets neither attribute, so the OS media query drives things
 * exactly as before. No component here re-derives the OS state: the media
 * query in globals.css already does that declaratively, and duplicating it
 * in JS would just be a second place for the two to drift apart.
 *
 * Deliberately hook-free: app/layout.tsx (a Server Component) imports
 * MOTION_PREFERENCE_INIT_SCRIPT from here directly, and a module reachable
 * from a Server Component can't pull in React's client-only hooks - Next
 * fails the build if it does. The `useMotionPreference`/`useOsReducesMotion`
 * hooks that read this same storage live in
 * components/settings/use-motion-preference.ts ("use client") instead.
 */

export type MotionPreference = "system" | "full" | "reduced";

const PREFERENCES: readonly MotionPreference[] = ["system", "full", "reduced"];
export const MOTION_PREFERENCE_STORAGE_KEY = "intern-watch:motion-preference";

export function isMotionPreference(v: unknown): v is MotionPreference {
  return typeof v === "string" && (PREFERENCES as readonly string[]).includes(v);
}

export function readMotionPreference(): MotionPreference {
  try {
    const v = localStorage.getItem(MOTION_PREFERENCE_STORAGE_KEY);
    return isMotionPreference(v) ? v : "system";
  } catch {
    return "system";
  }
}

function applyMotionPreference(pref: MotionPreference) {
  const html = document.documentElement;
  html.toggleAttribute(FORCE_MOTION_ATTR, pref === "full");
  html.toggleAttribute(REDUCE_MOTION_ATTR, pref === "reduced");
}

export function setMotionPreference(pref: MotionPreference) {
  applyMotionPreference(pref);
  try {
    localStorage.setItem(MOTION_PREFERENCE_STORAGE_KEY, pref);
  } catch {
    // private mode - the attribute still applies for this page
  }
  motionPreferenceListeners.forEach((cb) => cb());
}

/* Minimal store so components can read the preference during render via
   useSyncExternalStore (React's hydration-safe way to read something that
   can differ between server and client) - same shape as the pre-existing
   force-motion store in components/motion-preview.tsx. Lives here (rather
   than in the "use client" hook file) so setMotionPreference, which every
   caller reaches through this module, can notify it directly. */
export const motionPreferenceListeners = new Set<() => void>();

/** True when motion is actually suppressed right now, given both the stored
 *  preference and (for "system") the live OS query. Mirrors prefersReducedMotion()
 *  in lib/motion.ts - kept as a separate small helper here since components
 *  reading it usually already have both pieces of state for the helper copy. */
export function isEffectivelyReduced(pref: MotionPreference, osReduces: boolean): boolean {
  if (pref === "full") return false;
  if (pref === "reduced") return true;
  return osReduces;
}

/**
 * Blocking inline script for the root layout - reads localStorage and stamps
 * the attribute on <html> before first paint, the same technique next-themes
 * uses for `class` (see components/theme-provider.tsx). Getting this wrong
 * means a flash of the wrong motion state on every load: an entrance
 * animation plays once under "reduced", or a page loads inert under "full"
 * for a frame before JS catches up.
 */
export const MOTION_PREFERENCE_INIT_SCRIPT = `(function(){try{var v=localStorage.getItem(${JSON.stringify(
  MOTION_PREFERENCE_STORAGE_KEY
)});var h=document.documentElement;if(v==="full")h.setAttribute(${JSON.stringify(
  FORCE_MOTION_ATTR
)},"");else if(v==="reduced")h.setAttribute(${JSON.stringify(
  REDUCE_MOTION_ATTR
)},"");}catch(e){}})();`;
