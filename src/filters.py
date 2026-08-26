"""Deterministic per-user rule engine.

Pipeline position (cost-ordered): runs after dedupe/already-seen drop, before
the LLM. Emits accept / reject / ambiguous; ambiguous jobs (and only those)
are sent to llm.py, then re-evaluated here with `llm_facts` filled in.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

from . import terms as terms_mod
from .models import Job
from .normalize import norm_company

# --- Atlanta metro allowlist, ~35-mile radius (v1 stand-in for geocoded
# radius matching). Ambiguous names (Decatur IL/AL, Roswell NM, Duluth MN,
# Marietta OH, ...) additionally require a GA/Georgia hint in the string.
_METRO_UNAMBIGUOUS = {
    "atlanta", "alpharetta", "sandy springs", "johns creek",
    "peachtree corners", "peachtree city", "dunwoody", "norcross",
    "kennesaw", "suwanee", "chamblee", "doraville", "east point",
    "vinings", "buckhead", "stone mountain",
}
_METRO_AMBIGUOUS = {
    "decatur", "duluth", "marietta", "roswell", "smyrna", "college park",
    "lawrenceville", "tucker", "woodstock", "cumberland", "brookhaven",
    "acworth", "mableton",
}
_GA_HINT_RE = re.compile(r"\bga\b|georgia", re.I)


def in_atlanta_metro(location: str) -> bool:
    loc = location.casefold()
    if any(city in loc for city in _METRO_UNAMBIGUOUS):
        return True
    return bool(_GA_HINT_RE.search(loc) and any(city in loc for city in _METRO_AMBIGUOUS))


# --- Country detection for elimination rules. Conservative: a location we
# can't classify is "unknown" and never causes elimination on its own.
_US_HINTS = ("united states", "usa", "u.s.", "us-", "remote (us")
_US_STATE_ABBREV = [
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID",
    "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS",
    "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK",
    "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
    "WI", "WY", "DC",
]
_US_STATE_NAMES = (
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
    "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
    "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine",
    "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
    "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey",
    "new mexico", "new york", "north carolina", "north dakota", "ohio",
    "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina",
    "south dakota", "tennessee", "texas", "utah", "vermont", "virginia",
    "washington", "west virginia", "wisconsin", "wyoming")
_US_ABBREV_RE = re.compile(r"(?:,\s?|\b)(" + "|".join(_US_STATE_ABBREV) + r")\b")
_CA_HINTS = ("canada", "ontario", "quebec", "british columbia", "alberta",
             "manitoba", "saskatchewan", "nova scotia", "new brunswick",
             "newfoundland", "prince edward island", "yukon")
_CA_ABBREV_RE = re.compile(r",\s?(ON|QC|BC|AB|MB|SK|NS|NB|NL|PE|YT|NT|NU)\b")
_FOREIGN_HINTS = (
    "united kingdom", " uk", "uk ", "england", "scotland", "wales", "ireland",
    "germany", "france", "netherlands", "poland", "spain", "portugal", "italy",
    "sweden", "denmark", "norway", "finland", "switzerland", "austria",
    "belgium", "czech", "romania", "hungary", "greece", "estonia", "lithuania",
    "india", "china", "japan", "korea", "singapore", "taiwan", "hong kong",
    "vietnam", "philippines", "indonesia", "malaysia", "thailand", "australia",
    "new zealand", "israel", "united arab emirates", "dubai", "saudi",
    "qatar", "egypt", "turkey", "south africa", "nigeria", "kenya", "brazil",
    "mexico", "argentina", "chile", "colombia", "peru", "costa rica")


# Grad-student-only postings. "BS/MS" stays (BS-eligible); bare \bgraduate\b
# is safe because "Undergraduate" has no word boundary before "graduate".
_GRAD_ONLY_RE = re.compile(
    r"\bph\.?\s?d\b|\bdoctora(?:l|te)\b|\bmaster'?s\b|\bgraduate\b", re.I)
_UNDERGRAD_OK = ("bachelor", "associate")

# Roles demanding an ALREADY-HELD clearance. Plain "clearance"/"ability to
# obtain" is NOT matched -- the user can get cleared, just isn't yet.
# A title that bothers to say TS/SCI or polygraph wants cleared candidates.
_ACTIVE_CLEARANCE_RE = re.compile(
    r"ts/sci|top secret|polygraph|\bcleared\b|active (?:security |secret )?clearance",
    re.I)


# Military/veteran-only programs (SkillBridge requires active-duty status).
_VETERAN_ONLY_RE = re.compile(
    r"\bveterans?\b|skillbridge|active duty|military fellow", re.I)


# Job boards/aggregators jobright sometimes reports as the employer (e.g. a
# TikTok role listed with company "Dice"). The real employer is unknowable
# from the row, and a top-company verdict cached under the board's name would
# apply to every future posting from it, so drop these outright.
_AGGREGATOR_COMPANIES = {"dice"}


# --- JD-body variants. A description mentions degrees and clearances in
# passing far more often than a title does, so the title patterns above are
# too trigger-happy here. No veteran check on the body at all: "veteran
# status" appears in every US EEO boilerplate paragraph.

# Grad-only via JD: an MS/PhD mention with no undergraduate track mentioned
# anywhere. BS-friendly postings virtually always say bachelor's somewhere
# ("pursuing a Bachelor's or Master's...") which suppresses this. Bare
# \bgraduate\b is dropped (vs. the title regex): JDs say "recent graduates" /
# "graduate by 2027" without meaning grad-school-only.
_JD_GRAD_RE = re.compile(
    r"\bph\.?\s?d\b|\bdoctora(?:l|te)\b|\bmaster(?:'|’)?s\b"
    r"|\bm\.?s\.?/m\.?eng\b|\bms degree\b", re.I)
_JD_UNDERGRAD_RE = re.compile(
    r"bachelor|undergrad|\bb\.?s\.?\b|\bb\.?a\.?\b|\bbs/ms\b", re.I)

# Clearance via JD: classify each clearance mention by its local context.
# "ability to obtain TS/SCI" must stay (user can get cleared); "active
# TS/SCI required" must go. A mention with neither cue is kept (conservative,
# same philosophy as unknown locations).
_JD_CLEARANCE_RE = re.compile(
    r"ts/?\s?sci|top secret|polygraph|(?:security|secret) clearance", re.I)
_JD_OBTAINABLE_RE = re.compile(
    r"obtain|eligib|able to (?:get|receive|acquire)|willing", re.I)
_JD_ACTIVE_RE = re.compile(
    r"\bactive\b|\bcurrent(?:ly)?\b|must (?:hold|have|possess)"
    r"|hold(?:s|ing)?\b|possess", re.I)
_JD_CLEARANCE_WINDOW = 90  # chars of context on each side of a mention

# Unpaid via JD: deliberately narrow phrases -- "unpaid" alone could be
# "unpaid time off" in a benefits paragraph.
_JD_UNPAID_RE = re.compile(
    r"unpaid intern|internship is unpaid|this (?:position|role|internship) "
    r"is (?:an )?unpaid", re.I)


def jd_requires_active_clearance(description: str) -> bool:
    for m in _JD_CLEARANCE_RE.finditer(description):
        window = description[max(0, m.start() - _JD_CLEARANCE_WINDOW):
                             m.end() + _JD_CLEARANCE_WINDOW]
        if _JD_OBTAINABLE_RE.search(window):
            continue
        if _JD_ACTIVE_RE.search(window):
            return True
    return False


def jd_grad_only(description: str) -> bool:
    return bool(_JD_GRAD_RE.search(description)
                and not _JD_UNDERGRAD_RE.search(description))


def location_country(location: str) -> str:
    """'us' | 'canada' | 'other' | 'unknown'. US is checked first so the
    state of Georgia never reads as the country."""
    loc = location.casefold()
    padded = f" {loc} "
    if any(h in padded for h in _US_HINTS) or any(s in loc for s in _US_STATE_NAMES) \
            or _US_ABBREV_RE.search(location):
        return "us"
    if any(h in loc for h in _CA_HINTS) or _CA_ABBREV_RE.search(location):
        return "canada"
    if any(h in padded for h in _FOREIGN_HINTS):
        return "other"
    return "unknown"


_STATE_NAME_TO_ABBREV = {
    "alabama": "al", "alaska": "ak", "arizona": "az", "arkansas": "ar",
    "california": "ca", "colorado": "co", "connecticut": "ct", "delaware": "de",
    "florida": "fl", "georgia": "ga", "hawaii": "hi", "idaho": "id",
    "illinois": "il", "indiana": "in", "iowa": "ia", "kansas": "ks",
    "kentucky": "ky", "louisiana": "la", "maine": "me", "maryland": "md",
    "massachusetts": "ma", "michigan": "mi", "minnesota": "mn",
    "mississippi": "ms", "missouri": "mo", "montana": "mt", "nebraska": "ne",
    "nevada": "nv", "new hampshire": "nh", "new jersey": "nj",
    "new mexico": "nm", "new york": "ny", "north carolina": "nc",
    "north dakota": "nd", "ohio": "oh", "oklahoma": "ok", "oregon": "or",
    "pennsylvania": "pa", "rhode island": "ri", "south carolina": "sc",
    "south dakota": "sd", "tennessee": "tn", "texas": "tx", "utah": "ut",
    "vermont": "vt", "virginia": "va", "washington": "wa",
    "west virginia": "wv", "wisconsin": "wi", "wyoming": "wy",
}
_CA_PROV_NAME_TO_ABBREV = {
    "ontario": "on", "quebec": "qc", "british columbia": "bc", "alberta": "ab",
    "manitoba": "mb", "saskatchewan": "sk", "nova scotia": "ns",
    "new brunswick": "nb", "newfoundland": "nl", "prince edward island": "pe",
    "yukon": "yt",
}


def location_bucket(location: str) -> str:
    """Dedup-stable location at STATE/PROVINCE granularity. Same state -> same
    bucket (collapses the feed-/id-duplicate postings jobright emits for one
    job); different states stay distinct (so genuine per-state postings are
    kept). Country-only or remote locations bucket to the bare country, so
    formatting noise ('United States' vs 'Remote (US)') doesn't fork a posting.
    Abbrev is checked before the state-name scan so 'Indiana, PA' reads as PA,
    not IN. Returns e.g. 'us-ga' | 'us' | 'ca-on' | 'ca' | 'intl' | 'unknown'."""
    country = location_country(location)
    if country == "us":
        m = _US_ABBREV_RE.search(location)
        if m:
            return f"us-{m.group(1).lower()}"
        low = location.casefold()
        for name, ab in _STATE_NAME_TO_ABBREV.items():
            if name in low:
                return f"us-{ab}"
        return "us"
    if country == "canada":
        m = _CA_ABBREV_RE.search(location)
        if m:
            return f"ca-{m.group(1).lower()}"
        low = location.casefold()
        for name, ab in _CA_PROV_NAME_TO_ABBREV.items():
            if name in low:
                return f"ca-{ab}"
        return "ca"
    if country == "other":
        return "intl"
    return "unknown"


class CompanyList:
    """One company per line; '|' separates aliases; '#' starts a comment."""

    def __init__(self, path: Path):
        self.names: set[str] = set()
        # Each line's aliases as one group, so a name typed elsewhere (the
        # priority list) can be widened to its siblings: AWS -> Amazon.
        self._group_of: dict[str, frozenset[str]] = {}
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            group = frozenset(n for n in (norm_company(a) for a in line.split("|"))
                              if n)
            self.names |= group
            for n in group:
                self._group_of[n] = group

    def match(self, company: str) -> bool:
        return norm_company(company) in self.names

    def aliases(self, norm: str) -> frozenset[str]:
        """The alias group containing `norm` (normalized), or just itself."""
        return self._group_of.get(norm, frozenset({norm}))


# --- Per-season accept presets (`term_rules:` in the user yaml). Each preset
# expands to the same `accept_if_any` condition list the legacy `rules:`
# block spells out by hand, so the rule engine below stays one code path.
#   top_atl_remote  a priority or top company, an Atlanta-rooted company or
#                   location, or (when `location.remote_counts`) a remote role
#   priority_only   only the user's priority companies
#   anything        every job that passed the role filter and eliminations
PRESETS = ("top_atl_remote", "priority_only", "anything")
DEFAULT_PRESET = "anything"
_METRO_MATCHES = ["atlanta", "alpharetta", "sandy springs", "marietta"]
TOP_COMPANIES = "data/top_companies.txt"
ATLANTA_COMPANIES = "data/atlanta_companies.txt"


def preset_conds(preset: str, location_cfg: dict | None = None) -> list[dict]:
    if preset not in PRESETS:
        raise ValueError(f"unknown term rule preset {preset!r} "
                         f"(have: {', '.join(PRESETS)})")
    if preset == "anything":
        return [{"always": True}]
    if preset == "priority_only":
        return [{"priority": True}]
    remote = bool((location_cfg or {}).get("remote_counts", True))
    return [
        {"priority": True},
        {"company_in_file": TOP_COMPANIES},
        {"company_in_file": ATLANTA_COMPANIES},
        {"location_within": {"center": "Atlanta, GA", "radius_miles": 35}},
        {"location_matches": _METRO_MATCHES + (["remote"] if remote else [])},
    ]


def rules_from_presets(term_rules: dict, wanted_terms: list[str],
                       location_cfg: dict | None = None) -> list[dict]:
    """One legacy-shaped rule per wanted term, from its season's preset.
    A season absent from `term_rules` gets DEFAULT_PRESET."""
    rules: list[dict] = []
    for term in wanted_terms:
        season = terms_mod.term_season(term)
        preset = term_rules.get(season, DEFAULT_PRESET) if season else DEFAULT_PRESET
        rules.append({"when": {"term": [term]},
                      "accept_if_any": preset_conds(preset, location_cfg)})
    return rules


@dataclass
class Verdict:
    status: str                              # "accept" | "reject" | "ambiguous"
    reasons: list[str] = field(default_factory=list)
    needs: list[str] = field(default_factory=list)  # of: term, top_company, atlanta_metro


def _accept(*reasons: str) -> Verdict:
    return Verdict("accept", list(reasons))


def _reject(*reasons: str) -> Verdict:
    return Verdict("reject", list(reasons))


class UserFilter:
    def __init__(self, cfg: dict, repo_root: Path,
                 today: date | None = None):
        """`today` anchors the rolling term window (default date.today());
        the same date must be passed to evaluate() so both agree."""
        self.cfg = cfg
        self.name = cfg["name"]
        self.repo_root = repo_root
        if today is None:
            today = date.today()
        self._company_lists: dict[str, CompanyList] = {}
        role = cfg.get("role_filter", {})
        self.include = [k.casefold() for k in role.get("include_keywords", [])]
        self.exclude = [k.casefold() for k in role.get("exclude_keywords", [])]
        # Sources listed here must also match strict_include_keywords (a tighter
        # subset of include_keywords that excludes bare "engineer"). This lets
        # broad non-SW engineering repos pass only clearly SW-titled roles.
        self.strict_sources: set[str] = set(role.get("strict_sources", []))
        self.strict_include = [k.casefold()
                               for k in role.get("strict_include_keywords", [])]
        # Chronological list for grouping/ordering; the set for membership.
        self.terms_order: list[str] = terms_mod.wanted_terms(cfg, today)
        self.terms_wanted: set[str] = set(self.terms_order)
        self.unknown_term_policy = cfg.get("unknown_term_policy", "llm")
        # `term_rules:` (per-season presets) wins over a legacy `rules:` list.
        term_rules = cfg.get("term_rules")
        if isinstance(term_rules, dict):
            self.legacy_rules = False
            self.rules: list[dict] = rules_from_presets(
                term_rules, self.terms_order, cfg.get("location"))
        else:
            self.legacy_rules = True
            self.rules = cfg.get("rules", [])
        # Priority companies: accepted for any wanted term regardless of the
        # term's rule, tagged and delivered ahead of everything else. The
        # yaml/prefs list plus whatever main.py adds from the tracker, each
        # widened to its alias group in the top-company list (AWS ~ Amazon).
        self.priority_names: set[str] = set()
        self.add_priority({norm_company(c) for c in
                           (cfg.get("priority") or {}).get("companies") or []})
        llm = cfg.get("llm", {})
        self.llm_enabled = bool(llm.get("enabled"))
        self.llm_tasks = set(llm.get("tasks", []))
        elim = cfg.get("eliminate", {})
        self.elim_unpaid = bool(elim.get("unpaid"))
        self.elim_grad_only = bool(elim.get("grad_only"))
        self.elim_active_clearance = bool(elim.get("active_clearance"))
        self.elim_veteran_only = bool(elim.get("veteran_only"))
        # Optional stale-posting cutoff: drop jobs whose date_posted is older
        # than this many days. Unset -> off; a job with no date_posted is kept
        # (conservative, like an unknown location).
        max_age = elim.get("max_age_days")
        self.elim_max_age_days: int | None = int(max_age) if max_age is not None else None
        allowed = {c.casefold() for c in elim.get("countries_allowed", [])}
        self.elim_countries: set[str] | None = None
        if allowed:  # categories that get a job DROPPED
            self.elim_countries = {"other"}
            if "united states" not in allowed and "us" not in allowed:
                self.elim_countries.add("us")
            if "canada" not in allowed:
                self.elim_countries.add("canada")

    # ----------------------------------------------------------- helpers

    def add_priority(self, names: set[str]) -> None:
        """Extend the priority set with already-normalized names, plus their
        aliases from data/top_companies.txt when that list exists."""
        aliases = None
        if (self.repo_root / TOP_COMPANIES).exists():
            aliases = self._company_list(TOP_COMPANIES)
        for n in names:
            if not n:
                continue
            self.priority_names |= set(aliases.aliases(n)) if aliases else {n}

    def is_priority(self, company: str) -> bool:
        return bool(self.priority_names) \
            and norm_company(company) in self.priority_names

    def _company_list(self, rel_path: str) -> CompanyList:
        if rel_path not in self._company_lists:
            self._company_lists[rel_path] = CompanyList(self.repo_root / rel_path)
        return self._company_lists[rel_path]

    def _cond_match(self, cond: dict, job: Job, llm_facts: dict | None) -> str | None:
        """Return a reason string if the condition passes, else None."""
        if cond.get("always"):
            return "always"
        if cond.get("priority"):
            return "company:priority" if self.is_priority(job.company) else None
        if "company_in_file" in cond:
            path = cond["company_in_file"]
            if self._company_list(path).match(job.company):
                return f"company:{Path(path).stem}"
            if llm_facts and "top" in path and llm_facts.get("is_top_company"):
                return "company:top_companies (LLM)"
            return None
        if "location_matches" in cond:
            patterns = [p.casefold() for p in cond["location_matches"]]
            for loc in job.locations:
                low = loc.casefold()
                for p in patterns:
                    if p in low:
                        return f"location:{p}"
            if "remote" in patterns and (job.work_model or "").casefold() == "remote":
                return "location:remote"
            if llm_facts and llm_facts.get("in_atlanta_metro"):
                return "location:atlanta (LLM)"
            return None
        if "location_within" in cond:
            for loc in job.locations:
                if in_atlanta_metro(loc):
                    return "location:atlanta-metro"
            if llm_facts and llm_facts.get("in_atlanta_metro"):
                return "location:atlanta (LLM)"
            return None
        return None

    def _llm_needs_for(self, conds: list[dict]) -> list[str]:
        needs = []
        for cond in conds:
            if "company_in_file" in cond and "top" in cond["company_in_file"] \
                    and "top_company_judgment" in self.llm_tasks:
                needs.append("top_company")
            if ("location_matches" in cond or "location_within" in cond) \
                    and "atlanta_metro_judgment" in self.llm_tasks:
                needs.append("atlanta_metro")
        return sorted(set(needs))

    def _eliminate_reason(self, job: Job, today: date | None = None) -> str | None:
        """Hard requirements that kill a job even when it's a SWE match.
        Conservative on location: only eliminates when EVERY location is
        confidently classified as a disallowed country. `today` (default
        date.today()) anchors the optional stale-posting cutoff."""
        if today is None:
            today = date.today()
        if norm_company(job.company) in _AGGREGATOR_COMPANIES:
            return "eliminated:aggregator-board"
        if self.elim_max_age_days is not None and job.date_posted is not None \
                and job.date_posted < today - timedelta(days=self.elim_max_age_days):
            return "eliminated:stale"
        jd = job.description or ""
        if self.elim_unpaid and ("unpaid" in job.title.casefold()
                                 or (job.salary or "").casefold().find("unpaid") >= 0):
            return "eliminated:unpaid"
        if self.elim_unpaid and jd and _JD_UNPAID_RE.search(jd):
            return "eliminated:unpaid-jd"
        if self.elim_grad_only:
            if job.degrees and not any(ok in d.casefold() for d in job.degrees
                                       for ok in _UNDERGRAD_OK):
                return "eliminated:grad-only-degrees"
            if _GRAD_ONLY_RE.search(job.title):
                return "eliminated:grad-only-title"
            if jd and jd_grad_only(jd):
                return "eliminated:grad-only-jd"
        if self.elim_active_clearance:
            if _ACTIVE_CLEARANCE_RE.search(job.title):
                return "eliminated:active-clearance"
            if jd and jd_requires_active_clearance(jd):
                return "eliminated:active-clearance-jd"
        if self.elim_veteran_only and _VETERAN_ONLY_RE.search(job.title):
            return "eliminated:veteran-only"
        if self.elim_countries and job.locations:
            cats = {location_country(loc) for loc in job.locations}
            if cats and cats <= self.elim_countries:
                return "eliminated:location-country"
        return None

    # -------------------------------------------------------------- main

    def evaluate(self, job: Job, llm_facts: dict | None = None,
                 today: date | None = None) -> Verdict:
        """First pass: llm_facts=None; may return ambiguous (needs=...).
        Second pass after llm.py: llm_facts set; never returns ambiguous.
        If the LLM supplied a term for an unknown-term job, the caller has
        already written it onto job.terms. `today` (default date.today())
        anchors the optional stale-posting elimination."""
        title = job.title.casefold()
        for kw in self.exclude:
            if kw in title:
                return _reject(f"excluded-keyword:{kw}")
        if self.include and not any(kw in title for kw in self.include):
            return _reject("no-role-keyword")
        if self.strict_sources and self.strict_include \
                and set(job.sources) & self.strict_sources \
                and not any(kw in title for kw in self.strict_include):
            return _reject("no-strict-role-keyword")
        elim = self._eliminate_reason(job, today)
        if elim:
            return _reject(elim)

        if not job.terms:
            if llm_facts is not None:
                # Even the LLM couldn't resolve a term. Don't hard-drop: accept
                # iff the job passes the rules under EVERY wanted term (the most
                # restrictive assumption) -- a top-company/Atlanta/remote job is
                # wanted whatever its term turns out to be, but an accept-always
                # Summer rule alone must not wave through a job that might be
                # Fall/Spring. (Caught live: SK hynix "Software Engineer Intern",
                # no term anywhere, LLM top=true, was rejected forever.)
                verdicts = [self._rules_verdict(job, {t}, llm_facts)
                            for t in sorted(self.terms_wanted)]
                if verdicts and all(v.status == "accept" for v in verdicts):
                    reasons = sorted({r for v in verdicts for r in v.reasons})
                    return _accept("term-unknown", *reasons)
                return _reject("term-unresolved")
            policy = self.unknown_term_policy
            if policy == "drop":
                return _reject("unknown-term")
            if policy == "llm" and self.llm_enabled and "term_inference" in self.llm_tasks:
                # Term unknown -> rules unknown too; ask everything in one shot.
                needs = sorted({"term", *self._llm_needs_for(
                    [c for r in self.rules for c in r.get("accept_if_any", [])])})
                return Verdict("ambiguous", ["unknown-term"], needs)
            if policy == "llm":  # llm disabled -> fall through like "keep"
                policy = "keep"
            if policy == "keep":
                matched_terms = set(self.terms_wanted)
            else:
                return _reject("unknown-term")
        else:
            matched_terms = set(job.terms) & self.terms_wanted
            if not matched_terms:
                return _reject("term-not-wanted")

        return self._rules_verdict(job, matched_terms, llm_facts)

    def _rules_verdict(self, job: Job, matched_terms: set[str],
                       llm_facts: dict | None) -> Verdict:
        # A priority company is wanted whatever the term's rule says (this
        # also covers a legacy `rules:` block that predates the concept).
        if self.is_priority(job.company):
            return _accept("company:priority")
        applicable_conds: list[dict] = []
        for rule in self.rules:
            when_terms = set(rule.get("when", {}).get("term", []))
            if not when_terms or when_terms & matched_terms:
                for cond in rule.get("accept_if_any", []):
                    applicable_conds.append(cond)
                    reason = self._cond_match(cond, job, llm_facts)
                    if reason:
                        return _accept(reason)
        if not applicable_conds:
            return _reject("no-rule-for-term")

        if llm_facts is None and self.llm_enabled:
            needs = self._llm_needs_for(applicable_conds)
            if needs:
                return Verdict("ambiguous", ["rules-not-met"], needs)
        return _reject("rules-not-met")


# Files in users/ that belong to the auto-apply subsystem (src/apply), not
# the watcher: answer books and ATS logins follow different schemas and also
# carry a `name:` (the applicant's legal name), so globbing *.yaml without
# this filter mints a phantom watcher user out of them.
NON_WATCHER_SUFFIXES = (
    "_apply.yaml", "_apply.example.yaml",
    "_logins.yaml", "_logins.example.yaml",
    "apply.example.yaml", "logins.example.yaml",   # shipped templates
)


def is_watcher_config(path: Path) -> bool:
    return not path.name.endswith(NON_WATCHER_SUFFIXES)


def load_users(users_dir: Path) -> list[dict]:
    import yaml

    users = []
    for path in sorted(users_dir.glob("*.yaml")) + sorted(users_dir.glob("*.yml")):
        if not is_watcher_config(path):
            continue
        cfg = yaml.safe_load(path.read_text(encoding="utf-8"))
        if cfg and cfg.get("name"):
            users.append(cfg)
    return users
