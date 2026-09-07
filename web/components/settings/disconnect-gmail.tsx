"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { disconnectGmail } from "@/app/(app)/settings/connections/connections-actions";

export function DisconnectGmail() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <Button variant="outline" disabled={pending} onClick={() => startTransition(async () => {
        setError(null);
        const result = await disconnectGmail();
        if (!result.ok) setError(result.error);
        else router.replace("/settings/connections/google");
        router.refresh();
      })}>
        {pending ? "Disconnecting…" : "Disconnect Gmail"}
      </Button>
      <p className="text-[11.5px] text-ink-2">
        Stops future syncs and removes the saved mailbox token. Existing tracker history stays.
        You can also <a className="text-accent underline" href="https://myaccount.google.com/connections" target="_blank" rel="noreferrer">revoke the Google grant</a>.
      </p>
      {error && <p role="alert" className="text-[12px] text-red">{error}</p>}
    </div>
  );
}
