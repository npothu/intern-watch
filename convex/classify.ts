// Pure, dependency-free port of the reference implementation for classifying
// recruiter-reply emails and matching them to tracked applications.
//
// This module has NO Convex imports, NO ./_generated imports, and NO Node-only
// globals: it is a plain, side-effect-free TypeScript library that runs
// identically inside a Convex action and under vitest. All regexes and rules
// are literal ports of the authoritative Python sources so the two runtimes
// stay provably in lockstep (see tests/data/reply_vectors.json).

/** Whole-token whitespace collapse (src/normalize.py: `_WS_RE`). */
const WS_RE = /\s+/g;

// --------------------------------------------------------------------------
// classifyReply - port of src/apply/inbox.py `classify_reply`
// --------------------------------------------------------------------------

// src/apply/inbox.py `_REPLY_SIGNALS`. Every alternation is ported LITERALLY
// (each raw-prefixed alternative concatenated into one alternation), with /i
// only. Python's `.` does not match newline (no re.S), so we do NOT use /s:
// `.{0,40}` stays single-line in both languages. `(?:...)` groups port as-is.
const REPLY_SIGNALS: ReadonlyArray<{ signal: string; pattern: RegExp }> = [
  {
    signal: "rejected",
    pattern:
      /decided not to move forward|will not be moving forward|other candidates whose|mov(?:e|ing) forward with other candidates|unable to offer you|(?:this |the )?position has been filled|you (?:have|were) not (?:been )?selected|not to proceed with your application/i,
  },
  {
    signal: "offer",
    pattern:
      /pleased to offer|offer letter|extend (?:you )?an offer|excited to extend (?:you )?an offer/i,
  },
  {
    signal: "oa",
    pattern:
      /online assessment|coding challenge|hackerrank|codesignal|codility|take[- ]home (?:assignment|assessment|challenge|exercise|test)|complete your assessment|invitation to complete|complete (?:a|the|your) (?:online )?assessment/i,
  },
  {
    signal: "phone_screen",
    pattern:
      /phone screen|recruiter screen|screening call|(?:intro|initial) call with (?:a|our) recruiter/i,
  },
  {
    signal: "interview",
    pattern:
      /schedule your interview|schedule an interview|meet the team|invite you to (?:an? )?interview|(?:would like|like) to interview you|set up (?:a|an) (?:phone |video |call )?interview|interview.{0,40}(?:calendly\.com|schedule a time)|(?:calendly\.com|schedule a time).{0,40}interview/i,
  },
];

