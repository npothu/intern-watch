"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAppView, nextViewId, type ViewId } from "@/lib/view";

/**
 * `t` cycles Matches -> Tracker -> Inbox -> Matches from anywhere in the app.
 * Mounted once in app/(app)/layout.tsx rather than in triage.tsx: only one
 * surface is ever mounted at a time (app-views.tsx), so a surface-local
 * handler would go dead the moment the user left it, and Inbox/Resume don't
 * mount triage.tsx at all.
 *
 * Guards mirror triage.tsx's own keydown handler exactly (isInput check, bare
 * key only) so typing "t" into a search box never fires a switch mid-keystroke,
 * and it stays out of the capture-phase Cmd/Ctrl+K handler's way by only ever
 * acting on the unmodified "t" key.
 */
export function ViewCycle() {
  const pathname = usePathname();
  const router = useRouter();
  const { view, show } = useAppView();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "t") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (isInput) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();

      const current: ViewId | null =
        pathname === "/inbox" ? "inbox" : pathname === "/" ? view : null;
      const next = nextViewId(current);
      if (next === "inbox") router.push("/inbox");
      else show(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pathname, view, show, router]);

  return null;
}
