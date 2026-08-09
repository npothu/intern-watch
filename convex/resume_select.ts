// Pure project-selection for the Convex-native resume builder.
//
// This module is a port of src/resume/select.py (project scoring + variant
// picking) plus the JD analysis it depends on (src/resume/jd.py). It scores
// the bank's projects against the raw JD text, sorts them, and returns the
// subset that should surface on the resume, deterministic for a given bank +
// JD. Its only dependency is the v2 profile shapes from ./profile_schema plus
// the projectEntries helper from ./resume_docx, so it stays directly
// unit-testable without a Convex backend.
//
// It MUST stay in lockstep with the Python sources: if you change the lexicon,
// the W_* multipliers, MAX/MIN_PROJECTS, or the score/sort rules here, mirror
// the change in src/resume/jd.py and src/resume/select.py (and vice versa).
//
// Python parity notes:
//  - W_TAG/W_TECH/W_TEXT match-strength multipliers mirror select.py.
//  - `analyze` ports jd.py.analyze -> a JDProfile of canonical-skill weights.
//  - `selectProjects` ports the "score, sort (score desc then bank order),
//    cap/pad" rule. Padded fallback: when fewer than MIN_PROJECTS projects
//    score above zero, pad with the remaining (zero-score) projects in bank
//    order up to MAX_PROJECTS.

import type { ProfileV2, Entry } from "./profile_schema";
import { projectEntries } from "./resume_docx";

// match-strength multipliers: where in the project a JD skill was found
export const W_TAG = 3; // explicit tags are the strongest signal
export const W_TECH = 2; // listed tech stack
export const W_TEXT = 1; // bullet prose

export const MAX_PROJECTS = 6;
export const MIN_PROJECTS = 4;

// --- JD analysis (port of jd.py) -----------------------------------------

