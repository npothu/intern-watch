// Maintenance switch for operator cutovers (e.g. a tracker user-key rename).
//
// Set the Convex env var TRACKER_MAINTENANCE=1 to make every public endpoint,
// the Gmail push/callback HTTP routes and the daily mail crons refuse to run,
// so nothing can write per-user rows while a migration rewrites them. Unset it
// (or set it to anything else) to reopen. Internal functions run by the
// operator (`npx convex run`) are not blocked; the migration itself requires
// the switch to be ON (see migrations.ts).

import { ConvexError } from "convex/values";

export function maintenanceOn(): boolean {
  return process.env.TRACKER_MAINTENANCE === "1";
}

export const MAINTENANCE_MESSAGE =
  "Intern Baddie is briefly down for maintenance. Try again in a few minutes.";

/** Throw from any public entry point while maintenance is on. */
export function assertNotMaintenance(): void {
  if (maintenanceOn()) throw new ConvexError(MAINTENANCE_MESSAGE);
}
