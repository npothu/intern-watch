"""Company / location / URL cleanup and term inference."""

from __future__ import annotations

import datetime as dt
import html as html_mod
import re
from dataclasses import dataclass
from typing import Literal
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from . import terms as terms_mod
from .models import TermConfidence

# ------------------------------------------------------------------- html

_SCRIPT_STYLE_RE = re.compile(
    r"<(script|style|noscript|svg)\b[^>]*>.*?</\1>", re.S | re.I)
_TAG_RE = re.compile(r"<[^>]+>")


def strip_html(text: str) -> str:
    """HTML (possibly entity-escaped, e.g. Greenhouse `content`) -> plain
    text with collapsed whitespace. <script>/<style>/<noscript> element
    CONTENT is dropped (not just their tags) before the general tag strip,
    so embedded JS/CSS -- e.g. a Next.js hydration payload -- never leaks
    into the result."""
    text = html_mod.unescape(text)
    if re.search(r"&(?:#\d+|#x[0-9a-f]+|[a-z]+);", text, re.I):
        text = html_mod.unescape(text)      # double-escaped payloads
    text = _SCRIPT_STYLE_RE.sub(" ", text)
    # A truncated fetch can cut the page mid-element: an unclosed script/
    # style/noscript/svg (or a tag cut mid-attribute) never matches the
    # paired/tag regexes, so its payload leaks into the text
    # (jd_acquire.ts twin). Unclosed means truncated: drop to end-of-text.
    text = re.sub(r"<(?:script|style|noscript|svg)\b.*$", " ", text,
                  flags=re.I | re.S)
    text = _TAG_RE.sub(" ", text)
    text = re.sub(r"<[^>]*$", " ", text)
    return _WS_RE.sub(" ", text).strip()

# ---------------------------------------------------------------- companies

_COMPANY_SUFFIXES = {
    "inc", "incorporated", "llc", "llp", "ltd", "limited", "corp",
    "corporation", "co", "company", "plc", "gmbh", "sa", "ag", "nv",
}
_PUNCT_RE = re.compile(r"[.,()'’\"!]+")
_WS_RE = re.compile(r"\s+")


def norm_company(name: str) -> str:
    """Casefold, drop punctuation and trailing corporate suffixes."""
    s = _PUNCT_RE.sub(" ", name.casefold().replace("&", " and "))
    tokens = _WS_RE.sub(" ", s).strip().split(" ")
    while len(tokens) > 1 and tokens[-1] in _COMPANY_SUFFIXES:
        tokens.pop()
    return " ".join(tokens)


# Title tokens that don't distinguish one posting from another: the season/year
# term (a separate dedup dimension) and bare years.
_TERM_TOKEN_RE = re.compile(
    r"\b(?:summer|fall|autumn|spring|winter)\b"
    r"(?:\s*(?:of\s+)?[‘’'`]?\s*(?:20)?\d{2})?"
    r"|\b20\d{2}\b", re.I)
_TITLE_NONWORD_RE = re.compile(r"[^\w\s]+")


def norm_title(title: str) -> str:
    """Dedup-stable title: casefold, drop season/year term tokens and
    punctuation, collapse whitespace. 'Developer Intern, Open Source- Fall
    2026' and 'Developer Intern Open Source (Fall 2026)' both reduce to
    'developer intern open source'. Term is keyed separately, so stripping it
    here is safe and lets the same role across terms share a normalized title."""
    s = _TERM_TOKEN_RE.sub(" ", title.casefold().replace("&", " and "))
    s = _TITLE_NONWORD_RE.sub(" ", s)
    return _WS_RE.sub(" ", s).strip()


# ---------------------------------------------------------------- locations

_LOC_SPLIT_RE = re.compile(
    r"\s*(?:<\s*/?\s*[bB][rR]\s*/?\s*>|;|•|\|)\s*"  # html breaks & list separators
    r"|\s+or\s+"                                     # lowercase only: 'OR' is a state
    r"|\s*/\s*")