// canonical skill -> alias regexes (matched case-insensitively, on raw text).
// Kept as source strings for parity with jd.py's LEXICON; compiled lazily.
const LEXICON: Record<string, string[]> = {
  python: [String.raw`\bpython\b`],
  java: [String.raw`\bjava\b(?!script)`],
  javascript: [String.raw`\bjavascript\b`, String.raw`(?<![.\w])js\b`, String.raw`\bnode(?:\.js|js)?\b`],
  typescript: [String.raw`\btypescript\b`, String.raw`(?<![.\w])ts\b`],
  c: [String.raw`(?<![\w+#.])c(?![\w+#])`],
  "c++": [String.raw`c\+\+`],
  "c#": [String.raw`c#`, String.raw`\b\.net\b`],
  golang: [String.raw`\bgo(?:lang)?\b`],
  sql: [String.raw`\bsql\b`],
  bash: [String.raw`\bbash\b`, String.raw`\bshell script`],
  assembly: [String.raw`\bassembly\b`, String.raw`\brisc-?v\b`, String.raw`\bmips\b`, String.raw`\bx86\b`],
  "html/css": [String.raw`\bhtml\b`, String.raw`\bcss\b`],
  "machine learning": [
    String.raw`\bmachine learning\b`,
    String.raw`(?<![\w/])ml(?![\w/])`,
    String.raw`\bdeep learning\b`,
    String.raw`\bneural net`,
  ],
  ai: [
    String.raw`(?<![\w/])ai(?![\w/])`,
    String.raw`\bartificial intelligence\b`,
    String.raw`\bllms?\b`,
    String.raw`\bgenerative ai\b`,
    String.raw`\bgenai\b`,
  ],
  pytorch: [String.raw`\bpytorch\b`, String.raw`\btorch\b`],
  tensorflow: [String.raw`\btensorflow\b`, String.raw`\bkeras\b`],
  xgboost: [String.raw`\bxgboost\b`, String.raw`\bgradient boost`],
  "scikit-learn": [String.raw`\bscikit-?learn\b`, String.raw`\bsklearn\b`],
  pandas: [String.raw`\bpandas\b`],
  numpy: [String.raw`\bnumpy\b`],
  "feature engineering": [String.raw`\bfeature engineering\b`, String.raw`\bfeature selection\b`],
  "data pipelines": [
    String.raw`\bdata pipeline`,
    String.raw`\betl\b`,
    String.raw`\bdata processing\b`,
    String.raw`\bdata engineering\b`,
  ],
  "computer vision": [
    String.raw`\bcomputer vision\b`,
    String.raw`(?<![\w/])cv(?![\w/])`,
    String.raw`\bimage processing\b`,
  ],
  nlp: [String.raw`\bnlp\b`, String.raw`\bnatural language\b`],
  "signal processing": [String.raw`\bsignal processing\b`, String.raw`\btime[- ]series\b`],
  "rest apis": [String.raw`\brest(?:ful)?\b`, String.raw`\bapis?\b`, String.raw`\bhttp\b`],
  fastapi: [String.raw`\bfastapi\b`],
  react: [String.raw`\breact\b`],
  frontend: [String.raw`\bfront[- ]?end\b`, String.raw`\bui\b`, String.raw`\buser interface`],
  backend: [String.raw`\bback[- ]?end\b`, String.raw`\bserver[- ]side\b`],
  "full stack": [String.raw`\bfull[- ]?stack\b`],
  docker: [String.raw`\bdocker\b`, String.raw`\bcontainer`],
  kubernetes: [String.raw`\bkubernetes\b`, String.raw`\bk8s\b`],
  aws: [
    String.raw`\baws\b`,
    String.raw`\bamazon web services\b`,
    String.raw`\bec2\b`,
    String.raw`\bs3\b`,
    String.raw`\blambda\b`,
  ],
  gcp: [String.raw`\bgcp\b`, String.raw`\bgoogle cloud\b`],
  azure: [String.raw`\bazure\b`],
  cloud: [String.raw`\bcloud\b`],
  "ci/cd": [
    String.raw`\bci/?cd\b`,
    String.raw`\bcontinuous integration\b`,
    String.raw`\bjenkins\b`,
    String.raw`\bgithub actions\b`,
  ],
  git: [String.raw`\bgit\b(?!hub actions)`],
  linux: [String.raw`\blinux\b`, String.raw`\bunix\b`, String.raw`\bposix\b`],
  kernel: [String.raw`\bkernel\b`, String.raw`\bsystems? programming\b`, String.raw`\blow[- ]level\b`],
  "operating systems": [String.raw`\boperating systems?\b`, String.raw`(?<![\w/])os(?![\w/])`],
  embedded: [
    String.raw`\bembedded\b`,
    String.raw`\bmicrocontroller`,
    String.raw`\bstm32\b`,
    String.raw`\bbare[- ]metal\b`,
    String.raw`\bspi\b`,
    String.raw`\bi2c\b`,
    String.raw`\buart\b`,
  ],
  firmware: [String.raw`\bfirmware\b`],
  "real-time": [String.raw`\breal[- ]time\b`, String.raw`\brtos\b`],
  hardware: [
    String.raw`\bhardware\b`,
    String.raw`\bsensors?\b`,
    String.raw`\bimu\b`,
    String.raw`\bavionics\b`,
    String.raw`\bflight (?:software|computer)\b`,
    String.raw`\baerospace\b`,
  ],
  robotics: [String.raw`\brobotics?\b`, String.raw`\bautonom`],
  concurrency: [
    String.raw`\bconcurren`,
    String.raw`\bmulti[- ]?thread`,
    String.raw`\bparallel`,
    String.raw`\basync`,
    String.raw`\bsynchronization\b`,
    String.raw`\block-free\b`,
  ],
  "memory management": [
    String.raw`\bmemory management\b`,
    String.raw`\bmemory alloc`,
    String.raw`\bperformance optimi`,
  ],
  "distributed systems": [
    String.raw`\bdistributed\b`,
    String.raw`\bscalab`,
    String.raw`\bmicroservices?\b`,
    String.raw`\bhigh[- ]throughput\b`,
    String.raw`\bgrpc\b`,
    String.raw`\blarge[- ]scale\b`,
  ],
  databases: [
    String.raw`\bdatabases?\b`,
    String.raw`\bdata model`,
    String.raw`\bschema\b`,
    String.raw`\bstored procedures?\b`,
    String.raw`\brelational\b`,
  ],
  mysql: [String.raw`\bmysql\b`],
  postgresql: [String.raw`\bpostgres(?:ql)?\b`],
  nosql: [
    String.raw`\bnosql\b`,
    String.raw`\bfirestore\b`,
    String.raw`\bmongodb\b`,
    String.raw`\bdynamodb\b`,
    String.raw`\bredis\b`,
  ],
  caching: [String.raw`\bcach(?:e|ing)\b`, String.raw`\blatency\b`],
  testing: [
    String.raw`\bunit test`,
    String.raw`\btest[- ]driven\b`,
    String.raw`\btdd\b`,
    String.raw`\btesting\b`,
    String.raw`\bintegration test`,
    String.raw`\bqa\b`,
  ],
  playwright: [String.raw`\bplaywright\b`, String.raw`\bselenium\b`, String.raw`\bbrowser automation\b`],
  automation: [String.raw`\bautomat(?:e|ion|ing)\b`, String.raw`\bscripting\b`],
  agile: [String.raw`\bagile\b`, String.raw`\bscrum\b`, String.raw`\bsprint`, String.raw`\bkanban\b`],
  oauth: [String.raw`\boauth\b`, String.raw`\bauthentication\b`, String.raw`\bsso\b`],
  security: [String.raw`\bsecurity\b`, String.raw`\bsecure\b`, String.raw`\bvulnerabilit`],
  compilers: [
    String.raw`\bcompilers?\b`,
    String.raw`\bllvm\b`,
    String.raw`\bstatic analysis\b`,
    String.raw`\bprogram analysis\b`,
  ],
  "chrome extensions": [String.raw`\bchrome extension`, String.raw`\bbrowser extension`],
  mobile: [String.raw`\bandroid\b`, String.raw`\bios\b`, String.raw`\bmobile\b`],
  "data visualization": [String.raw`\bvisualization\b`, String.raw`\bdashboards?\b`],
  "model serving": [
    String.raw`\bmodel serving\b`,
    String.raw`\binference\b`,
    String.raw`\bml ops\b`,
    String.raw`\bmlops\b`,
    String.raw`\bmodel deploy`,
  ],
};

