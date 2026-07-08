"""The answer book: resolve almost any application-form question from the profile.

Two layers:

* `canonical_answers(profile)` flattens the whole profile into a flat map of
  string answers (booleans rendered "Yes"/"No"), e.g. authorized_us -> "Yes".
* `answer_for(field, profile)` takes one scraped form field {label, type,
  options, ...} and returns the value to enter — matching the label against a
  broad rule table, then, for selects/radios, mapping the answer onto the
  field's actual option labels. It also consults the freeform question bank
  (`profile.answer_bank`) for custom/essay questions.

This is what lets the agent fill the long tail of portal questions (work
authorization, sponsorship, EEO, salary, relocation, start date, "how did you
hear", 18+, background-check consent, ...) deterministically — no LLM required.
The LLM, when configured, only has to cover what these rules miss.
"""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .profile import ApplyProfile


def _yn(b: bool) -> str:
    return "Yes" if b else "No"


def canonical_answers(profile: "ApplyProfile") -> dict[str, str]:
    wa, eeo, edu = profile.work_authorization, profile.eeo, profile.education
    comp, exp, log = profile.compensation, profile.experience, profile.logistics
    scr, ref, adr, per = (profile.screening, profile.referral,
                          profile.address, profile.personal)
    grad = " ".join(x for x in (edu.grad_month, edu.grad_year) if x)
    a: dict[str, Any] = {
        # identity / contact
        "first_name": profile.first_name,
        "last_name": profile.last_name,
        "full_name": profile.name,
        "preferred_name": per.preferred_name or profile.first_name,
        "pronouns": per.pronouns,
        "email": profile.email,
        "phone": profile.phone,
        "address": adr.street,
        "address_line2": adr.line2,
        "city": profile.city,
        "state": profile.state,
        "zip": adr.postal_code,
        "country": profile.country,
        "linkedin": profile.links.linkedin,
        "github": profile.links.github,
        "portfolio": profile.links.portfolio,
        "website": profile.links.website,
        # work authorization
        "authorized_us": _yn(wa.authorized_us),
        "requires_sponsorship": _yn(wa.requires_sponsorship),
        "authorized_canada": _yn(wa.authorized_canada),
        "citizenship": wa.citizenship,
        # EEO / voluntary self-id
        "gender": eeo.gender,
        "race": eeo.race,
        "hispanic_latino": eeo.hispanic_latino,
        "veteran_status": eeo.veteran_status,
        "disability_status": eeo.disability_status,
        # education
        "school": edu.school,
        "degree": edu.degree,
        "major": edu.major,
        "gpa": edu.gpa,
        "grad_date": grad,
        # Split month/year for widgets with SEPARATE end-date fields (common on
        # Greenhouse education blocks: "End date month" / "End date year").
        "grad_month": edu.grad_month,
        "grad_year": edu.grad_year,
        # compensation / experience
        "desired_salary": comp.desired_salary,
        "current_salary": comp.current_salary,
        "years_experience": exp.years_experience,
        "current_title": exp.current_title,
        "current_employer": exp.current_employer,
        # logistics
        "willing_to_relocate": _yn(profile.willing_to_relocate),
        "start_date": log.start_date,
        "notice_period": log.notice_period,
        "work_preference": log.work_preference,
        "willing_to_travel": _yn(log.willing_to_travel),
        # screening
        "over_18": _yn(scr.over_18),
        "legally_authorized": _yn(scr.legally_authorized),
        "felony_conviction": _yn(scr.felony_conviction),
        "background_check_consent": _yn(scr.background_check_consent),
        "drug_test_consent": _yn(scr.drug_test_consent),
        "driver_license": _yn(scr.driver_license),
        "security_clearance": scr.security_clearance,
        # referral
        "how_heard": ref.how_heard,
        "referred_by": ref.referred_by,
    }
    return {k: str(v) for k, v in a.items() if v not in (None, "")}