# Some sources concatenate multi-locations with no separator:
# "Atlanta, Georgia, United States Boston, ..." / "Boston, MA New York, NY"
_RUNON_RE = re.compile(r"(?<=United States)\s+(?=[A-Z])"
                       r"|(?<=,\s[A-Z]{2})\s+(?=[A-Z])")


def split_locations(raw: str) -> list[str]:
    if not raw:
        return []
    parts: list[str] = []
    for chunk in _RUNON_RE.split(raw):
        for p in _LOC_SPLIT_RE.split(chunk):
            p = _WS_RE.sub(" ", p).strip(" ,")
            if p:
                parts.append(p)
    # de-dup, preserve order
    seen: set[str] = set()
    out = []
    for p in parts:
        k = p.casefold()
        if k not in seen:
            seen.add(k)
            out.append(p)
    return out


# ---------------------------------------------------------------- URLs

_TRACKING_KEYS = {"jr_id", "utm", "ref", "source", "src", "lang", "mode",
                  "iis", "s", "gh_src", "lever-source", "gh_jid_src"}


def _clean_query(query: str) -> str:
    kept = [(k, v) for k, v in parse_qsl(query, keep_blank_values=True)
            if not k.lower().startswith("utm_") and k.lower() not in _TRACKING_KEYS]
    return urlencode(kept)


def strip_tracking(url: str) -> str:
    """Remove utm_*/jr_id/etc. params. Keeps everything else (display form)."""
    parts = urlsplit(url.strip())
    return urlunsplit((parts.scheme, parts.netloc, parts.path,
                       _clean_query(parts.query), ""))


_LOCALE_SEG_RE = re.compile(r"^/[a-z]{2}[-_][a-z]{2}(?=/)", re.I)


def _sorted_kept_query(path: str, query: str) -> str:
    """Tracking-stripped, path-echo-dropped, sorted query string. Shared by
    normalize_url and canonical_url so both treat query params identically."""
    path_segments = set(path.lower().split("/"))
    kept = sorted((k, v) for k, v in parse_qsl(query, keep_blank_values=True)
                  if not k.lower().startswith("utm_")
                  and k.lower() not in _TRACKING_KEYS
                  and v.lower() not in path_segments)
    return urlencode(kept)


def normalize_url(url: str) -> str:
    """Canonical form for dedup: lowercase scheme+host, drop tracking params,
    sort the remaining params (job-id params like gh_jid survive *unless* the
    value already appears in the path -- greenhouse links the same posting
    both ways), strip locale path prefixes (Workday /en-US/), trailing slash,
    and fragment."""
    parts = urlsplit(url.strip())
    path = _LOCALE_SEG_RE.sub("", parts.path).rstrip("/")
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path,
                       _sorted_kept_query(path, parts.query), ""))


_UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
_GH_HOSTS = {"boards.greenhouse.io", "job-boards.greenhouse.io",
             "boards.eu.greenhouse.io", "job-boards.eu.greenhouse.io"}
_GH_API_HOSTS = {"boards-api.greenhouse.io", "boards-api.eu.greenhouse.io"}
_GH_PATH_ID_RE = re.compile(r"/jobs/(\d+)")
_GH_CUSTOM_ID_RE = re.compile(r"/jobs/(\d{7,})-[\w-]+/?$")
_LEVER_HOSTS = {"jobs.lever.co", "jobs.eu.lever.co"}
_LEVER_PATH_RE = re.compile(
    r"^/([^/]+)/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
    re.I)
# Workday reqids ride on the job slug: .../Title_R17615 or
# .../Title_JR2026520976. The group captures the reqid after the underscore;
# repost counters (_JR2026520976-1) are dropped by requiring the match to end
# on the digit run, so reposts of one requisition share a token.
_WD_REQID_RE = re.compile(r"_(R[-\w]*\d{3,}|JR[-\w]*\d{3,})", re.I)
_WORKABLE_PATH_RE = re.compile(r"^/([^/]+)/j/([^/]+)")
# Bare /en/ style locales are NOT stripped by _LOCALE_SEG_RE (only xx-XX is),
# so this pattern carries its own optional two-letter locale segment.
_AMAZON_RE = re.compile(r"^(?:/[a-z]{2})?/jobs/(\d+)(?:/.*)?$", re.I)