// Compiled once: skill -> global, case-insensitive regexes.
const COMPILED: Map<string, RegExp[]> = new Map(
  Object.entries(LEXICON).map(([skill, pats]) => [
    skill,
    pats.map((p) => new RegExp(p, "gi")),
  ]),
);

// multipliers inside requirements blocks, and repeated-mention saturation
const REQ_WEIGHT = 2;
const MENTION_CAP = 3;

const REQ_HEADER =
  /(requirements?|qualifications?|must[- ]haves?|what you.{0,3}ll need|what we.{0,3}re looking for|who you are|skills?\s*:|nice to have|preferred|minimum|basic qualifications)/i;

/** A JD, analyzed into canonical-skill weights (port of jd.py.JDProfile). */
export type JDProfile = {
  text: string;
  weights: Record<string, number>;
};

/** Does `text` mention `skill` by any alias? (port of jd.py.matches). */
export function matches(skill: string, text: string): boolean {
  for (const re of COMPILED.get(skill) ?? []) {
    re.lastIndex = 0;
    const hit = re.test(text);
    re.lastIndex = 0;
    if (hit) return true;
  }
  return false;
}

function countMatches(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

/** Split into blank-line blocks, flagging requirement blocks (jd.py._blocks). */
function blocks(text: string): { block: string; isReq: boolean }[] {
  const raw = text.split(/\n\s*\n/).filter((b) => b.trim());
  const out: { block: string; isReq: boolean }[] = [];
  let carry = false;
  for (const b of raw) {
    const isReq = REQ_HEADER.test(b.split("\n", 1)[0]) || carry;
    carry = REQ_HEADER.test(b) && b.length < 600;
    out.push({ block: b, isReq });
  }
  return out;
}

/**
 * Extract canonical-skill weights from raw JD text (port of jd.py.analyze).
 * Mentions inside requirements blocks count double; repeated mentions
 * saturate at MENTION_CAP. Skills with no mention are absent.
 */
export function analyze(jdText: string): JDProfile {
  const weights: Record<string, number> = {};
  const blks = blocks(jdText);
  for (const [skill, pats] of COMPILED) {
    let plain = 0;
    let req = 0;
    for (const { block, isReq } of blks) {
      const n = pats.reduce((acc, re) => acc + countMatches(block, re), 0);
      if (isReq) req += n;
      else plain += n;
    }
    if (plain + req === 0) continue;
    weights[skill] =
      Math.min(plain, MENTION_CAP) + REQ_WEIGHT * Math.min(req, MENTION_CAP);
  }
  return { text: jdText, weights };
}

// --- project scoring (port of select.py) ------------------------------------

export type Searchable = { tags: string; tech: string; text: string };

/** The three searchable strings for a project: tags, tech, prose (select.py._searchable). */
export function searchable(entry: Entry): Searchable {
  const tags = (entry.tags ?? []).join(" ");
  const tech = (entry.tech ?? []).join(" ");
  const text = Object.values(entry.bullets)
    .flat()
    .join(" ");
  return { tags, tech, text };
}

/**
 * Weighted overlap score of a project against the JD (select.py.score_project).
 * For each JD skill: W_TAG if it appears in tags, else W_TECH in tech, else
 * W_TEXT in bullet prose; contributes weight * strength.
 */
export function scoreProject(entry: Entry, jd: JDProfile): number {
  const { tags, tech, text } = searchable(entry);
  let total = 0;
  for (const [skill, weight] of Object.entries(jd.weights)) {
    let strength: number;
    if (matches(skill, tags)) strength = W_TAG;
    else if (matches(skill, tech)) strength = W_TECH;
    else if (matches(skill, text)) strength = W_TEXT;
    else continue;
    total += weight * strength;
  }
  return total;
}

/**
 * The bullet variant whose text hits the most JD weight; ties go to "base"
 * (select.py.pick_variant).
 */
export function pickVariant(entry: Entry, jd: JDProfile): string {
  const variantScore = (name: string): number => {
    const text = (entry.bullets[name] ?? []).join(" ");
    let sum = 0;
    for (const [skill, weight] of Object.entries(jd.weights)) {
      if (matches(skill, text)) sum += weight;
    }
    return sum;
  };
  // "base" sorts first so ties resolve to it; otherwise dict insertion order.
  const keys = Object.keys(entry.bullets).sort(
    (a, b) => (a === "base" ? 0 : 1) - (b === "base" ? 0 : 1),
  );
  let best = keys[0] ?? "base";
  let bestScore = variantScore(best);
  for (const k of keys.slice(1)) {
    const s = variantScore(k);
    if (s > bestScore) {
      best = k;
      bestScore = s;
    }
  }
  return best;
}

// --- selection (port of select.py build_plan's project part) ---------------

export type SelectResult = {
  selected: [string, Entry][];
  scores: Record<string, number>;
};

/**
 * Score every bank project against the JD, then pick the subset that should
 * surface: highest scoring first (score desc, bank order tiebreak), capped at
 * MAX_PROJECTS. Exact parity with build_plan's `chosen = scored[:max_projects]`:
 * the resume always fills up to MAX_PROJECTS, so zero-score projects pad the
 * tail in bank order rather than leaving the page short (MIN_PROJECTS is kept
 * for lockstep with the Python constants but, as there, unused by selection).
 * The `scores` map reports every project's score (including unpicked ones)
 * for the build report.
 */
export function selectProjects(profile: ProfileV2, jdText: string): SelectResult {
  const jd = analyze(jdText);
  const entries = projectEntries(profile);

  const scores: Record<string, number> = {};
  for (const e of entries) scores[e.heading] = scoreProject(e, jd);

  // score desc, then bank order (the entry index) - zero-score projects sort
  // after scored ones and inherit bank order among themselves, which is
  // exactly the pad rule.
  const indexed = entries.map((e, i) => [e, i] as const);
  const chosen = [...indexed]
    .sort((a, b) => scores[b[0].heading] - scores[a[0].heading] || a[1] - b[1])
    .slice(0, MAX_PROJECTS);

  const selected: [string, Entry][] = chosen.map(([e]) => [e.heading, e]);
  return { selected, scores };
}
