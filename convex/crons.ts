import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Gmail watches expire after ~7 days, so re-arm them daily before typical
// activity starts. If a watch lapses silently, pushes stop arriving with no
// notification - the renewal is the guard against that.
crons.daily(
  "renew gmail watches",
  { hourUTC: 6, minuteUTC: 0 },
  internal.mail.renewWatches,
  {},
);

// Daily backstop for accounts that missed a push (dropped notification,
// expired watch, transient failure): re-reads history and syncs anything
// that slipped through, and surfaces accounts stuck in an error state.
crons.daily(
  "mail reconcile sweep",
  { hourUTC: 6, minuteUTC: 30 },
  internal.mail.reconcile,
  {},
);

export default crons;
