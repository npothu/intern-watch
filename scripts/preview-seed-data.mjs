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
 * @param {(s: string) => string} sha1Hex
 * @param {{ matches?: number, today?: string }} [opts]
 */
export function buildPreviewSeed(sha1Hex, { matches = 36, today = "2026-11-01" } = {}) {
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
  // A watcher report naming a few fictional watched boards, so the add-URL
  // dialog's "board isn't watched" hint has something to compare against:
  // https://job-boards.greenhouse.io/previewwatched/jobs/1 reads as watched,
  // any other board as not.
  const watchReport = {
    reported_at: `${today}T12:00:00+00:00`,
    watched_boards: ["ashby:previewwatched", "greenhouse:previewwatched", "lever:previewwatched"],
    supported_ats: ["ashby", "greenhouse", "lever", "smartrecruiters"],
  };
  return { items, applications, ticks, watchReport };
}