// src/apply/inbox.py `_REPLY_NEGATIVES`. Any hit forces a null (None) result.
const REPLY_NEGATIVES =
  /thank you for applying|thanks for applying|we(?:'ve| have) received your application|your application (?:has been|was) (?:received|submitted)|application received|intern[- ]watch|job alert|new jobs? (?:for you|matching)|jobs you may|unsubscribe from (?:these|job) (?:alerts|emails)|linkedin|indeed\.com|glassdoor|your (?:verification|security|login|one[- ]time) code|verification code|passcode|one[- ]time password/i;

/**
 * EXACT port of src/apply/inbox.py `classify_reply`.
 *
 * Joins as `${subject}\n${body}`; if any negative matches, returns null;
 * otherwise the FIRST signal pattern (in the same order: rejected, offer, oa,
 * phone_screen, interview) that matches returns {signal, evidence}, where
 * evidence is match[0]. Returns null when nothing confident matches.
 */
export function classifyReply(
  subject: string,
  body: string,
): { signal: string; evidence: string } | null {
  const text = `${subject || ""}\n${body || ""}`;
  if (REPLY_NEGATIVES.test(text)) {
    return null;
  }
  for (const { signal, pattern } of REPLY_SIGNALS) {
    const m = pattern.exec(text);
    if (m) {
      return { signal, evidence: m[0] };
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// normCompany - port of src/normalize.py `norm_company`
// --------------------------------------------------------------------------

// src/normalize.py `_COMPANY_SUFFIXES` (trailing corporate suffixes to pop).
const COMPANY_SUFFIXES = new Set([
  "inc", "incorporated", "llc", "llp", "ltd", "limited", "corp",
  "corporation", "co", "company", "plc", "gmbh", "sa", "ag", "nv",
]);

// src/normalize.py `_PUNCT_RE`: [.,()'’"!]+
const PUNCT_RE = /[.,()'’"!]+/g;

/**
 * Port of src/normalize.py `norm_company`.
 *
 * Casefold (toLowerCase), replace every "&" with " and ", strip the
 * punctuation class [.,()'’"!]+ (replaced with a space), collapse whitespace,
 * then pop trailing corporate-suffix tokens while more than one token remains.
 */
export function normCompany(name: string): string {
  let s = name.toLowerCase().replace(/&/g, " and ");
  s = s.replace(PUNCT_RE, " ");
  const tokens = s.replace(WS_RE, " ").trim().split(" ");
  while (tokens.length > 1 && COMPANY_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(" ");
}

// --------------------------------------------------------------------------
// normTitle - port of src/normalize.py `norm_title`
// --------------------------------------------------------------------------

// src/normalize.py `_TERM_TOKEN_RE`, literal incl. the curly-quote alternatives.
const TERM_TOKEN_RE =
  /\b(?:summer|fall|autumn|spring|winter)\b(?:\s*(?:of\s+)?[‘’'`]?\s*(?:20)?\d{2})?|\b20\d{2}\b/gi;

// src/normalize.py `_TITLE_NONWORD_RE`: [^\w\s]+
const TITLE_NONWORD_RE = /[^\w\s]+/g;

/**
 * Port of src/normalize.py `norm_title`.
 *
 * Casefold, replace "&" with " and ", remove season/year term tokens
 * (curly-quote aware), strip non-word characters, collapse whitespace.
 */
export function normTitle(title: string): string {
  let s = title.toLowerCase().replace(/&/g, " and ");
  s = s.replace(TERM_TOKEN_RE, " ");
  s = s.replace(TITLE_NONWORD_RE, " ");
  return s.replace(WS_RE, " ").trim();
}

// --------------------------------------------------------------------------
// stripHtml - port of src/normalize.py `strip_html`
// --------------------------------------------------------------------------

// src/normalize.py named-entity coverage (the subset that matters here) plus
// numeric decimal / hex forms. Python's html.unescape handles far more named
// entities; the required named set for our vectors is amp/lt/gt/quot/apos/nbsp.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function unescapeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (Number.isFinite(code)) {
        return String.fromCodePoint(code);
      }
      return match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

// src/normalize.py `_SCRIPT_STYLE_RE`: drops <script>/<style>/<noscript>
// ELEMENT CONTENT. Python uses re.S here, so JS uses [\s\S]*? to cross lines
// (this is the one place cross-line matching is intended).
const SCRIPT_STYLE_RE = /<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi;

// src/normalize.py `_TAG_RE`: <[^>]+>
const TAG_RE = /<[^>]+>/g;

// src/normalize.py checks for any remaining entity after the first unescape
// and, if present, unescapes a second time (double-escaped payloads).
const ANY_ENTITY_RE = /&(?:#\d+|#x[0-9a-f]+|[a-z]+);/i;

/**
 * Port of src/normalize.py `strip_html`.
 *
 * HTML (possibly entity-escaped) to plain text with collapsed whitespace.
 * Unescapes entities (named + numeric decimal/hex, applied twice when a second
 * pass still finds entities), drops <script>/<style>/<noscript> element CONTENT
 * (cross-line, mirroring Python's re.S for this one pattern), strips remaining
 * tags, then collapses whitespace.
 */
export function stripHtml(text: string): string {
  let s = unescapeHtml(text);
  if (ANY_ENTITY_RE.test(s)) {
    s = unescapeHtml(s);
  }
  s = s.replace(SCRIPT_STYLE_RE, " ");
  s = s.replace(TAG_RE, " ");
  return s.replace(WS_RE, " ").trim();
}

// --------------------------------------------------------------------------
// scoreCandidates - rank tracked applications as match candidates for an email
// --------------------------------------------------------------------------

// Generic ATS sender domains: the sender is the recruitment platform, not the
// employer, so the +3 sender-domain rule must fall back to fromName instead.
const GENERIC_ATS_DOMAINS = new Set([
  "greenhouse-mail.io",
  "us.greenhouse-mail.io",
  "greenhouse.io",
  "myworkday.com",
  "myworkdayjobs.com",
  "lever.co",
  "hire.lever.co",
  "ashbyhq.com",
  "icims.com",
  "smartrecruiters.com",
  "successfactors.com",
  "brassring.com",
  "taleo.net",
  "oraclecloud.com",
  "workablemail.com",
  "bamboohr.com",
]);

/** The part of fromAddr after the last "@" (lowercased). */
function senderDomain(fromAddr: string): string {
  const at = fromAddr.lastIndexOf("@");
  return (at === -1 ? fromAddr : fromAddr.slice(at + 1)).toLowerCase().trim();
}

/** Registrable base of a domain: the last two dot-separated labels. */
function registrableBase(domain: string): string {
  return domain.split(".").filter(Boolean).slice(-2).join(".");
}

/** The base name of a domain: registrable base minus its TLD label, e.g. "acme" from acme.com. */
function baseName(domain: string): string {
  const parts = registrableBase(domain).split(".").filter(Boolean);
  return parts.slice(0, -1).join(".");
}

/** Host of a url, lowercased, www. stripped, no scheme/port/path. */
function urlHost(url: string): string {
  return url
    .replace(/^[a-z]+:\/\//i, "")
    .split(/[/?#]/)[0]
    .toLowerCase()
    .replace(/^www\./, "");
}

/** Tokenize a string into lowercased, whitespace-separated tokens. */
function tokens(s: string): string[] {
  return s.replace(WS_RE, " ").trim().split(" ").filter(Boolean);
}

/**
 * Normalize free text the same way the company/title norms do (lowercase,
 * "&" -> " and ", punctuation stripped) so normalized needles can actually
 * match: normCompany("AT&T") is "at and t", which can never appear in a raw
 * lowercased subject. No term-token stripping here - the haystack must keep
 * every word.
 */
function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(TITLE_NONWORD_RE, " ")
    .replace(WS_RE, " ")
    .trim();
}

/** Exact-or-subdomain host match: "jobs.acme.com" matches "acme.com", "notacme.com" does not. */
function hostMatchesDomain(host: string, domain: string): boolean {
  return domain.length > 0 && (host === domain || host.endsWith("." + domain));
}

/** Whether `needle`'s whitespace tokens appear contiguously as a phrase in `haystack`. */
function phraseIn(needle: string, haystack: string): boolean {
  const hay = tokens(haystack);
  const nd = needle.split(" ").filter(Boolean);
  if (nd.length === 0 || hay.length === 0) {
    return false;
  }
  outer: for (let i = 0; i + nd.length <= hay.length; i++) {
    for (let j = 0; j < nd.length; j++) {
      if (hay[i + j] !== nd[j]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

/** Jaccard similarity of two token arrays. */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) {
    return 1;
  }
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) {
    if (sb.has(t)) {
      inter++;
    }
  }
  const union = new Set([...sa, ...sb]).size;
  return union === 0 ? 0 : inter / union;
}

/**
 * Port of the (Python-side) candidate-scoring logic for a recruiter-reply email.
 *
 * Sources: src/apply/inbox.py (classify_reply signal detection) and
 * src/normalize.py (norm_company / norm_title). Scoring per candidate:
 *   +3 sender-domain match (see below)
 *   +2 normCompany(company) as a whole-token phrase in the subject
 *   +1 normCompany(company) as a whole-token phrase in the body
 *   +1 title-token Jaccard(normTitle(title), subject+body tokens) >= 0.5
 * The +3 is awarded when the sender DOMAIN (part after @) or its registrable
 * base appears in the application's url host, OR the domain's base name equals
 * a whole token of normCompany(company). For GENERIC ATS sender domains the
 * domain identifies the platform, not the employer, so fromName is used
 * instead. Results are sorted by score desc then company asc, returning only
 * score > 0, capped at 5.
 */
export function scoreCandidates(
  email: { fromAddr: string; fromName: string; subject: string; body: string },
  apps: Array<{ short: string; company: string; title: string; url: string }>,
): Array<{ short: string; company: string; title: string; score: number }> {
  const domain = senderDomain(email.fromAddr);
  // ATS membership by exact domain OR registrable base, so a subdomain sender
  // (notifications@mail.myworkday.com) is still recognized as the platform -
  // otherwise its base domain would +3-match EVERY application on that ATS.
  const isAts =
    GENERIC_ATS_DOMAINS.has(domain) ||
    GENERIC_ATS_DOMAINS.has(registrableBase(domain));
  // Effective identity for the +3 rule: for generic ATS senders use the from
  // name (the employer brand); otherwise use the sender domain.
  const identity = isAts ? email.fromName.toLowerCase().trim() : domain;
  const identityBase = isAts ? tokens(identity)[0] ?? "" : baseName(identity);

  const subjectText = normText(email.subject);
  const bodyText = normText(email.body);
  const combinedTokens = tokens(`${subjectText} ${bodyText}`);

  const scored = apps.map((app) => {
    const company = normCompany(app.company);
    const companyTokens = tokens(company);
    const host = urlHost(app.url);

    let score = 0;

    // +3 sender identity match:
    //   - non-ATS: url host equals the sender domain (or its registrable
    //     base), or is a subdomain of it - never bare substring, which would
    //     let "acme.com" match "notacme.com".
    //   - either path: identity base name / ATS from-name brand word is a
    //     whole token of normCompany(company).
    const hostMatches =
      !isAts &&
      (hostMatchesDomain(host, identity) ||
        hostMatchesDomain(host, registrableBase(identity)));
    const brandMatches =
      identityBase.length > 0 && companyTokens.includes(identityBase);
    if (hostMatches || brandMatches) {
      score += 3;
    }

    // +2 whole-token phrase in subject, +1 in body.
    if (phraseIn(company, subjectText)) {
      score += 2;
    }
    if (phraseIn(company, bodyText)) {
      score += 1;
    }

    // +1 title-token Jaccard >= 0.5 against subject+body tokens.
    const titleTokens = tokens(normTitle(app.title));
    if (jaccard(titleTokens, combinedTokens) >= 0.5) {
      score += 1;
    }

    return { short: app.short, company: app.company, title: app.title, score };
  });

  return scored
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.company.localeCompare(b.company))
    .slice(0, 5);
}

// --------------------------------------------------------------------------
// decideTransition - forward-only status transition gate
// --------------------------------------------------------------------------

const STATUS_RANK: Record<string, number> = {
  applied: 0,
  oa: 1,
  phone_screen: 2,
  interview: 3,
  offer: 4,
};

const TERMINAL_STATUSES = new Set(["offer", "rejected", "withdrawn"]);

/**
 * Forward-only status transition rule.
 *
 * Order: applied(0) < oa(1) < phone_screen(2) < interview(3) < offer(4).
 * Terminal statuses are offer, rejected, withdrawn. null/undefined/"" current
 * (no record) -> "apply"; proposed === current -> "skip"; current terminal ->
 * "queue"; proposed "rejected" from any non-terminal -> "apply"; proposed rank
 * > current rank -> "apply"; otherwise (backward) -> "queue". "withdrawn" and
 * "applied" are never proposed by the classifier, but the function still
 * behaves: proposed "applied" -> "skip" if current applied, else "queue".
 */
export function decideTransition(
  current: string | null,
  proposed: string,
): "apply" | "skip" | "queue" {
  if (current == null || current === "") {
    return "apply";
  }
  if (proposed === current) {
    return "skip";
  }
  if (TERMINAL_STATUSES.has(current)) {
    return "queue";
  }
  if (proposed === "rejected") {
    return "apply";
  }
  const cur = STATUS_RANK[current] ?? -1;
  const prp = STATUS_RANK[proposed] ?? -1;
  if (prp > cur) {
    return "apply";
  }
  return "queue";
}
