"use client";

import { useEffect, useRef } from "react";

/**
 * Motion primitives shared by the triage surface.
 *
 * One-shot feedback animations (tick pop, check draw, dock keycap ring) run
 * through the Web Animations API rather than CSS keyframes. WAAPI restarts
 * cleanly on every `.animate()` call, so hammering `j` or ticking the same row
 * twice replays the motion without the duplicate-keyframe/parity dance CSS
 * needs - and it keeps the keyframes next to the component that owns them.
 *
 * The global `prefers-reduced-motion` override in globals.css only reaches CSS
 * animations, so every helper here checks the media query itself.
 */

/** Attribute on <html> that overrides the OS reduced-motion preference. */
export const FORCE_MOTION_ATTR = "data-force-motion";

export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  // The preview override wins, so motion can be reviewed on a machine whose OS
  // has animations switched off. Mirrors the guard in globals.css.
  if (document.documentElement.hasAttribute(FORCE_MOTION_ATTR)) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Replays `frames` on the returned ref's element whenever `token` changes to a
 * new non-null number. `null` means "this element has nothing to replay", so a
 * row that was already ticked at first paint renders static - no animation on
 * mount or hydration.
 */
export function useReplay<T extends Element>(
  token: number | null,
  frames: Keyframe[],
  options: KeyframeAnimationOptions
) {
  const ref = useRef<T | null>(null);
  // Kept in a ref so the replay effect can depend on `token` alone; inline
  // keyframe arrays are fresh objects every render and would otherwise refire
  // the animation continuously. Declared first, so it has already refreshed by
  // the time the replay effect below runs on the same commit.
  const spec = useRef({ frames, options });
  useEffect(() => {
    spec.current = { frames, options };
  });

  useEffect(() => {
    const el = ref.current;
    if (!el || token === null || prefersReducedMotion()) return;
    const anim = el.animate(spec.current.frames, spec.current.options);
    return () => anim.cancel();
  }, [token]);

  return ref;
}

/* -- house curves (mirrored in globals.css for the CSS-driven pieces) ------ */

/** Expo-out. Entrances and collapses: fast start, long clean settle. */
export const EASE_OUT_SOFT = "cubic-bezier(0.22, 1, 0.36, 1)";
/** Back-out. Ticks and counters overshoot once, then settle. */
export const EASE_POP = "cubic-bezier(0.34, 1.56, 0.64, 1)";

/**
 * Tick pop: the box springs up from 70%, overshoots past 1 on the back-out
 * curve, and settles. Two keyframes only - the overshoot is the easing, not a
 * hand-placed midpoint, so it stays smooth at any duration.
 */
export const TICK_POP: Keyframe[] = [
  { transform: "scale(0.7)" },
  { transform: "scale(1)" },
];
export const TICK_POP_OPTS: KeyframeAnimationOptions = {
  duration: 340,
  easing: EASE_POP,
};

/**
 * The applied check draws itself. The path carries `stroke-dasharray: 20`, so
 * walking the offset from 20 to 0 sweeps the stroke on. `fill: "backwards"`
 * holds it hidden through the lead-in delay, which lets the box pop first and
 * the check land inside it.
 */
export const CHECK_DRAW: Keyframe[] = [
  { strokeDashoffset: 20 },
  { strokeDashoffset: 0 },
];
export const CHECK_DRAW_OPTS: KeyframeAnimationOptions = {
  duration: 260,
  delay: 60,
  easing: EASE_OUT_SOFT,
  fill: "backwards",
};

/**
 * Dock keycap press: the button dips, rebounds a touch past its size, and
 * blooms a ring outward that fades as it grows. The ring takes the pressed
 * action's own colour (green for applied, amber for save/nav, red for hide) -
 * a single accent ring for every key reads as one undifferentiated flash.
 */
export function keypressFrames(color: string): Keyframe[] {
  const ring = (pct: number, spread: number) =>
    `0 0 0 ${spread}px color-mix(in srgb, ${color} ${pct}%, transparent)`;
  return [
    { transform: "scale(1)", boxShadow: ring(38, 0), offset: 0 },
    { transform: "scale(0.94)", boxShadow: ring(32, 2), offset: 0.26 },
    { transform: "scale(1.035)", boxShadow: ring(15, 6), offset: 0.58 },
    { transform: "scale(1)", boxShadow: ring(0, 10), offset: 1 },
  ];
}
export const KEYPRESS_OPTS: KeyframeAnimationOptions = {
  duration: 380,
  easing: "ease-out",
};
