"use client";

// web/components/site-header.tsx — full replacement.
// 1h: sliding chip indicator behind the nav tabs + one-pass sync sweep on
// route change. Everything else identical to the original.

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { UserChip } from "@/components/user-chip";

const NAV = [
  { href: "/", label: "Matches" },
  { href: "/tracker", label: "Tracker" },
];

export function SiteHeader({ trackerUser }: { trackerUser: string }) {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);
  const [ind, setInd] = useState<{ x: number; w: number } | null>(null);
  // No slide on first paint: transitions enable only after the first measure.
  const [animate, setAnimate] = useState(false);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const el = nav.querySelector<HTMLElement>('[data-active="1"]');
    if (el) setInd({ x: el.offsetLeft, w: el.offsetWidth });
    else setInd(null);
    const id = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(id);
  }, [pathname]);

  return (
    <header className="bg-surface">
      <div className="mx-auto flex w-full max-w-[1060px] flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3">
        <Link
          href="/"
          className="text-[17px] font-semibold tracking-[-0.01em] text-ink"
        >
          intern-watch{" "}
          <span className="font-normal text-ink-2">/ {trackerUser}</span>
        </Link>
        <nav ref={navRef} className="relative flex items-center gap-1">
          {/* sliding indicator (replaces the per-link bg-chip active fill) */}
          <span
            aria-hidden
            className="absolute top-0 left-0 h-full rounded-md bg-chip"
            style={{
              width: ind ? `${ind.w}px` : 0,
              transform: `translateX(${ind ? ind.x : 0}px)`,
              opacity: ind ? 1 : 0,
              transition: animate
                ? "transform .24s var(--ease-spring), width .24s var(--ease-spring), opacity .15s"
                : "none",
            }}
          />
          {NAV.map((n) => {
            const active =
              n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                data-active={active ? "1" : undefined}
                className={cn(
                  "relative rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors",
                  active ? "text-ink" : "text-ink-2 hover:text-ink"
                )}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto">
          <UserChip trackerUser={trackerUser} />
        </div>
      </div>
      {/* 1h sync sweep: 2px track replaces the header's border-b. Keyed by
          pathname so it runs one pass per route change. */}
      <div className="relative h-[2px] overflow-hidden bg-line">
        <span
          key={pathname}
          aria-hidden
          className="absolute inset-y-0 left-0 w-[18%]"
          style={{
            background:
              "linear-gradient(90deg, transparent, var(--color-accent), transparent)",
            animation: "sweep 1.4s ease-in-out .1s 1 both",
          }}
        />
      </div>
      {/* watcher bar — matches screenshot: second row below header */}
      <div className="border-t border-line bg-[#f0ece0] dark:bg-[#1e1c17]">
        <div className="mx-auto flex w-full max-w-[1060px] items-center justify-between px-5 py-1.5 text-[12px] leading-none tabular-nums">
          <span className="text-ink-2">watcher synced 2m ago</span>
          <span className="text-ink-2">
            <b className="font-semibold text-ink">128</b> matches ·{" "}
            <b className="font-semibold text-ink">37</b> applied
          </span>
        </div>
      </div>
    </header>
  );
}
