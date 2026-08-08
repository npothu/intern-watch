"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * The inbox's pending-action count, needed on every surface: the view switch
 * badges its inactive Inbox cell with it, and Inbox's own cell reads the same
 * number as its active count so the two never disagree. Threaded through
 * context because the four surfaces are siblings under one layout (see
 * app/(app)/layout.tsx), not a chain of props - and layout already fetches it
 * once via getHealth for the old header badge.
 */
const InboxPendingContext = createContext(0);

export function InboxPendingProvider({
  value,
  children,
}: {
  value: number;
  children: ReactNode;
}) {
  return (
    <InboxPendingContext.Provider value={value}>
      {children}
    </InboxPendingContext.Provider>
  );
}

export function useInboxPending(): number {
  return useContext(InboxPendingContext);
}
