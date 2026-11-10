"use client";

import { useSyncExternalStore } from "react";

export const MINUTE_MS = 60e3;

/**
 * Minute-resolution clock for time-dependent header text (the watcher status
 * chip, the page-data staleness check). `null` on the server and during
 * hydration, so nothing that depends on the visitor's clock renders until the
 * client has mounted and server and client HTML agree.
 */
export function useMinute(): number | null {
  return useSyncExternalStore(
    (onChange) => {
      const id = setInterval(onChange, MINUTE_MS);
      return () => clearInterval(id);
    },
    () => Math.floor(Date.now() / MINUTE_MS),
    () => null
  );
}

/**
 * "Now" for text the server also renders: the server's render time on first
 * paint (so hydration agrees), the visitor's minute tick after that, and
 * never earlier than the server's time, so a slow client clock cannot run an
 * "ago" label backwards.
 */
export function useClock(renderedAt: number): number {
  const minute = useMinute();
  return minute !== null ? Math.max(renderedAt, minute * MINUTE_MS) : renderedAt;
}
