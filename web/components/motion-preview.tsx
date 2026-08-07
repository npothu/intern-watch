"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { FORCE_MOTION_ATTR } from "@/lib/motion";

/**
 * Development affordance for reviewing the motion work on a machine whose OS
 * has animations turned off.
 *
 * When Windows' "Animation effects" (or the macOS "Reduce motion" switch) is
 * off, the browser reports `prefers-reduced-motion: reduce` and the app
 * correctly collapses every animation to nothing - which makes the motion
 * impossible to judge. Setting `data-force-motion` on <html> opts out of that
 * suppression for this browser only; globals.css and lib/motion.ts both honour
 * it. Production behaviour is unaffected: nothing here ships, and with the
 * attribute absent the OS preference is respected as before.
 *
 * The choice is stored in localStorage so it survives reloads, and applied by
 * `MotionPreviewInit` on every page rather than only where the toggle renders.
 */

const STORAGE_KEY = "intern-watch:force-motion";

function apply(on: boolean) {
  const html = document.documentElement;
  if (on) html.setAttribute(FORCE_MOTION_ATTR, "");
  else html.removeAttribute(FORCE_MOTION_ATTR);
}

function stored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/* A minimal store, so the toggle's state can be read during render (rather
   than synced into state from an effect) and stays consistent between the
   several places that might show it. */
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};
const serverSnapshot = () => false;

function setForceMotion(on: boolean) {
  apply(on);
  try {
    localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  } catch {
    // private mode - the attribute still applies for this page
  }
  listeners.forEach((cb) => cb());
}

function useForceMotion(): boolean {
  return useSyncExternalStore(subscribe, stored, serverSnapshot);
}

function useOsReducesMotion(): boolean {
  const sub = useCallback((cb: () => void) => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    mq.addEventListener("change", cb);
    return () => mq.removeEventListener("change", cb);
  }, []);
  const snap = useCallback(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    []
  );
  return useSyncExternalStore(sub, snap, serverSnapshot);
}

/** Applies the stored preference. Render once, high in the tree. */
export function MotionPreviewInit() {
  const on = useForceMotion();
  useEffect(() => {
    apply(on);
  }, [on]);
  return null;
}

/** The labelled switch itself. */
export function MotionPreviewToggle() {
  const on = useForceMotion();
  const osReduces = useOsReducesMotion();

  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-line bg-surface px-3 py-2 text-[12.5px]">
      <label className="flex cursor-pointer items-center gap-2 font-medium text-ink">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => setForceMotion(e.target.checked)}
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