def canonical_url(url: str) -> str | None:
    """Aggressive cross-source identity for the url_index ONLY -- never a
    dedup key. Collapses host/path variants of the same posting to one token:
    an `ats:<sys>:<id>` when a stable ATS job id is recognizable, else a
    hardened URL string (www./scheme normalized). Returns None for
    jobright.ai, non-http, or empty input (a jobright URL is never an
    identity -- the resolved employer URL is)."""
    if not url:
        return None
    parts = urlsplit(url.strip())
    if parts.scheme and parts.scheme.lower() not in ("http", "https"):
        return None
    host = parts.netloc.lower()
    if host.startswith("www."):
        host = host[4:]
    if not host:
        return None
    if host == "jobright.ai" or host.endswith(".jobright.ai"):
        return None
    path = _LOCALE_SEG_RE.sub("", parts.path).rstrip("/")

    if host in _GH_HOSTS | _GH_API_HOSTS:
        m = _GH_PATH_ID_RE.search(path)
        if m:
            return f"ats:gh:{m.group(1)}"
        if host in _GH_HOSTS and path == "/embed/job_app":
            for k, v in parse_qsl(parts.query):
                if k.lower() == "token" and v.isascii() and v.isdigit():
                    return f"ats:gh:{v}"
    for k, v in parse_qsl(parts.query, keep_blank_values=True):
        if k.lower() == "gh_jid" and v.isdigit():
            return f"ats:gh:{v}"
    m = _GH_CUSTOM_ID_RE.search(path)
    if m:
        return f"ats:gh:{m.group(1)}"
    if host in _LEVER_HOSTS:
        m = _LEVER_PATH_RE.match(path)
        if m:
            return f"ats:lever:{m.group(1).lower()}:{m.group(2).lower()}"
    if host == "jobs.ashbyhq.com":
        m = _UUID_RE.search(path)
        if m:
            return f"ats:ashby:{m.group(0).lower()}"

    # Workday careers sites (tenant.wdN.myworkdayjobs.com). The reqid is the
    # suffix after the final underscore of the job slug, which collapses the
    # .../details/<slug> and .../job/<location>/<slug> forms plus any career
    # site segment (INTERN, EXTERNAL_CAREERS). Hosts like *.myworkdaysite.com
    # must fall through to the fallback: there the tenant is not the first
    # host label, and a wrong tenant would merge two different companies.
    if host.endswith(".myworkdayjobs.com"):
        m = _WD_REQID_RE.search(path.rsplit("/", 1)[-1])
        if m:
            tenant = host.split(".", 1)[0]
            return f"ats:wd:{tenant}:{m.group(1).upper()}"
    if host == "apply.workable.com":
        m = _WORKABLE_PATH_RE.match(path)
        if m:
            return f"ats:workable:{m.group(1).lower()}:{m.group(2).upper()}"
    if host == "amazon.jobs":
        m = _AMAZON_RE.match(path)
        if m:
            return f"ats:amazon:{m.group(1)}"
    # Ashby embedded postings: ashby_jid=<uuid> on any host, same token shape
    # as the jobs.ashbyhq.com rule so the two join.
    for k, v in parse_qsl(parts.query, keep_blank_values=True):
        if k.lower() == "ashby_jid":
            m = _UUID_RE.search(v)
            if m:
                return f"ats:ashby:{m.group(0).lower()}"

    query = _sorted_kept_query(path, parts.query)
    return urlunsplit(("https", host, path, query, ""))


def apply_url_rank(url: str) -> int:
    """Prefer a hosted ATS application over its careers page or aggregator.

    This ranks URLs only after their posting identity has been established.
    It never guesses a destination from a company name or a similar title.
    """
    canon = canonical_url(url)
    if canon is None:
        return 0
    parts = urlsplit(url)
    host = (parts.hostname or "").lower().removeprefix("www.")
    path = parts.path.rstrip("/")
    if host in _GH_API_HOSTS:
        return 0  # a content API is not an application page
    if (host in _GH_HOSTS | _LEVER_HOSTS
            or host in {"jobs.ashbyhq.com", "apply.workable.com"}
            or host.endswith(".myworkdayjobs.com")):
        if path == "/embed/job_app" or path.endswith(("/apply", "/application")):
            return 3
        return 2
    return 1


