// URL -> (ATS, board) for hand-added postings, so a manual add can say
// "this employer isn't watched - add the board?". Mirror of detect() in
// src/coverage.py; shared/ats-board-cases.json pins both to the same answers.
// ATS names are the `ats:` values data/ats_boards.yaml uses.

// `scope` is set only with board null: the host a URL names when the full
// slug isn't in it (a bare <tenant>.eightfold.ai, whose slug adds a domain).
export type AtsBoard = { ats: string; board: string | null; scope?: string };

type Rule = (host: string, path: string[], q: URLSearchParams) => AtsBoard | null;

const seg = (path: string[], i: number): string | null => path[i] || null;

const greenhouse: Rule = (host, path, q) => {
  const m = /^(?:job-)?boards(?:-api)?(\.eu)?\.greenhouse\.io$/.exec(host);
  if (m) {
    const ats = m[1] ? "greenhouse-eu" : "greenhouse";
    if (seg(path, 0) === "embed") return { ats, board: q.get("for") || null };
    if (seg(path, 0) === "v1" && seg(path, 1) === "boards") return { ats, board: seg(path, 2) };
    return { ats, board: seg(path, 0) };
  }
  return q.has("gh_jid") ? { ats: "greenhouse", board: null } : null;
};

const lever: Rule = (host, path) => {
  const m = /^jobs(\.eu)?\.lever\.co$/.exec(host);
  return m ? { ats: m[1] ? "lever-eu" : "lever", board: seg(path, 0) } : null;
};

const ashby: Rule = (host, path, q) => {
  if (host === "jobs.ashbyhq.com") return { ats: "ashby", board: seg(path, 0) };
  return q.has("ashby_jid") ? { ats: "ashby", board: null } : null;
};

const smartrecruiters: Rule = (host, path) =>
  host === "jobs.smartrecruiters.com" || host === "careers.smartrecruiters.com"
    ? { ats: "smartrecruiters", board: seg(path, 0) }
    : null;

// Hosts that front a tenant one of the listing adapters polls; mirrors
// ORACLE_CUSTOM_HOSTS / EIGHTFOLD_BOARDS / JIBE_HOSTS in src/coverage.py.
const ORACLE_CUSTOM_HOSTS: Record<string, string> = {
  "careers.americanexpress.com": "egug.fa.us2.oraclecloud.com",
};
const EIGHTFOLD_BOARDS: Record<string, string> = {
  "apply.careers.microsoft.com": "apply.careers.microsoft.com/microsoft.com",
  "careers.micron.com": "micron.eightfold.ai/micron.com",
};
const JIBE_HOSTS = new Set(["careers.amd.com"]);

// Board slug is "<tenant>.<wdN>/<site>"; myworkdaysite.com isn't pollable.
const workday: Rule = (host, path) => {
  const m = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/.exec(host);
  if (m) {
    const rest = path.length && /^[a-z]{2}-[A-Z]{2}$/.test(path[0]) ? path.slice(1) : path;
    const site = seg(rest, 0);
    return { ats: "workday", board: site ? `${m[1]}.${m[2]}/${site}` : null };
  }
  return /^wd\d+\.myworkdaysite\.com$/.test(host) ? { ats: "workday", board: null } : null;
};

// Board slug is "<pod host>/<site>"; a vanity host counts only when its pod is known.
const oracle: Rule = (host, path) => {
  for (let i = 1; i < path.length; i++) {
    if (path[i] !== "sites" || !/^[a-z]{2}(-[A-Z]{2})?$/.test(path[i - 1])) continue;
    const site = seg(path, i + 1);
    if (!site) continue;
    if (host.endsWith(".oraclecloud.com")) return { ats: "oracle", board: `${host}/${site}` };
    if (ORACLE_CUSTOM_HOSTS[host]) return { ats: "oracle", board: `${ORACLE_CUSTOM_HOSTS[host]}/${site}` };
    if (/^CX(_\d+)?$/.test(site)) return { ats: "oracle", board: null };
  }
  return null;
};

// Board slug is "<host>/<company domain>"; the domain isn't in the URL.
const eightfold: Rule = (host) => {
  if (EIGHTFOLD_BOARDS[host]) return { ats: "eightfold", board: EIGHTFOLD_BOARDS[host] };
  return host.endsWith(".eightfold.ai") ? { ats: "eightfold", board: null, scope: host } : null;
};

