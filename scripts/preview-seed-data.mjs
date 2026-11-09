// Synthetic tracker data for per-PR preview backends.
//
// Previews start from an empty Convex deployment (scripts/vercel-build.sh never
// imports production). This builds a small, deterministic, entirely fictional
// dataset so a preview has something to click through: matches across terms,
// a few ticks, and applications in every status. Every company is invented and
// every URL is on the reserved `.invalid` TLD, so nothing here can be mistaken
// for, or link to, a real posting.
//
// Pure: pass the hash function (sha1 hex) so it runs under both Node and tests.

const COMPANIES = [
  "Acme Robotics", "Bluefin Labs", "Cobalt Systems", "Driftwood AI", "Ember Analytics",
  "Foxglove Cloud", "Granite Security", "Harbor Health Tech", "Ion Avionics", "Juniper Data",
  "Kestrel Autonomy", "Lumen Devices", "Meridian Fintech", "Nimbus Compute", "Orchid Games",
];
const ROLES = [
  "Software Engineer Intern", "Backend Engineer Intern", "Machine Learning Engineer Intern",
  "Embedded Software Intern", "Platform Engineer Intern", "Security Engineer Intern",
  "Full Stack Engineer Intern", "Firmware Engineer Intern",
];
const TERMS = ["Summer 2027", "Summer 2027", "Summer 2027", "Spring 2027", "Fall 2027"];
const PLACES = ["Atlanta, GA", "Remote (US)", "Austin, TX", "Seattle, WA", "New York, NY", "San Jose, CA"];
// Source ids as the watcher records them (sources.yaml names).
const SOURCES = ["jobright-swe", "ats-boards", "simplify", "speedyapply", "vanshb03"];
// New matches per watcher run, newest last, for the header sparkline.
const RUN_COUNTS = [0, 2, 1, 0, 3, 0, 0, 5, 1, 0, 2, 1];
// [status, note] pairs walked in order for the seeded applications.
const LEDGER = [
  ["applied", "Seed: submitted"],
  ["applied", "Seed: submitted"],
  ["applied", "Seed: submitted"],
  ["oa", "Seed: online assessment received"],
  ["oa", "Seed: online assessment received"],
  ["phone_screen", "Seed: recruiter call scheduled"],
  ["interview", "Seed: onsite loop"],
  ["rejected", "Seed: not moving forward"],
  ["offer", "Seed: offer received"],
  ["withdrawn", "Seed: withdrew"],
];

/**
 * Display-only match facts (the `item.facts` contract the watcher pushes, see
 * src/match_facts.py), varied so the detail panel shows every shape.
 * @param {number} i
 * @param {{ added: string, location: string, priority: boolean }} item
 */