def preferred_apply_url(*urls: str) -> str:
    """Best observed application link; ties keep the existing URL."""
    return max(urls, key=apply_url_rank, default="")


_JR_ID_RE = re.compile(r"\bjr_id=([0-9a-f]{24})\b", re.I)
_JOBRIGHT_URL_RE = re.compile(r"jobright\.ai/jobs/info/([0-9a-f]{24})", re.I)


def extract_jobright_id(url: str) -> str | None:
    m = _JOBRIGHT_URL_RE.search(url) or _JR_ID_RE.search(url)
    return m.group(1).lower() if m else None


# ---------------------------------------------------------------- terms
#
# Term inference spec. convex/ingest_extract.ts (inferTermDetailed) mirrors
# this function rule for rule; both suites run the shared vectors in
# shared/term-inference-cases.json, so change the two together.
#
# Tiers, first hit wins:
#   1. explicit -- a season next to a year ("Summer 2027", "Summer '27",
#      "2027 Summer", "fall-2026" in a URL slug), checked in the title, then
#      the URL, then the JD body.
#   2. inferred -- title: month+year, season with no year, bare year (the
#      long-standing title rules); then JD body: dates that describe the
#      placement -- start statements ("starts in June 2027") and spans
#      ("runs May-August 2027", "Jan-Jun 2027") -- which must all agree;
#      failing that, one yearless season next to an internship noun
#      ("12-week summer internship", "Fall co-op", "Spring semester"), its
#      year taken from the anchor date.
#   3. unknown.
# Governing rule for the JD body: when in doubt, unknown. In the watcher a
# wrong JD term is a permanent term-not-wanted rejection, while unknown
# just sends the job to the LLM. So conflicting dates, season lists,
# year-round programs, application windows, perks, past cohorts and a
# yearless season read inside its own window (Summer in Apr-Aug) all give
# unknown.
# JD clauses must be about the role or its dates (intern, co-op, program,
# start, dates, ...); clauses about graduation, enrollment, returning to
# school, fiscal years, deadlines, eligibility ("rising junior as of Fall
# 2027"), recruiting, offers/conversion and past-tense history are skipped:
# "graduating Spring 2028" is not the internship's term. Any JD term that
# has already started by the anchor is a past cohort and is ignored. An
# explicit JD term that the JD's placement dates contradict, or a start
# clause offering several months, gives unknown. A JD year must be four
# digits or apostrophe'd; lowercase "may" is a verb.

# ASCII semantics for \b \s \d and case folding, so these patterns behave
# exactly like the TS mirror's (JS regexes without the u flag). Input runs
# through _ascii_space first: JS \s also covers NBSP, BOM and friends.
_RX = re.I | re.A
_SPACE_RE = re.compile("[\t\v\f \u00a0\u1680\u2000-\u200a\u2028\u2029"
                       "\u202f\u205f\u3000\ufeff\x1c-\x1f\x85]")


def _ascii_space(text: str) -> str:
    return _SPACE_RE.sub(" ", text)


_SEASONS = {"summer": "Summer", "fall": "Fall", "autumn": "Fall",
            "spring": "Spring", "winter": "Winter"}
_SEASON_ALT = "summer|fall|autumn|spring|winter"
_YY = "2[4-9]"  # same 2024-2029 window as before; widen with care ("spring 30 days")

# "Fall 2026", "Fall '26", "Summer of 2027", "fall2026", "summer-2027",
# "intern_fall_2027" (lookarounds, not \b: "_" is a word character),
# "Spring/Summer 2027" (every slashed season)
_SEASON_LIST = rf"(?:{_SEASON_ALT})(?:\s*/\s*(?:{_SEASON_ALT}))*"
_EXPLICIT_RE = re.compile(
    rf"(?<![a-z])({_SEASON_LIST})[\s_-]*(?:of\s+)?[‘’']?\s*(?:20)?({_YY})(?!\d)",
    _RX)
