"""Company / location / URL cleanup and term inference."""

from __future__ import annotations

import datetime as dt
import html as html_mod
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

# ------------------------------------------------------------------- html

_SCRIPT_STYLE_RE = re.compile(
    r"<(script|style|noscript)\b[^>]*>.*?</\1>", re.S | re.I)
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
    text = _TAG_RE.sub(" ", text)
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


def normalize_url(url: str) -> str:
    """Canonical form for dedup: lowercase scheme+host, drop tracking params,
    sort the remaining params (job-id params like gh_jid survive *unless* the
    value already appears in the path -- greenhouse links the same posting
    both ways), strip locale path prefixes (Workday /en-US/), trailing slash,
    and fragment."""
    parts = urlsplit(url.strip())
    path = _LOCALE_SEG_RE.sub("", parts.path).rstrip("/")
    path_segments = set(path.lower().split("/"))
    kept = sorted((k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
                  if not k.lower().startswith("utm_")
                  and k.lower() not in _TRACKING_KEYS
                  and v.lower() not in path_segments)
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), path,
                       urlencode(kept), ""))


_JR_ID_RE = re.compile(r"\bjr_id=([0-9a-f]{24})\b", re.I)
_JOBRIGHT_URL_RE = re.compile(r"jobright\.ai/jobs/info/([0-9a-f]{24})", re.I)


def extract_jobright_id(url: str) -> str | None:
    m = _JOBRIGHT_URL_RE.search(url) or _JR_ID_RE.search(url)
    return m.group(1).lower() if m else None


# ---------------------------------------------------------------- terms

_SEASONS = {"summer": "Summer", "fall": "Fall", "autumn": "Fall",
            "spring": "Spring", "winter": "Winter"}

# "Fall 2026", "Fall '26", "Summer of 2027", "fall2026"
_EXPLICIT_RE = re.compile(
    r"\b(summer|fall|autumn|spring|winter)\s*(?:of\s+)?[‘’']?\s*(?:20)?(2[4-9])\b",
    re.I)
# year-before-season: "2026 Summer", "2027 Spring Intern"
_EXPLICIT_REV_RE = re.compile(
    r"\b20(2[4-9])\s+(summer|fall|autumn|spring|winter)\b", re.I)

_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}
_MONTH_YEAR_RE = re.compile(
    r"\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|"
    r"aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
    r"\.?\s*[‘’']?\s*(?:20)?(2[4-9])\b", re.I)

# season with no year: "Fall Intern", "Fall Co-op"
_SEASON_ONLY_RE = re.compile(r"\b(summer|fall|autumn|spring|winter)\b", re.I)

# bare year next to intern-ish words: "2027 Software Engineer Intern".
# Industry convention: a bare year on an internship means that year's Summer.
_BARE_YEAR_RE = re.compile(r"\b20(2[4-9])\b")


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


def infer_terms(title: str, today: dt.date) -> tuple[list[str], str]:
    """Regex term inference from a job title.

    Returns (terms, confidence). Priority per spec:
    explicit season+year > month+year / season-only / bare-year (inferred) > unknown.
    """
    explicit = []
    for m in _EXPLICIT_RE.finditer(title):
        explicit.append(f"{_SEASONS[m.group(1).lower()]} 20{m.group(2)}")
    for m in _EXPLICIT_REV_RE.finditer(title):
        explicit.append(f"{_SEASONS[m.group(2).lower()]} 20{m.group(1)}")
    if explicit:
        return sorted(set(explicit)), "explicit"

    inferred = []
    for m in _MONTH_YEAR_RE.finditer(title):
        month = _MONTHS[m.group(1).lower()[:3]]
        inferred.append(f"{_month_to_season(month)} 20{m.group(2)}")
    if inferred:
        return sorted(set(inferred)), "inferred"

    m = _SEASON_ONLY_RE.search(title)
    if m:
        season = _SEASONS[m.group(1).lower()]
        return [f"{season} {_next_occurrence(season, today)}"], "inferred"

    m = _BARE_YEAR_RE.search(title)
    if m:
        return [f"Summer 20{m.group(1)}"], "inferred"

    return [], "unknown"


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