# Label regex -> canonical key. First match wins, so order from specific to
# general. Matched against the lower-cased field label.
_LABEL_RULES: list[tuple[str, str]] = [
    (r"e-?mail", "email"),
    (r"\bphone\b|mobile|telephone|\bcell\b", "phone"),
    (r"linkedin", "linkedin"),
    (r"github", "github"),
    (r"portfolio", "portfolio"),
    (r"personal (web)?site|^website|website url", "website"),
    (r"preferred name|nick.?name|what.*go by", "preferred_name"),
    (r"pronoun", "pronouns"),
    (r"first name|given name|legal first", "first_name"),
    (r"last name|surname|family name|legal last", "last_name"),
    (r"full name|legal name|^name$|your name|candidate name", "full_name"),
    (r"address line ?2|\b(apt|suite|unit)\b", "address_line2"),
    (r"street address|address line ?1|mailing address|^address|home address",
     "address"),
    (r"\bcity\b|\btown\b", "city"),
    (r"\bstate\b|province|region", "state"),
    (r"zip|postal", "zip"),
    (r"\bcountry\b", "country"),
    # work authorization — sponsorship checked before generic "authorized"
    (r"sponsor", "requires_sponsorship"),
    (r"authoriz.*work.*canada|legally.*work.*canada", "authorized_canada"),
    (r"authoriz.*work|legally.*(work|eligible)|eligible to work|right to work|"
     r"work authorization", "authorized_us"),
    (r"citizen|visa status|immigration status|work status", "citizenship"),
    # EEO / voluntary self-id
    (r"hispanic|latino", "hispanic_latino"),
    (r"gender identity|\bgender\b|\bsex\b", "gender"),
    (r"race|ethnic", "race"),
    (r"veteran|protected veteran", "veteran_status"),
    (r"disab", "disability_status"),
    # education — grad-date / degree / major run BEFORE the school-name rule so
    # a question SENTENCE that merely contains "university"/"college" (e.g.
    # "When do you expect to graduate university?", "Are you enrolled in a
    # university...?") isn't misread as asking for the school name.
    # Split end-date fields (Greenhouse "End date month" / "End date year")
    # need month / year ALONE, so they precede the combined grad-date rule.
    (r"(end|grad\w*|completion) ?date? ?month|month.*(grad|end date)|"
     r"^\s*month\s*\*?\s*$", "grad_month"),
    (r"(end|grad\w*|completion) ?date? ?year|year.*(grad|end date)|"
     r"^\s*year\s*\*?\s*$|graduation year|year of graduation", "grad_year"),
    (r"grad.*date|graduation|expected grad|completion date|when.*graduat|"
     r"end date|when.*(finish|complete).*(degree|program|studies|school)",
     "grad_date"),
    (r"highest.*(degree|education)|degree( type| level)?|level of education|"
     r"what degree|which degree|degree.*(pursuing|seeking|expect)|"
     r"pursuing.*degree", "degree"),
    (r"major|field of study|discipline|area of study|concentration", "major"),
    (r"g\.?p\.?a", "gpa"),
    # School NAME only — anchor to the label HEAD ("School / University",
    # "College name", "Institution attended", ...) so an enrollment/graduation
    # QUESTION SENTENCE that merely contains "university"/"college" (which no
    # longer starts with it) doesn't grab the school name.
    (r"^\s*(school|university|college|institution|alma mater)\b|"
     r"(school|university|college|institution)\s+name|"
     r"name of (your )?(school|university|college|institution)", "school"),
    # compensation / experience
    (r"desired salary|salary expectation|expected (salary|compensation)|"
     r"compensation expectation|salary requirement|pay expectation", "desired_salary"),
    (r"current salary|present salary", "current_salary"),
    (r"years.*experience|experience.*years|how many years", "years_experience"),
    (r"current (job )?title|present title|current position", "current_title"),
    (r"current (employer|company)|present employer", "current_employer"),
    # logistics
    (r"relocat", "willing_to_relocate"),
    # Education-block START date ("Start date month" / "Start date year", the
    # school-attendance start on Greenhouse education widgets). The profile has
    # NO school-start data, so these must resolve to nothing and be left blank —
    # NOT fall through to the generic start-date rule below, which would map the
    # employment `start_date` ("Flexible") onto them. Detected the same way as
    # the split END-date rules above: "start date" paired with month/year. Runs
    # AHEAD of the generic start-date rule so it wins. `_edu_start_noop` is not a
    # canonical key, so canon.get(...) is None -> the field is left unanswered.
    (r"start ?date? ?(month|year)\b|(month|year).*start date", "_edu_start_noop"),
    (r"start date|available.*start|availability|earliest.*start|when can you "
     r"start|date available", "start_date"),
    (r"notice period", "notice_period"),
    (r"remote|hybrid|on-?site|work (location )?preference|work model|"
     r"work arrangement", "work_preference"),
    (r"willing to travel|able to travel|travel requirement", "willing_to_travel"),
    # screening
    (r"18 years|over 18|at least 18|of legal age|are you.*age", "over_18"),
    (r"felony|convicted|criminal (record|history|conviction)", "felony_conviction"),
    (r"background check|background investigation", "background_check_consent"),
    (r"drug (test|screen)", "drug_test_consent"),
    (r"security clearance|clearance level|active clearance", "security_clearance"),
    (r"driver.?s? licen[cs]e", "driver_license"),
    # referral
    (r"how did you hear|how.*hear about|hear about (us|this)|referral source|"
     r"where did you (hear|find)|source\b", "how_heard"),
    (r"referred by|referral name|who referred|employee referral", "referred_by"),
]
_COMPILED = [(re.compile(rx, re.I), key) for rx, key in _LABEL_RULES]