# JD prose is noisier than a title ("prices fall 27%"): the year must be
# four digits or apostrophe'd there.
_JD_EXPLICIT_RE = re.compile(
    rf"(?<![a-z])({_SEASON_LIST})[\s_-]*(?:of\s+)?(?:20|[‘’']\s*)({_YY})(?!\d)",
    _RX)
# year-before-season: "2026 Summer", "2027 Spring Intern", "2027-summer"
_EXPLICIT_REV_RE = re.compile(
    rf"(?<!\d)20({_YY})[\s_-]+({_SEASON_ALT})(?![a-z])", _RX)

_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}
_MONTH_ALT = (r"jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|"
              r"july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|"
              r"dec(?:ember)?")
# title: "Sept 2026", "January 2027 Start"
_MONTH_YEAR_RE = re.compile(
    rf"\b({_MONTH_ALT})\.?\s*[‘’']?\s*(?:20)?({_YY})\b", _RX)

# season with no year: "Fall Intern", "Fall Co-op"
_SEASON_ONLY_RE = re.compile(rf"\b({_SEASON_ALT})\b", _RX)

# bare year next to intern-ish words: "2027 Software Engineer Intern".
# Industry convention: a bare year on an internship means that year's Summer.
_BARE_YEAR_RE = re.compile(rf"\b20({_YY})\b", re.A)

# --- JD body rules. Years must be 4-digit or apostrophe'd: in "May 18 -
# Aug 27" the 27 is a day.
_JD_YEAR = rf"(?:20|[‘’'])({_YY})"
_DAY = r"(?:\s+\d{1,2}(?:st|nd|rd|th)?)?"
_JD_RANGE_RE = re.compile(
    rf"\b({_MONTH_ALT})\b\.?{_DAY},?(?:\s*{_JD_YEAR})?"
    rf"\s*(?:-|–|—|to|through|thru|until)\s*"
    rf"({_MONTH_ALT})\b\.?{_DAY},?\s*{_JD_YEAR}\b", _RX)
_JD_MONTH_YEAR_RE = re.compile(
    rf"\b({_MONTH_ALT})\b\.?{_DAY},?\s*{_JD_YEAR}\b", _RX)
_JD_START_RE = re.compile(r"\b(?:start|starts|starting|begin|begins|beginning|"
                          r"commence|commences|commencing|start date)\b", _RX)
_JD_SEASON_NOUN_RE = re.compile(
    rf"\b({_SEASON_ALT})\s+(?:intern(?:ship)?s?|co-?ops?|semester|term|"
    rf"session|program(?:me)?|cohort|placement)\b", _RX)
_JD_SKIP_RE = re.compile(
    r"graduat|class of|commencement|diploma|returning to|"
    r"return to (?:school|campus|university|college)|deadline|apply by|"
    r"applications? (?:close|due|open)|date posted|posted on|last updated|"
    r"on track to|(?:complet|finish)\w*\s+(?:\S+\s+){0,3}?"
    r"(?:bachelor|master|ph\.?d|doctora|undergrad|degree)|enroll|fiscal|"
    # application windows and perks are dates, not the placement
    r"accepting applications|applications? (?:are |will be )?(?:accepted|"
    r"reviewed)|application (?:window|period)|apply (?:before|between|from|"
    r"until)|benefit|interview|onboarding|orientation|"
    # eligibility, recruiting and conversion: "rising junior as of Fall
    # 2027", "recruiting begins in September", "return offers for roles
    # starting in Summer 2028", "our Fall 2027 extension program"
    r"rising|as of|continu\w* (?:their |your |his |her )?(?:studies|"
    r"education|degree)|eligib|full[- ]time (?:role|position|employment|"
    r"offer|opportunit|hire)|return offer|offers? (?:will|are|may|is)|"
    r"extension|recruit|reviewing applications|rolling basis|"
    # past tense describes an earlier cohort, not this posting
    r"\b(?:was|were|launched|built|shipped|ran|hosted|joined)\b", _RX)