const ibm: Rule = (host, path) =>
  host === "careers.ibm.com" || (host === "ibm.com" && seg(path, 0) === "careers")
    ? { ats: "ibm", board: "careers" }
    : null;

const jibe: Rule = (host) => (JIBE_HOSTS.has(host) ? { ats: "jibe", board: host } : null);

const hostRule = (ats: string, re: RegExp, pick: (m: RegExpExecArray) => string): Rule =>
  (host) => {
    const m = re.exec(host);
    return m ? { ats, board: pick(m) } : null;
  };

const workable: Rule = (host, path) => {
  if (host === "apply.workable.com") return { ats: "workable", board: seg(path, 0) };
  const m = /^([a-z0-9-]+)\.workable\.com$/.exec(host);
  return m ? { ats: "workable", board: m[1] } : null;
};

const radancy: Rule = (host, path) => {
  const n = path.length;
  return n >= 5 && path[0] === "job" && /^\d+$/.test(path[n - 1]) && /^\d+$/.test(path[n - 2])
    ? { ats: "radancy", board: host }
    : null;
};

// greenhouse-eu, lever-eu, avature, icims, workable, taleo, successfactors and
// radancy have no adapter: they only ever label "unsupported" misses.
const RULES: Rule[] = [
  greenhouse,
  lever,
  ashby,
  smartrecruiters,
  workday,
  oracle,
  eightfold,
  ibm,
  jibe,
  hostRule("avature", /^[a-z0-9-]+\.avature\.net$/, (m) => m[0]),
  hostRule("icims", /^([a-z0-9-]+)\.icims\.com$/, (m) => m[1]),
  workable,
  hostRule("taleo", /^([a-z0-9-]+)\.taleo\.net$/, (m) => m[1]),
  hostRule("successfactors", /^[a-z0-9.-]+\.successfactors\.(?:com|eu)$/, (m) => m[0]),
  radancy,
];

export function detectAtsBoard(raw: string): AtsBoard | null {
  let u: URL;
  try {
    u = new URL((raw || "").trim());
  } catch {
    return null;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const path = u.pathname.split("/").filter(Boolean);
  for (const rule of RULES) {
    const hit = rule(host, path, u.searchParams);
    if (hit) return hit;
  }
  return { ats: "other", board: host };
}

/** "ats:board" the way the watch report lists watched boards
 * (src/coverage.py watched_board_ids). */
export function boardId(b: AtsBoard): string | null {
  return b.board ? `${b.ats}:${b.board.toLowerCase()}` : null;
}

type CoverageReport = { watched_boards?: unknown; supported_ats?: unknown } | null | undefined;

/** Whether a hand-added URL's board is one the watcher polls, given the
 * watcher's last report. Exact board match: a listing is per board (Oracle
 * lists one site of a pod, Eightfold one domain of a host), so a sibling
 * board on the same host doesn't cover it. A URL naming only its host
 * counts as watched when exactly one polled board sits on that host.
 * undefined when it can't be said: no report, or no board to compare.
 * Mirrors is_watched in src/coverage.py. */
export function isBoardWatched(b: AtsBoard | null, watchReport: unknown): boolean | undefined {
  const watched = (watchReport as CoverageReport)?.watched_boards;
  if (!b || !Array.isArray(watched)) return undefined;
  const id = boardId(b);
  if (id) return watched.includes(id);
  if (b.scope) {
    const prefix = `${b.ats}:${b.scope.toLowerCase()}/`;
    if (watched.filter((w) => typeof w === "string" && w.startsWith(prefix)).length === 1) return true;
  }
  return undefined;
}

/** Whether the ats-boards adapter can poll this ATS at all (so a yaml row
 * would close the gap). undefined without a report that says. */
export function isAtsSupported(b: AtsBoard | null, watchReport: unknown): boolean | undefined {
  const supported = (watchReport as CoverageReport)?.supported_ats;
  if (!b || !Array.isArray(supported)) return undefined;
  return supported.includes(b.ats);
}

/** Free-text "where did you find this" label, normalized for counting. */
export function normalizeFoundVia(raw: string | undefined): string | undefined {
  const s = (raw || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 40);
  return s || undefined;
}