# Keys a rule can match to *deliberately answer nothing* — the label was
# recognised (so no other rule / fuzzy-bank guess should fire), but the profile
# carries no data for it and it must be left blank. `_edu_start_noop` catches
# education-block "Start date month/year" (school-attendance start), which must
# NOT inherit the employment start_date.
_NOOP_KEYS = {"_edu_start_noop"}


def _is_choice(field: dict) -> bool:
    return bool(field.get("is_select")) or \
        field.get("type") in ("select", "radio", "boolean")


def match_option(value: str, options: list[str]) -> str | None:
    """Map a canonical answer onto a field's concrete option labels."""
    if not options:
        return value
    low = value.strip().lower()
    opts = [(o, str(o).strip().lower()) for o in options]

    for o, ol in opts:                                  # exact
        if ol == low:
            return o
    if low in ("yes", "no"):                            # boolean
        want_yes = low == "yes"
        for o, ol in opts:
            if want_yes and re.search(r"\byes\b|^i (do|am|have)|^authorized", ol):
                return o
            if not want_yes and re.search(r"\bno\b|^i (do not|am not|don'?t)|"
                                          r"not? (a|able)", ol):
                return o
    if "decline" in low or "prefer not" in low or "not to" in low or \
            "not wish" in low or "rather not" in low:
        for o, ol in opts:
            # Also match "I do/don't want to answer" (Greenhouse's Disability
            # Status uses that phrasing, not "decline"/"prefer not"), so a
            # canonical "Decline to self-identify" still lands the non-answer.
            if re.search(r"decline|prefer not|wish (not |to )?|rather not|"
                         r"not to (say|answer|identify)|no answer|not? answer|"
                         r"do ?n[o']?t want to answer|not want to answer", ol):
                return o
    for o, ol in opts:                                  # substring either way
        if low and (low in ol or ol in low):
            return o
    toks = [t for t in re.split(r"\W+", low) if len(t) > 2]
    for o, ol in opts:                                  # token overlap
        if any(t in ol for t in toks):
            return o
    return None


def _bank_strong(label: str, bank: dict[str, str]) -> str | None:
    """A specific custom-question match (the bank question text appears in the
    form label). Runs BEFORE the generic rules so e.g. a term-specific start
    date beats the generic 'start date' rule."""
    for q, ans in bank.items():
        ql = q.strip().lower()
        if ans and ql and ql in label:
            return ans
    return None


# Filler words that must NOT count toward fuzzy bank overlap — otherwise
# "What is your top location preference?" matches "What are your research
# interests?" on {what, your}. Overlap is required on CONTENT tokens only.
_STOPWORDS = {
    "what", "which", "your", "you", "this", "that", "these", "those", "the",
    "are", "and", "for", "with", "have", "has", "will", "would", "can", "could",
    "does", "did", "was", "were", "any", "our", "his", "her", "their", "them",
    "there", "here", "from", "into", "about", "when", "where", "who", "whom",
    "how", "why", "not", "but", "all", "some", "been", "being", "than", "then",
    "please", "provide", "list",
    # Domain-ubiquitous in an internship application — appears in almost every
    # question, so it carries no discriminating signal for fuzzy matching.
    "internship", "internships", "position", "role", "job",
}


def _content_toks(text: str) -> set[str]:
    return {t for t in re.split(r"\W+", text.lower())
            if len(t) > 3 and t not in _STOPWORDS}


def _bank_fuzzy(label: str, bank: dict[str, str]) -> str | None:
    """Token-overlap fallback for loosely-worded custom questions. Stopwords are
    excluded so filler words ("what", "your", "this", "for") can't spuriously
    bridge two unrelated questions; the >=2 threshold is on CONTENT tokens."""
    lab_toks = _content_toks(label)
    best, best_score = None, 0
    for q, ans in bank.items():
        if not ans:
            continue
        q_toks = _content_toks(q)
        score = len(lab_toks & q_toks)
        if score > best_score and score >= 2:
            best, best_score = ans, score
    return best


# --- radio/checkbox + required-select fallbacks ----------------------------

# Group-question patterns where the user wants an affirmative / maximal answer
# by default: availability, commitment, work-eligibility, relocation, in-office
# days. For these we pick the "Yes" radio, or check EVERY box of a multi-select
# (e.g. "which days can you work" -> all of them).
_AFFIRMATIVE_GROUP = re.compile(
    r"availab|able to (work|commit|join|start)|willing to (relocate|travel|"
    r"work|commit)|authoriz\w* to work|eligible to work|legally (authorized|"
    r"eligible)|comfortable (working|with)|anchor day|in.?office|on-?site|"
    r"onsite|relocat|which days|days.*(work|office|availab)", re.I)