# Every month name in a clause, for "start in January 2027 or June 2027" and
# "start between January and June 2027" (several options -> unknown).
_JD_MONTH_WORD_RE = re.compile(rf"\b({_MONTH_ALT})\b", _RX)
# "6-month co-op": a start date alone cannot say which later terms it spans.
_JD_LONG_DURATION_RE = re.compile(
    r"\b(?:[5-9]|1[0-2]|five|six|seven|eight|nine|ten|eleven|twelve)"
    r"[\s-]*months?\b", _RX)
# A month range counts only when the clause says it is the placement's span:
# "the internship runs May-August 2027", "co-op dates: Jan-Jun 2027".
_JD_SPAN_RE = re.compile(
    r"\b(?:runs?|running|from|starts?|starting|begins?|beginning|"
    r"duration|dates?|lasts?|between|join)\b", _RX)
# Yearless season evidence is ambiguous when a JD lists several seasons or
# says the program runs all year: "offers spring, summer and fall internships".
_JD_SEASON_LIST_RE = re.compile(
    rf"\b(?:{_SEASON_ALT})\s*(?:,|/|&|\band\b|\bor\b)\s*(?:{_SEASON_ALT})\b", _RX)
_JD_YEAR_ROUND_RE = re.compile(
    r"year[\s-]round|all year|throughout the year|multiple (?:terms|seasons)|"
    r"any (?:term|season)", _RX)
# Months when a yearless "<season> internship" could mean this year's or
# next year's: the month before the season starts through its end. The
# answer flips overnight there (May 31 -> Summer 2027, June 1 -> Summer
# 2028), so the rule returns unknown and the LLM decides.
_SEASON_AMBIGUOUS_MONTHS = {
    "Spring": {12, 1, 2, 3, 4}, "Summer": {4, 5, 6, 7, 8},
    "Fall": {7, 8, 9, 10, 11}, "Winter": {11, 12, 1, 2},
}
# A JD clause counts only when it is about the role or its dates: "our office
# renovation runs May-August 2027" or "tuition support during the Fall
# semester" say nothing about the internship.
_JD_CONTEXT_RE = re.compile(
    r"intern|co-?op|program|placement|position|\brole\b|cohort|\bstart|"
    r"\bbegin|commenc|duration|\bdates?\b", _RX)
# Split a JD into clauses: newlines/bullets, or sentence punctuation
# followed by a capital ("Aug. 7" stays whole).
_CLAUSE_SPLIT_RE = re.compile(r"(?<=[.!?;])\s+(?=[A-Z])|[\r\n•·]+", re.A)

TermSource = Literal["title", "url", "jd"]


@dataclass(frozen=True)
class TermInference:
    terms: list[str]                 # chronological
    confidence: TermConfidence
    source: TermSource | None

    @property
    def term(self) -> str:
        """The single term a one-term field (a hosted match row) stores:
        the earliest. Empty when unknown."""
        return self.terms[0] if self.terms else ""


def _month_to_season(month: int) -> str:
    if month in (1, 2, 3):
        return "Spring"
    if month in (4, 5, 6, 7):
        return "Summer"
    if month in (8, 9, 10, 11):
        return "Fall"
    return "Winter"


def _next_occurrence(season: str, today: dt.date) -> int:
    """Year of the next start of `season` on/after today."""
    start_month = {"Spring": 1, "Summer": 5, "Fall": 8, "Winter": 12}[season]
    return today.year if today.month <= start_month else today.year + 1


def _ordered(terms: list[str]) -> list[str]:
    return terms_mod.sort_terms(list(dict.fromkeys(terms)))


def _explicit(text: str, pattern: re.Pattern[str] = _EXPLICIT_RE) -> list[str]:
    found = [f"{_SEASONS[season.strip().lower()]} 20{m.group(2)}"
             for m in pattern.finditer(text) for season in m.group(1).split("/")]
    found += [f"{_SEASONS[m.group(2).lower()]} 20{m.group(1)}"
              for m in _EXPLICIT_REV_RE.finditer(text)]
    return found