function factsFor(i, { added, location, priority }) {
  const source = SOURCES[i % SOURCES.length];
  const facts = { source, sources: i % 4 === 2 ? [source, "jobright-swe"].sort() : [source] };
  if (source === "ats-boards" || source === "simplify") {
    const d = new Date(`${added}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1 - (i % 3));
    facts.postedAt = d.toISOString().slice(0, 10);
  }
  facts.termSource = i % 4 === 1 ? "llm" : "title";
  if (priority) {
    facts.delivery = { mode: "immediate", at: `${added}T13:05:00Z` };
  } else if (i % 3 === 1) {
    facts.delivery = { mode: "digest", at: `${added}T12:02:00Z` };
  }
  if (priority) {
    facts.acceptedBy = "priority";
    facts.acceptedRule = "company:priority";
    facts.topCompany = { verdict: true, judgedAt: added, source: "list" };
  } else if (i === 8) {
    facts.acceptedBy = "rule";
    facts.acceptedRule = "company:top_companies (LLM)";
    facts.topCompany = { verdict: true, judgedAt: "2026-09-14", source: "llm" };
  }
  // Row 18 (Atlanta, GA in this layout) carries the LLM metro verdict.
  if (i === 18) {
    facts.acceptedBy = "rule";
    facts.acceptedRule = "location:atlanta (LLM)";
    facts.metro = { name: "Atlanta, GA", verdict: true, source: "llm" };
  } else if (!facts.acceptedBy && location === "Atlanta, GA") {
    facts.acceptedBy = "rule";
    facts.acceptedRule = "location:atlanta-metro";
    facts.metro = { name: "Atlanta, GA", verdict: true, source: "rules" };
  } else if (!facts.acceptedBy && location.startsWith("Remote")) {
    facts.acceptedBy = "rule";
    facts.acceptedRule = "location:remote";
  }
  if (i === 9) facts.clearanceObtainable = true;
  if (i === 11) {
    facts.termSource = "unresolved";
    facts.acceptedBy = "unresolved-all-terms";
    facts.acceptedRule = "company:top_companies";
    facts.topCompany = { verdict: true, judgedAt: added, source: "list" };
  }
  if (!facts.acceptedBy) {
    facts.acceptedBy = "rule";
    facts.acceptedRule = "always";
  }
  return facts;
}

/**
 * Twelve watcher runs over the 24h before `nowMs`, ascending.
 * @param {number} nowMs
 */
function buildWatchRuns(nowMs) {
  const HOUR = 60 * 60 * 1000;
  return RUN_COUNTS.map((newMatches, k) => ({
    at: nowMs - (RUN_COUNTS.length - 1 - k) * 2 * HOUR - (7 + (k % 4) * 3) * 60 * 1000,
    newMatches,
    scanned: 180 + ((k * 37) % 60),
    source: "schedule",
  }));
}

/**
 * @param {(s: string) => string} sha1Hex
 * @param {{ matches?: number, today?: string, nowMs?: number }} [opts]
 */
export function buildPreviewSeed(sha1Hex, { matches = 36, today = "2026-11-01", nowMs } = {}) {
  const now = nowMs ?? Date.parse(`${today}T12:00:00Z`);
  const items = [];
  for (let i = 0; i < matches; i++) {
    const company = COMPANIES[i % COMPANIES.length];
    const title = ROLES[(i * 7) % ROLES.length];
    const slug = `${company}-${title}-${i}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const url = `https://jobs.${company.toLowerCase().replace(/[^a-z0-9]+/g, "")}.invalid/postings/${slug}`;
    const key = `url:${url}`;
    const day = String(1 + (i % 28)).padStart(2, "0");
    items.push({
      key,
      short: sha1Hex(key).slice(0, 12),
      company,
      title,
      term: TERMS[i % TERMS.length],
      location: PLACES[i % PLACES.length],
      url,
      added: `${today.slice(0, 8)}${day}`,
      applied: false,
      priority: i % 5 === 0,
      salary: i % 3 === 0 ? `$${40 + (i % 6) * 5}/hr` : null,
      tag: i % 5 === 0 ? "[TOP]" : "",
    });
    const item = items[items.length - 1];
    item.facts = factsFor(i, item);
    // An unresolved term is accepted with no term at all (watcher shape).
    if (item.facts.termSource === "unresolved") item.term = null;
  }
  const applications = LEDGER.map(([status, note], j) => {
    const item = items[j * 2];
    const { short, key, company, title, term, location, url, added, salary, tag } = item;
    return { short, status, note, snapshot: { short, key, company, title, term, location, url, added, salary, tag, source: "preview-seed" } };
  });
  const appliedShorts = new Set(applications.map((a) => a.short));
  for (const item of items) item.applied = appliedShorts.has(item.short);
  const ticks = [
    ...applications.map((a) => ({ short: a.short, field: "applied", value: true })),
    ...items.filter((_, i) => i % 9 === 3).map((it) => ({ short: it.short, field: "saved", value: true })),
    ...items.filter((_, i) => i % 11 === 5).map((it) => ({ short: it.short, field: "dismissed", value: true })),
  ];
  return { items, applications, ticks, watchRuns: buildWatchRuns(now) };
}