# Acknowledgement / consent boxes we always check.
_ACK = re.compile(
    r"acknowledg|consent|i agree|i have read|i certif|i confirm|privacy "
    r"polic|terms|gdpr|data (processing|protection)", re.I)

# Never auto-answer these affirmatively, whatever the wording.
_NEGATIVE_SCREEN = re.compile(
    r"felony|convict|criminal|terminated|been fired|visa.*expir|sponsor", re.I)

_NEG_OPT = re.compile(r"^\s*no\b|^i (do not|am not|don'?t|have not|haven'?t)|"
                      r"\bnot\b|decline", re.I)
_POS_OPT = re.compile(r"^\s*yes\b|^i (do|am|have|agree|consent|certif)|"
                      r"authoriz|eligible|willing|\bable\b", re.I)


def _split_group(label: str) -> tuple[str, str]:
    """The scraper labels a radio/checkbox option 'Group question — Option'.
    Return (group_question, option_text); both equal `label` if no separator."""
    raw = (label or "").strip()
    if " — " in raw:
        gq, opt = raw.split(" — ", 1)
        return gq.strip(), opt.strip()
    return raw, raw


def _option_field_answer(field: dict, profile: "ApplyProfile") -> str | None:
    """Deterministic radio/checkbox handling. Returns the option text to
    select/check, or None to defer to the LLM. Per-option: for a radio Yes/No we
    return only the affirmative option; for a multi-select we return each option
    (so the whole group ends up checked)."""
    groupq, opt = _split_group(field.get("label") or "")
    if not opt:
        return None
    gq, ol = groupq.lower(), opt.lower()

    if _NEGATIVE_SCREEN.search(gq):                  # never auto-affirm screeners
        return None
    if _ACK.search(gq) or _ACK.search(ol):           # acknowledge / consent
        return opt
    if re.search(r"degree|education level|level of (education|study)", gq):
        deg = (profile.education.degree or "").lower()
        if deg and (deg in ol or ol in deg
                    or ("bachelor" in deg and re.search(r"bachelor|undergrad", ol))
                    or ("master" in deg and "master" in ol)):
            return opt
        return None
    if _AFFIRMATIVE_GROUP.search(gq):
        if field.get("type") == "checkbox":          # multi-select -> select ALL
            return None if _NEG_OPT.search(ol) else opt
        if _NEG_OPT.search(ol):                       # radio Yes/No -> Yes only
            return None
        return opt                                    # affirmative / sole option
    return None


_HOW_HEARD_PREF = re.compile(
    r"career|company (web)?site|company page|website|online|web search|"
    r"search engine|google|other|job board", re.I)


def _how_heard_fallback(options: list[str]) -> str | None:
    """A required 'how did you hear' select must not be left blank. Prefer a
    career-page / company-website / online option; else the first real option."""
    real = [o for o in options
            if o and str(o).strip().lower() not in ("", "-")
            and not str(o).strip().lower().startswith(("select", "choose", "please"))]
    for o in real:
        if _HOW_HEARD_PREF.search(str(o)):
            return o
    return real[0] if real else None


def answer_for(field: dict, profile: "ApplyProfile") -> str | None:
    """Resolve one form field to a concrete value, or None if unknown.
    For selects/radios the returned value is one of the field's options."""
    label = (field.get("label") or "").strip().lower()
    if not label:
        return None

    # Labels the user never wants filled (e.g. "Additional information").
    for skip in getattr(profile, "do_not_fill", []):
        if skip and skip.lower() in label:
            return None

    # Radio/checkbox: option labels are OPTIONS, not questions. Handle the cases
    # the user wants deterministically (acknowledge, degree, affirmative/maximal
    # availability); defer the genuinely ambiguous rest to the LLM.
    if field.get("type") in ("radio", "checkbox"):
        return _option_field_answer(field, profile)

    bank = profile.answer_bank
    value: str | None = _bank_strong(label, bank)       # specific custom Q wins
    matched_key: str | None = None

    if value is None:                                   # then generic rules
        canon = canonical_answers(profile)
        for rx, key in _COMPILED:
            if rx.search(label):
                if key in _NOOP_KEYS:                    # recognised -> leave blank
                    return None
                value = canon.get(key)
                matched_key = key
                break

    if value is None:                                   # then fuzzy custom Q
        value = _bank_fuzzy(label, bank)
    if value is None:
        return None

    if _is_choice(field):
        opt = match_option(value, field.get("options") or [])
        if opt is None and matched_key == "how_heard":  # required -> choose any
            opt = _how_heard_fallback(field.get("options") or [])
        return opt
    return value