def _title_inferred(title: str, today: dt.date) -> list[str]:
    found = [f"{_month_to_season(_MONTHS[m.group(1).lower()[:3]])} 20{m.group(2)}"
             for m in _MONTH_YEAR_RE.finditer(title)]
    if found:
        return found
    season_m = _SEASON_ONLY_RE.search(title)
    if season_m:
        season = _SEASONS[season_m.group(1).lower()]
        return [f"{season} {_next_occurrence(season, today)}"]
    year_m = _BARE_YEAR_RE.search(title)
    if year_m:
        return [f"Summer 20{year_m.group(1)}"]
    return []


def _range_seasons(m1: int, y1: int, m2: int, y2: int) -> list[str]:
    """Seasons a month range covers: the start month's season, plus every
    Jan-Apr / May-Aug / Sep-Dec block the range spends 2+ months in.
    May-Aug -> Summer; Jan-Jun -> Spring + Summer; Aug-Dec -> Fall."""
    out = [f"{_month_to_season(m1)} {y1}"]
    counts: dict[str, int] = {}
    month, year = m1, y1
    for _ in range(24):
        block = ("Spring", "Spring", "Spring", "Spring", "Summer", "Summer",
                 "Summer", "Summer", "Fall", "Fall", "Fall", "Fall")[month - 1]
        key = f"{block} {year}"
        counts[key] = counts.get(key, 0) + 1
        if (year, month) >= (y2, m2):
            break
        month, year = (1, year + 1) if month == 12 else (month + 1, year)
    out += [k for k, n in counts.items() if n >= 2]
    return out


def _jd_clauses(jd: str) -> list[str]:
    return [c for c in _CLAUSE_SPLIT_RE.split(jd)
            if c.strip() and _JD_CONTEXT_RE.search(c) and not _JD_SKIP_RE.search(c)]


def _not_past(terms: list[str], anchor: dt.date) -> bool:
    """False when the earliest term has already started by the anchor: "our
    Fall 2026 interns ..." read in November describes an earlier cohort, and
    a term under way is no longer something to apply for."""
    starts = [d for d in map(terms_mod.term_start, terms) if d is not None]
    return bool(starts) and min(starts) >= anchor


def _jd_explicit(clauses: list[str], anchor: dt.date) -> list[str]:
    found = [t for c in clauses for t in _explicit(c, _JD_EXPLICIT_RE)]
    return [t for t in found if _not_past([t], anchor)]


class _Conflict(Exception):
    """JD date evidence disagrees with itself: the answer is unknown."""


def _start_term(clause: str, anchor: dt.date) -> str | None:
    """The single start term a start clause names, None when it names none
    (or only a past one); raises _Conflict when it offers several months
    ("January 2027 or June 2027", "between January and June 2027")."""
    dated = [m for m in _JD_MONTH_YEAR_RE.finditer(clause) if m.group(1) != "may"]
    if not dated:
        return None
    months = [m for m in _JD_MONTH_WORD_RE.finditer(clause) if m.group(1) != "may"]
    terms = {f"{_month_to_season(_MONTHS[m.group(1).lower()[:3]])} 20{m.group(2)}"
             for m in dated}
    if len(months) > len(dated) or len(terms) > 1:
        raise _Conflict
    (term,) = terms
    return term if _not_past([term], anchor) else None


def _jd_dated(clauses: list[str], anchor: dt.date) -> list[str]:
    """Term(s) from dates that describe the placement: start statements
    ("starts in June 2027") and spans ("runs May-August 2027"). Past
    cohorts are dropped first. Every remaining piece of evidence must
    agree - start statements win, and each span must contain the start's
    term - or the answer is unknown. A start date alone on a 5+ month
    placement is unknown too: it cannot say which later terms it covers."""
    starts: set[str] = set()
    spans: list[list[str]] = []
    try:
        for c in clauses:
            r = _JD_RANGE_RE.search(c)
            if r and r.group(1) != "may" and _JD_SPAN_RE.search(c):  # "may": the verb
                m1 = _MONTHS[r.group(1).lower()[:3]]
                m2 = _MONTHS[r.group(3).lower()[:3]]
                y2 = 2000 + int(r.group(4))
                y1 = (2000 + int(r.group(2)) if r.group(2)
                      else y2 if m1 <= m2 else y2 - 1)
                if (y1, m1) <= (y2, m2):
                    span = _ordered(_range_seasons(m1, y1, m2, y2))
                    if _not_past(span, anchor):
                        spans.append(span)
                continue
            if _JD_START_RE.search(c):
                term = _start_term(c, anchor)
                if term:
                    starts.add(term)
    except _Conflict:
        return []
    if len(starts) > 1 or any(s != spans[0] for s in spans):
        return []
    if starts:
        (start,) = starts
        if spans:
            return spans[0] if start in spans[0] else []
        if any(_JD_LONG_DURATION_RE.search(c) for c in clauses):
            return []
        return [start]
    return spans[0] if spans else []


def _jd_season_only(clauses: list[str], anchor: dt.date) -> list[str]:
    """A yearless "<season> internship", its year from the anchor - unless
    the JD lists several seasons, says the program runs year-round, or the
    anchor sits where the year is a coin flip."""
    if any(_JD_SEASON_LIST_RE.search(c) or _JD_YEAR_ROUND_RE.search(c)
           for c in clauses):
        return []
    seasons = {_SEASONS[m.group(1).lower()]
               for c in clauses for m in _JD_SEASON_NOUN_RE.finditer(c)}
    if len(seasons) != 1:
        return []
    (season,) = seasons
    if anchor.month in _SEASON_AMBIGUOUS_MONTHS[season]:
        return []
    return [f"{season} {_next_occurrence(season, anchor)}"]


def _jd_inferred(clauses: list[str], anchor: dt.date) -> list[str]:
    return _jd_dated(clauses, anchor) or _jd_season_only(clauses, anchor)


def infer_term(title: str, url: str | None = None, jd: str | None = None,
               today: dt.date | None = None) -> TermInference:
    """Term(s) for a posting from its title, URL and JD body (see the spec
    above). `today` anchors the yearless rules and the past-cohort cutoff:
    the run date for a live posting (the watcher), the date a stored row was
    added (the hosted backfill)."""
    anchor = today or dt.date.today()
    title = _ascii_space(title or "")
    url = _ascii_space(url or "")
    clauses = _jd_clauses(_ascii_space(jd)) if jd else []
    jd_explicit = _jd_explicit(clauses, anchor)
    if jd_explicit:
        # An explicit JD term that the JD's own placement dates contradict
        # ("Fall 2027 ..." next to "starts in June 2027") is doubt: the JD
        # then contributes nothing.
        dated = _jd_dated(clauses, anchor)
        if dated and not set(dated) & set(jd_explicit):
            jd_explicit, clauses = [], []
    explicit_sources: list[tuple[TermSource, list[str]]] = [
        ("title", _explicit(title)),
        ("url", _explicit(url)),
        ("jd", jd_explicit),
    ]
    for source, found in explicit_sources:
        if found:
            return TermInference(_ordered(found), "explicit", source)
    inferred_sources: list[tuple[TermSource, list[str]]] = [
        ("title", _title_inferred(title, anchor)),
        ("jd", _jd_inferred(clauses, anchor)),
    ]
    for source, found in inferred_sources:
        if found:
            return TermInference(_ordered(found), "inferred", source)
    return TermInference([], "unknown", None)


def infer_terms(title: str, today: dt.date) -> tuple[list[str], TermConfidence]:
    """Title-only inference, the shape the source adapters use."""
    got = infer_term(title, today=today)
    return got.terms, got.confidence

# ------------------------------------------------------- "Mon DD" date parse

def parse_month_day(text: str, today: dt.date) -> dt.date | None:
    """'Jun 11' -> date, inferring year (handles Dec -> Jan rollover)."""
    m = re.match(r"\s*([A-Za-z]{3,9})\.?\s+(\d{1,2})\s*$", text or "")
    if not m:
        return None
    month = _MONTHS.get(m.group(1).lower()[:3])
    if not month:
        return None
    try:
        candidate = dt.date(today.year, month, int(m.group(2)))
    except ValueError:
        return None
    # A "future" post date means it was actually last year (Dec seen in Jan).
    if candidate > today + dt.timedelta(days=7):
        candidate = candidate.replace(year=today.year - 1)
    return candidate
