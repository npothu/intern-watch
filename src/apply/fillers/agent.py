"""LLM-assisted generic filler for Lever/Ashby/unknown ATS forms.

Used sparingly — for the long tail behind aggregator redirects. It is
deterministic-where-possible and cheap:

  1. scrape a compact JSON description of the visible form fields,
  2. resolve everything possible from the answer book (no LLM),
  3. ask the LLM ONCE to map the remaining fields (essays, oddly-worded Qs),
  4. fill mechanically (the LLM never drives clicks).

The answer book is always applied; the LLM only augments it. Any LLM problem
(no config, missing key, error, empty result) degrades to answer-book-only.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import re
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

import yaml

from ... import llm as llm_mod
from ...paths import DATA_ROOT as DATA_ROOT
from ..answers import answer_for, canonical_answers, match_option
from ..base import ApplyContext, ApplyMode, ApplyResult, ApplyStatus, ATSFamily
from ..dom import advance_to_application_form, has_visible_captcha

if TYPE_CHECKING:
    from playwright.sync_api import Page

    from ..profile import ApplyProfile

log = logging.getLogger(__name__)

# Keep the LLM payload small and cheap, but large enough not to DROP required
# fields. 40 silently starved real forms (Notion has 61 fields — the dropped
# ones included a required work-auth boolean; Palantir Lever's 32-checkbox
# language list ate the whole budget before the work-auth/sponsorship/EEO
# controls). The cap now counts radio/checkbox GROUPS (a question), not each
# individual option, so a long option list can't exhaust it.
MAX_FIELDS = 150
MAX_OPTIONS = 30

_SYSTEM = "Return ONLY a JSON array, no prose."

_INSTRUCTIONS = """\
You are filling out a job application form for the applicant described below.
Map the applicant's information onto the concrete form fields.

Output a JSON array of objects, one per field you can answer:
  {{"ref": "<copy the field's ref exactly>", "value": "<string>"}}
- For text/email/tel/textarea fields, "value" is the literal text to type.
- For select fields, "value" must be EXACTLY one of the field's options.
- For boolean fields (rendered as a Yes/No button pair; type "boolean"), "value"
  must be EXACTLY "Yes" or "No".
- Radio/checkbox options appear as SEPARATE fields whose label IS the option
  text. To SELECT one, return that field's ref with value = its own label;
  leave the others out. Only check options clearly supported by the applicant.
- For legal/eligibility/export-control questions (e.g. "U.S. person",
  citizenship, security clearance), choose the option ONLY if the applicant
  data states it unambiguously; otherwise OMIT it for human review.
- DO answer availability / logistics / preference questions affirmatively when
  the applicant data supports it: the applicant is actively seeking internships,
  is available full-time during the internship, is flexible on duration
  (4-16 months), and is willing to relocate. (e.g. "Are you available for a
  full-time internship?" -> check "Yes".)
- OMIT any field you cannot answer from the applicant data. Do not guess.

Applicant:
{profile}

Form fields:
{fields}
"""

_SUBMIT_SELECTORS = (
    "button[type=submit]",
    "input[type=submit]",
    "[data-testid*='submit' i]",
)
_CONFIRM_TEXTS = ("application submitted", "thank you for applying",
                  "successfully submitted", "we have received your application",
                  "application received", "thanks for applying",
                  "your application has been submitted",
                  "application complete", "submission received",
                  "we've received your application")

# A confirmation URL usually lands on one of these path fragments, or drops the
# apply/form segment entirely (back to the job-board home). Kept modest and
# lower-cased; matched as substrings of the post-submit path.
_CONFIRM_URL_HINTS = ("/confirmation", "/confirm", "/thanks", "/thank-you",
                      "/thankyou", "/success", "/submitted", "/complete")
# Substrings that mark a URL as still ON the application form (so a URL that
# merely gained a query string but kept these is NOT a move-off signal).
_FORM_URL_HINTS = ("/apply", "/application", "/form")
# Text that betrays a validation-error state (the submit button vanished only
# because the form re-rendered with errors, not because it posted).
_VALIDATION_TEXTS = ("is required", "required field", "please fill",
                     "please complete", "please correct", "this field is",
                     "must be", "invalid", "enter a valid")


# --------------------------------------------------------------- llm config

def _llm_cfg(user: str) -> dict:
    """Resume/LLM config block for the agent filler (prefer resume_llm, else
    llm). The apply subsystem is '<name>'-keyed, but the watcher file holding
    the LLM block may be named differently (the watcher user and the apply
    user need not share a name). So try users/<user>.yaml, then
    users/example.yaml, then any other watcher yaml — never the *_apply /
    *_logins answer-book files, which carry no LLM block."""
    users = DATA_ROOT / "users"
    candidates = [users / f"{user}.yaml", users / "example.yaml"]
    candidates += [p for p in sorted(users.glob("*.yaml"))
                   if not p.name.endswith(("_apply.yaml", "_logins.yaml",
                                           "apply.example.yaml",
                                           "logins.example.yaml"))]
    seen: set = set()
    for path in candidates:
        if path in seen or not path.exists():
            continue
        seen.add(path)
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        cfg = data.get("resume_llm") or data.get("llm") or {}
        if cfg:
            return cfg
    return {}


# ----------------------------------------------------------- profile payload

def _profile_payload(profile: ApplyProfile) -> dict[str, Any]:
    """A compact, LLM-friendly view of the answerable applicant data: the full
    canonical answer set plus the freeform question->answer bank."""
    payload: dict[str, Any] = dict(canonical_answers(profile))
    bank = {q: a for q, a in profile.answer_bank.items() if a}
    if bank:
        payload["answer_bank"] = bank
    return payload


# ------------------------------------------------------ deterministic fallback

def _deterministic_map(form_fields: list[dict], profile: ApplyProfile,
                       ) -> dict[str, str]:
    """Resolve every field we can from the answer book (contact, work auth,
    EEO, education, salary, logistics, screening, custom Q&A) — no LLM needed.
    For selects/radios the value is already one of the field's options."""
    out: dict[str, str] = {}
    for f in form_fields:
        ref = f.get("ref")
        if not ref:
            continue
        val = answer_for(f, profile)
        if val:
            out[ref] = val
    return out


# ----------------------------------------------------------- field mapping

def map_fields(form_fields: list[dict], profile: ApplyProfile,
               llm_cfg: dict | None,
               call: Callable[[str, str, str, str], str] | None = None,
               ) -> tuple[dict[str, str], list[str]]:
    """Map scraped form fields to concrete values.

    Returns (mapping {ref: value}, notes). The answer book is always the base;
    the LLM augments/overrides it. Never raises: any LLM problem degrades to the
    answer-book mapping. `call` can be injected for tests.
    """
    llm_cfg = llm_cfg or {}
    notes: list[str] = []

    # Drop fields the user never wants filled (e.g. "Additional information")
    # before BOTH the answer book and the LLM see them.
    skip = [s.lower() for s in getattr(profile, "do_not_fill", []) if s]
    def _skip(f: dict) -> bool:
        lab = (f.get("label") or "").lower()
        return any(s in lab for s in skip)
    fillable = [f for f in form_fields if not _skip(f)]
    valid_refs = {f.get("ref") for f in fillable if f.get("ref")}

    # The answer book is always applied as the base; the LLM only augments it
    # (and may override) for fields the rules couldn't resolve.
    base = _deterministic_map(fillable, profile)

    if call is None:
        provider = llm_mod.provider_of(llm_cfg) if llm_cfg else ""
        call = llm_mod._PROVIDERS.get(provider) if llm_cfg else None

    if not llm_cfg or call is None:
        log.info("auto-apply agent: LLM fill OFF - no llm/resume_llm block in "
                 "the user yaml; answer-book mapping only")
        notes.append("no LLM configured; answer-book mapping only")
        return base, notes

    key_env = llm_mod.api_key_env_for(llm_cfg)
    try:
        api_key = os.environ[key_env]
    except KeyError:
        log.info("auto-apply agent: LLM fill OFF - set %s to enable the agent "
                 "fallback; answer-book mapping only", key_env)
        notes.append("LLM API key env not set; answer-book mapping only")
        return base, notes

    provider = llm_mod.provider_of(llm_cfg)
    model = llm_cfg.get("model") or llm_mod.DEFAULT_MODEL.get(provider, "")
    user_msg = _INSTRUCTIONS.format(
        profile=json.dumps(_profile_payload(profile), ensure_ascii=False,
                           indent=1),
        fields=json.dumps(fillable, ensure_ascii=False, indent=1),
    )

    try:
        text = call(model, _SYSTEM, user_msg, api_key)
        items = llm_mod.parse_json_array(text)
    except Exception as exc:                         # network/parse/provider
        log.warning("agent LLM mapping failed (%s); falling back", exc)
        notes.append(f"LLM error ({type(exc).__name__}); answer-book mapping")
        return base, notes

    mapping = dict(base)                             # answer book first
    llm_added = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        ref = item.get("ref")
        value = item.get("value")
        # `ref not in base`: the LLM only FILLS refs the answer book couldn't
        # resolve — it never overrides a deterministic answer. The bank's value
        # is exact (e.g. "Graduation Date" -> 2027-05-10); the LLM's profile
        # view carries only the coarse "May 2027" (day is dropped in the
        # payload), so an override silently downgraded precision — the widget
        # then parsed May 1 and committed the wrong day. Combobox option
        # re-picking, which genuinely needs the model, runs later in
        # _apply_mapping's pending pass, not here, so it is untouched.
        if (isinstance(ref, str) and ref in valid_refs
                and value is not None and str(value) != ""
                and ref not in base):
            llm_added += 1
            mapping[ref] = str(value)
    notes.append(f"answer book filled {len(base)}, LLM added {llm_added}")
    return mapping, notes


# ------------------------------------------------------- form extraction (DOM)

# Executed in the page; returns the field descriptors plus a flag per field
# telling apply() whether it's a <select> (so we use select_option).
_EXTRACT_JS = r"""
() => {
  const MAX = %d, MAXOPT = %d;
  const out = [];
  // The question text of an UNLABELED control (custom comboboxes render the
  // question as a sibling <label>/<div> with no for/aria link — e.g. Ashby's
  // "How did you hear about this role?" combobox, whose only attribute is the
  // placeholder "Start typing..."). Climb a few ancestors, scanning preceding
  // siblings for input-free text; stop before grabbing another field's label.
  // Cap on how much text a candidate container may hold before we treat it as
  // "the whole page" rather than one question — climbing past it scraped
  // Cloudflare's entire "Back to jobs\n...job description..." as a checkbox
  // label and let a stray acknowledge-pattern auto-check it.
  const MAX_Q = 300;
  const questionFor = (el) => {
    let node = el;
    for (let i = 0; i < 6; i++) {
      let sib = node.previousElementSibling;
      while (sib) {
        if (sib.querySelectorAll('input, textarea, select').length === 0) {
          const t = (sib.innerText || '').trim();
          if (t && t.length <= MAX_Q) return t.slice(0, 140);
        }
        sib = sib.previousElementSibling;
      }
      const par = node.parentElement;
      // Stop before the container grows into unrelated form controls or an
      // over-large text blob (a page section, not a single question).
      if (!par || par.querySelectorAll('input, textarea, select').length > 1 ||
          (par.innerText || '').trim().length > MAX_Q)
        break;
      node = par;
    }
    return '';
  };
  const labelFor = (el) => {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && l.innerText.trim()) return l.innerText.trim();
    }
    const lblby = el.getAttribute('aria-labelledby');
    if (lblby) {
      const l = document.getElementById(lblby.split(' ')[0]);
      if (l && l.innerText.trim()) return l.innerText.trim();
    }
    let p = el.closest('label');
    if (p && p.innerText.trim()) return p.innerText.trim();
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    // No real label — placeholder/name are last resorts BEHIND the question
    // text found in the surrounding DOM, so mapping sees the actual question.
    const q = questionFor(el);
    if (q) return q;
    if (el.getAttribute('placeholder')) return el.getAttribute('placeholder');
    if (el.getAttribute('name')) return el.getAttribute('name');
    return '';
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = window.getComputedStyle(el);
    // aria-hidden decoys: react-select adds a ghost "requiredInput" shim per
    // required <select> (empty label, required=true, aria-hidden=true) that
    // still lays out with size, so getBoundingClientRect / offsetParent don't
    // catch it. Extracting it pollutes the gate with phantom required fields
    // and wastes an LLM mapping on it. Treat aria-hidden on the element OR any
    // ancestor as not-visible so those shims never enter the field list.
    if (el.closest && el.closest('[aria-hidden="true"]')) return false;
    return r.width > 0 && r.height > 0 &&
           s.visibility !== 'hidden' && s.display !== 'none';
  };
  const refFor = (el, tag) => {
    if (el.id) return '#' + CSS.escape(el.id);
    if (el.getAttribute('name'))
      return `${tag}[name="${el.getAttribute('name')}"]`;
    // Playwright-only :nth-match counts matches page-wide in DOM order — the
    // same order as querySelectorAll. (CSS :nth-of-type counts within the
    // PARENT, so a page-wide index in it resolved to nothing.)
    const same = Array.from(document.querySelectorAll(tag));
    return `:nth-match(${tag}, ${same.indexOf(el) + 1})`;
  };
  // Inputs that are clearly NOT part of an application form: site search,
  // newsletter/job-alert signup, "email this job", save-job, chatbot, cookie
  // consent. Filling these is the "ABB false success" bug.
  const BAD = ['search','newsletter','subscribe','savejob','save-job',
               'email-job','emailjob','notifiedemail','chatbot','cookieconsent'];
  const incidental = (el) => {
    const meta = ((el.id||'') + ' ' + (el.getAttribute('name')||'') + ' ' +
                  (el.getAttribute('placeholder')||'') + ' ' +
                  (el.getAttribute('aria-label')||'')).toLowerCase();
    return BAD.some(b => meta.includes(b));
  };
  // For a radio/checkbox OPTION, find the GROUP question (the heading/label that
  // precedes the option group) so the option isn't a contextless "Yes"/"No".
  const groupQuestion = (el) => {
    // Climb to the group container holding all sibling options (Ashby: a
    // <fieldset> whose FIRST child is the question, then the option divs).
    // Bounded: stop once the container's text exceeds MAX_Q (a lone
    // acknowledge checkbox has no sibling option to stop us, so an unbounded
    // climb reached the page root and scraped the whole page as its label).
    let grp = el;
    for (let i = 0; i < 8; i++) {
      const par = grp.parentElement;
      if (!par) break;
      if ((par.innerText || '').trim().length > MAX_Q) break;
      grp = par;
      if (par.querySelectorAll(
            'input[type=radio],input[type=checkbox]').length > 1) break;
    }
    const lg = grp.querySelector(':scope > legend');
    if (lg) { const t = (lg.innerText || '').trim(); if (t) return t.slice(0, 140); }
    // First child element that has text but no input = the question heading.
    for (const ch of grp.children) {
      if (ch.querySelector('input, textarea, select')) break;   // reached options
      const t = (ch.innerText || '').trim();
      if (t) return t.slice(0, 140);
    }
    // Fallback: nearest preceding sibling text of the group (bounded — a huge
    // preceding <header>/description is a page section, not this question).
    let sib = grp.previousElementSibling;
    while (sib) {
      const t = (sib.innerText || '').trim();
      if (t && t.length <= MAX_Q && sib.querySelectorAll('input').length === 0)
        return t.slice(0, 140);
      sib = sib.previousElementSibling;
    }
    return '';
  };
  // Whether a control is REQUIRED. The native flag and aria-required cover most
  // ATSes; grouped/custom widgets (radios, comboboxes) that carry neither expose
  // the requirement only as a visible asterisk on the question label, so we scan
  // a couple of nearby ancestors for one cheaply - a lower bound, never a
  // guarantee (an undetected required field simply is not gated).
  // Whether a node's ::before/::after pseudo-element renders an asterisk. Many
  // ATSes (Cohere/Ashby) mark a required question with a CSS-injected "*" in
  // label::after — invisible to innerText, so a text-only scan mis-reads the
  // field as optional (fail-open). getComputedStyle(node, '::after').content
  // exposes it (quoted, e.g. '"*"').
  const pseudoAsterisk = (node) => {
    if (!node || !node.getBoundingClientRect) return false;
    for (const pe of ['::after', '::before']) {
      let c = '';
      try { c = window.getComputedStyle(node, pe).content || ''; }
      catch (e) { c = ''; }
      if (c && c !== 'none' && c !== 'normal' && /[*✱∗]/.test(c)) return true;
    }
    return false;
  };
  // The "*" is frequently a ::after on a DESCENDANT of the question label, not
  // on the label/container itself (Notion's Ashby form injects it on an inner
  // <span> of the question heading). A container-only pseudo check misses it and
  // reads the required boolean as optional (fail-open). Scan a bounded set of
  // the container's descendants for a pseudo-element asterisk. Capped so a big
  // container (a page section) can't turn this into a whole-page style sweep.
  const descendantPseudoAsterisk = (node) => {
    if (!node || !node.querySelectorAll) return false;
    // Only scan a container that holds ONE question's controls — a node
    // spanning several inputs/buttons is a multi-question section, and its
    // descendants include ANOTHER question's asterisk (which would wrongly mark
    // this field required). >2 form controls (a Yes/No pair is 2) means the node
    // grew past a single question; don't scan it.
    try {
      if (node.querySelectorAll(
            'input,textarea,select,button').length > 2) return false;
    } catch (e) { return false; }
    let scanned = 0;
    for (const d of node.querySelectorAll(
        'span,abbr,i,em,b,strong,sup,label,div')) {
      if (scanned++ >= 15) break;
      if (pseudoAsterisk(d)) return true;
    }
    return false;
  };
  const asteriskNear = (el) => {
    let node = el;
    for (let i = 0; i < 4 && node; i++) {
      if (node.getAttribute && node.getAttribute('aria-required') === 'true')
        return true;
      const t = (node.innerText || '').trim();
      if (t && t.length <= MAX_Q && /[*✱∗]/.test(t)) return true;
      if (pseudoAsterisk(node)) return true;
      // Only look INSIDE a container small enough to be one question (not a
      // page section) — the descendant scan is a lower bound, never a sweep.
      if (t && t.length <= MAX_Q && descendantPseudoAsterisk(node)) return true;
      // A required marker is commonly a ::after on the LABEL element, not on the
      // control's ancestors; consult the linked/wrapping label too — and its
      // descendant spans, where many ATSes actually inject the "*".
      let lbl = null;
      if (node.id) {
        try { lbl = document.querySelector(
          `label[for="${CSS.escape(node.id)}"]`); } catch (e) { lbl = null; }
      }
      if (!lbl && node.closest) lbl = node.closest('label');
      if (lbl && lbl !== node &&
          (pseudoAsterisk(lbl) || descendantPseudoAsterisk(lbl))) return true;
      node = node.parentElement;
    }
    return false;
  };
  const requiredFor = (el) => {
    if (el.required) return true;
    if (el.getAttribute && el.getAttribute('aria-required') === 'true') return true;
    // Grouped/custom controls: fall back to a visible asterisk on the group.
    const t = (el.type || '').toLowerCase();
    if (el.getAttribute && el.getAttribute('role') === 'combobox') return asteriskNear(el);
    if (t === 'radio' || t === 'checkbox') return asteriskNear(el);
    return false;
  };
  // Budget counted in QUESTIONS, not fields: a radio/checkbox GROUP (all its
  // options share one group-question) consumes ONE unit, so a 32-option
  // language checklist can't exhaust the whole cap and starve the work-auth /
  // sponsorship / EEO controls that follow it (Palantir Lever bug). budget()
  // returns true while there is room for a NEW question; groupKey dedupes a
  // group so its 2nd..Nth option is free.
  const groupKeys = new Set();
  let questionCount = 0;
  const budget = () => questionCount < MAX;
  const nodes = document.querySelectorAll('input, textarea, select');
  for (const el of nodes) {
    const tag0 = el.tagName.toLowerCase();
    const type0 = (el.getAttribute('type') || tag0).toLowerCase();
    const grouped = (type0 === 'radio' || type0 === 'checkbox');
    // Does emitting this element open a NEW question? Options of an already-seen
    // group don't; everything else does. Enforce the cap only on new questions.
    const gkey = grouped ? (groupQuestion(el) || ('__grp_' + questionCount)) : null;
    const isNewQuestion = !grouped || !groupKeys.has(gkey);
    if (isNewQuestion && !budget()) break;
    const tag = el.tagName.toLowerCase();
    let type = (el.getAttribute('type') || tag).toLowerCase();
    if (type === 'hidden' || type === 'submit' || type === 'button' ||
        type === 'file' || type === 'reset' || type === 'image') continue;
    if (type === 'password' || incidental(el)) continue;
    if (!visible(el)) continue;
    // react-select / custom dropdowns are <input role=combobox>, not <select>.
    if (el.getAttribute('role') === 'combobox') type = 'combobox';
    const ph = el.getAttribute('placeholder') || '';
    // Date-picker inputs: a native <input type=date>, or a plain text input
    // whose placeholder/aria-label advertises a date format (Ashby/Notion/
    // Snowflake grad- & availability-date widgets, e.g. "MM/DD/YYYY"). Route
    // them to the date filler, which types the value in the placeholder's format
    // with real keystrokes (plain fill() is ignored by these widgets).
    const dateFmt = /m{1,2}[\/.\-]d{1,2}[\/.\-]y{2,4}|d{1,2}[\/.\-]m{1,2}[\/.\-]y{2,4}|y{4}[\/.\-]m{1,2}[\/.\-]d{1,2}/i;
    // Ashby's calendar input carries no format mask — its placeholder is just
    // "Pick date..." — so also route on a datepicker-ish placeholder, or on a
    // date-ish QUESTION LABEL ("Graduation Date", "Start date", "Available
    // date"). \bdate\b with word boundaries so "candidate"/"update" don't match.
    const dateWord = /\bdate\b/i;
    const dateHint = /pick.*date|date.*picker|choose.*date|select.*date/i;
    if (type === 'text' || type === 'date') {
      const meta = ph + ' ' + (el.getAttribute('aria-label') || '');
      const lblEarly = labelFor(el);
      if (type === 'date' || dateFmt.test(meta) || dateHint.test(meta) ||
          dateWord.test(lblEarly) || dateWord.test(meta))
        type = 'date';
    }
    let lbl = labelFor(el).slice(0, 200);
    if (type === 'radio' || type === 'checkbox') {
      const q = groupQuestion(el);
      if (q && q.toLowerCase() !== lbl.toLowerCase()) lbl = q + ' — ' + lbl;
    }
    const field = {ref: refFor(el, tag), label: lbl,
                   type: type, is_select: tag === 'select',
                   required: requiredFor(el)};
    if (type === 'date') {
      field.placeholder = ph;
      field.readonly = !!el.readOnly;
    }
    if (tag === 'select') {
      field.options = Array.from(el.options)
        .map(o => o.label || o.text).filter(Boolean).slice(0, MAXOPT);
    }
    out.push(field);
    // Charge the budget once per question: a new group question, or any
    // non-grouped field. Later options of the same group are already counted.
    if (grouped) { if (gkey && !groupKeys.has(gkey)) { groupKeys.add(gkey); questionCount++; } }
    else questionCount++;
  }
  // Ashby (and Snowflake/Notion boards) render boolean questions as a pair of
  // plain <button>Yes</button>/<button>No</button> — no input, no role, no
  // name — so the input scan above never emits them. Detect a container whose
  // interactive children are EXACTLY two buttons reading Yes / No, and emit a
  // boolean field the fill path can click.
  const boolText = (b) => (b.innerText || b.textContent || '').trim().toLowerCase();
  const allButtons = Array.from(document.querySelectorAll('button'));
  const seenGroups = new Set();
  for (const yes of allButtons) {
    // Same question budget as the input scan (each Yes/No pair is one
    // question). The pair scan runs AFTER the input scan, so a starved budget
    // used to drop these boolean widgets first — exactly the required work-auth
    // booleans. With the group-counting cap they get their fair share.
    if (!budget()) break;
    if (boolText(yes) !== 'yes') continue;
    if (!visible(yes)) continue;
    // The nearest ancestor whose only buttons are this Yes plus a sibling No.
    let grp = yes.parentElement, no = null;
    for (let i = 0; i < 5 && grp; i++) {
      const btns = Array.from(grp.querySelectorAll('button'))
        .filter(b => ['yes', 'no'].includes(boolText(b)));
      if (btns.length === 2) {
        no = btns.find(b => boolText(b) === 'no') || null;
        if (no) break;
      }
      if (grp.querySelectorAll('button').length > 2) break;  // not a Yes/No pair
      grp = grp.parentElement;
    }
    if (!no || seenGroups.has(grp)) continue;
    seenGroups.add(grp);
    const q = questionFor(yes) ||
              (grp && grp.innerText || '').trim().replace(/\s*yes\s*no\s*$/i, '');
    const idx = allButtons.indexOf(yes) + 1;   // page-wide, DOM order
    // Required if the group flags aria-required, shows a literal asterisk in
    // its text, or renders one via a ::after pseudo-element (CSS-injected "*").
    const req = !!grp && ((grp.getAttribute('aria-required') === 'true') ||
                          /[*✱∗]/.test((q || '')) ||
                          (!!grp && pseudoAsterisk(grp)) || asteriskNear(yes));
    out.push({ref: `:nth-match(button, ${idx})`,
              label: (q || '').slice(0, 200),
              type: 'boolean', is_select: false, options: ['Yes', 'No'],
              required: req});
    questionCount++;               // each Yes/No pair is one question
  }
  return out;
}
""" % (MAX_FIELDS, MAX_OPTIONS)  # noqa: UP031 - JS body is full of { }, so
# %-formatting is the only interpolation that doesn't need every brace doubled.


def _extract_fields(page: Page) -> list[dict]:
    try:
        return page.evaluate(_EXTRACT_JS) or []
    except Exception as exc:
        log.warning("agent form extraction failed: %s", exc)
        return []


# Count the raw candidate controls (inputs/textareas/selects/buttons) cheaply,
# without the full extraction pass, so we can watch the number settle.
_FIELD_COUNT_JS = (
    "() => document.querySelectorAll("
    "'input, textarea, select, button').length")


def _wait_for_form_stable(page: Page, *, settle_ms: int = 700,
                          max_ms: int = 9000, poll_ms: int = 250) -> None:
    """Block until the candidate-field count stops changing before the FIRST
    extraction. A fixed sleep raced remote/Browserbase SPA renders — Palantir's
    Lever form had only 9 of 61+ fields present at extract time, and the later
    reveal rounds never recovered the rest (they diff against what the first
    extract saw, so fields that were simply late are treated as pre-existing).
    Poll the count and return once it is unchanged for `settle_ms`, capped at
    `max_ms` total. Best-effort: any error just returns (extraction proceeds)."""
    import time
    deadline = time.monotonic() + max_ms / 1000.0
    last = -1
    stable_since = time.monotonic()
    while time.monotonic() < deadline:
        try:
            count = int(page.evaluate(_FIELD_COUNT_JS) or 0)
        except Exception:
            return
        now = time.monotonic()
        if count != last:
            last = count
            stable_since = now
        elif (now - stable_since) * 1000.0 >= settle_ms and count > 0:
            return
        try:
            page.wait_for_timeout(poll_ms)
        except Exception:
            return


def _attach_resume(page: Page, resume_path: Path) -> bool:
    try:
        file_inputs = page.query_selector_all("input[type=file]")
    except Exception:
        return False
    if not file_inputs or not resume_path or not Path(resume_path).exists():
        return False
    try:
        file_inputs[0].set_input_files(str(resume_path))
        return True
    except Exception as exc:
        log.warning("agent resume attach failed: %s", exc)
        return False


# ------------------------------------------------ pure read-back verification
# The non-text set paths (select / radio / checkbox / boolean button-pair /
# combobox) used to be fire-and-hope: a select_option/check/click that silently
# selected nothing (or the wrong option) still counted as "filled", inflating
# the filled-count and hiding gaps from the human reviewer. Each set now reads
# the control's landed state back and classifies as filled ONLY when the choice
# verifiably stuck. The comparisons live in these small pure helpers so they
# unit-test without a browser; the browser side just reads the value/flag.

def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip()).casefold()


def _labels_equivalent(a: str, b: str) -> bool:
    """Whether two option labels denote the same choice, tolerant of the
    whitespace/case reflow a widget applies when it echoes the selection back
    (and of one being a clean substring of the other, e.g. "Yes" vs "Yes ✓")."""
    na, nb = _norm(a), _norm(b)
    if not na or not nb:
        return False
    return na == nb or na in nb or nb in na


def _selection_verified(chosen: str, want: str, options: list[str] | None) -> bool:
    """True when `chosen` (the option actually selected in a <select>) is the
    one we intended for `want`. We accept either a direct label match or the
    option that `match_option` would map `want` onto (selects are filled by
    label, but the answer value can be a canonical form like "Yes" mapped onto
    an option worded "I am authorized")."""
    if _labels_equivalent(chosen, want):
        return True
    mapped = match_option(want, list(options or []))
    if not mapped:
        return False
    return _labels_equivalent(chosen, mapped)


def _combobox_verified(displayed: str, clicked_option: str) -> bool:
    """True when a combobox's displayed value reflects the option we clicked.
    react-select renders the chosen label into the control; an empty display
    means the click selected nothing (the old blind-Enter false success)."""
    return _labels_equivalent(displayed, clicked_option)


def _select_label(loc) -> str:
    """The currently-selected <select> option's visible label (best-effort)."""
    try:
        return (loc.evaluate(
            "el => { const o = el.selectedOptions && el.selectedOptions[0];"
            " return o ? (o.label || o.text || '') : ''; }") or "").strip()
    except Exception:
        return ""


def _set_field(page: Page, ref: str, field: dict, value: str) -> bool:
    """Set one field robustly. Scroll into view, fill/select/check, and VERIFY
    the choice landed for EVERY type (Ashby's long SPA forms drop fills that
    aren't scrolled in; a select/check that selects nothing must not count as
    filled). The scraped ref sometimes points at a wrapper, not the real
    <input>, so we also try locating by the field's label text."""
    ftype = field.get("type")
    is_select = field.get("is_select") or ftype == "select"
    label = (field.get("label") or "").strip()
    options = field.get("options") or []

    locators = [lambda: page.locator(ref).first]
    if label:                                    # label fallback for bad refs
        rx = re.compile(re.escape(label[:50]), re.I)
        locators.append(lambda: page.get_by_label(rx).first)

    for make in locators:
        try:
            loc = make()
            try:
                loc.scroll_into_view_if_needed(timeout=2000)
            except Exception:
                pass
            if ftype in ("radio", "checkbox"):
                loc.check(timeout=2000)
                if loc.is_checked(timeout=2000):     # read-back: did it stick?
                    return True
                continue
            if is_select:
                loc.select_option(label=value, timeout=2000)
                if _selection_verified(_select_label(loc), value, options):
                    return True
                continue
            loc.fill(value, timeout=2500)
            # Commit before read-back: masked/parsing widgets (some ATS date &
            # numeric inputs) accept a fill() but REPARSE or CLEAR the value on
            # blur, so reading input_value() while still focused can confirm a
            # value that vanishes a moment later (a required field then ends up
            # empty but counted filled). Blur, then read the LANDED value.
            try:
                loc.blur(timeout=1000)
            except Exception:
                pass
            if (loc.input_value(timeout=2000) or "").strip() == value.strip():
                return True
        except Exception:
            continue
    return False


_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7,
    "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}


def _parse_date(value: str) -> tuple[int, int, int] | None:
    """Parse a date answer into (year, month, day). Accepts the answer-book
    forms we actually store — ISO "2027-05-10", "05/10/2027", "May 2027"
    (day defaults to 1), "May 10, 2027". Returns None when no year is found, so
    a vague answer leaves the picker honestly unfilled rather than guessing."""
    if not value:
        return None
    v = value.strip()
    m = re.search(r"\b(19|20)\d{2}\b", v)
    if not m:
        return None
    year = int(m.group(0))
    # ISO / slash / dot / dash numeric: y-m-d or m/d/y (US), disambiguated by
    # where the 4-digit year sits.
    iso = re.match(r"^\s*(\d{4})[\-/.](\d{1,2})[\-/.](\d{1,2})\s*$", v)
    if iso:
        return year, int(iso.group(2)), int(iso.group(3))
    mdy = re.match(r"^\s*(\d{1,2})[\-/.](\d{1,2})[\-/.](\d{2,4})\s*$", v)
    if mdy:
        return year, int(mdy.group(1)), int(mdy.group(2))
    # Month name anywhere ("May 2027", "May 10, 2027", "10 May 2027").
    mon = re.search(r"[A-Za-z]{3,}", v)
    month = _MONTHS.get(mon.group(0)[:3].lower()) if mon else None
    if month is None:
        return None
    day_m = re.search(r"\b(\d{1,2})\b(?!\d)", re.sub(r"\b(19|20)\d{2}\b", "", v))
    day = int(day_m.group(1)) if day_m else 1
    if not (1 <= day <= 31):
        day = 1
    return year, month, day


def _format_date(ymd: tuple[int, int, int], placeholder: str) -> str:
    """Render (year, month, day) in the format the placeholder advertises
    (default US MM/DD/YYYY). A native <input type=date> always wants ISO."""
    y, m, d = ymd
    ph = (placeholder or "").lower()
    sep = "/"
    for s in ("/", "-", "."):
        if s in ph:
            sep = s
            break
    if re.search(r"y{4}.*m{1,2}.*d{1,2}", ph):            # YYYY-MM-DD
        return f"{y:04d}{sep}{m:02d}{sep}{d:02d}"
    if re.search(r"d{1,2}.*m{1,2}.*y", ph):               # DD/MM/YYYY
        return f"{d:02d}{sep}{m:02d}{sep}{y:04d}"
    return f"{m:02d}{sep}{d:02d}{sep}{y:04d}"             # MM/DD/YYYY (default)


def _set_date(page: Page, ref: str, field: dict, value: str) -> bool:
    """Fill a date-picker input. Parse the answer, format it per the field's
    placeholder, and type it with REAL keystrokes (calendar widgets ignore a
    programmatic fill()). Verify the value stuck, then press Escape so any open
    calendar overlay can't swallow later clicks. A native <input type=date>
    takes an ISO fill() directly. Readonly / calendar-only inputs that reject
    typing are left unfilled (honest failure)."""
    ymd = _parse_date(value)
    if ymd is None:
        return False
    try:
        loc = page.locator(ref).first
        loc.scroll_into_view_if_needed(timeout=2000)
    except Exception:
        return False

    # Native date input: ISO fill() is the reliable path.
    try:
        if (loc.get_attribute("type") or "").lower() == "date":
            iso = f"{ymd[0]:04d}-{ymd[1]:02d}-{ymd[2]:02d}"
            loc.fill(iso, timeout=2000)
            if (loc.input_value(timeout=1500) or "") == iso:
                return True
    except Exception:
        pass

    formatted = _format_date(ymd, field.get("placeholder", ""))
    typed_ok = False
    try:
        loc.click(timeout=2000)
        try:
            loc.fill("", timeout=1000)                    # clear any prior text
        except Exception:
            pass
        loc.press_sequentially(formatted, timeout=3000)
        typed_ok = True
    except Exception:
        typed_ok = False

    # Dismiss any calendar overlay so it can't intercept subsequent clicks.
    try:
        page.keyboard.press("Escape")
    except Exception:
        pass

    if not typed_ok:
        return False
    try:
        got = (loc.input_value(timeout=1500) or "")
    except Exception:
        got = ""
    # Accept if the typed digits landed (widgets may reformat separators, or
    # the calendar may echo the ISO form — compare on digits only).
    return bool(got) and re.sub(r"\D", "", got) == re.sub(r"\D", "", formatted)


# The attributes an Ashby/Radix-style toggle button flips to advertise that it
# is the selected one. Read back after a click so a no-op click (nothing became
# pressed) is NOT reported as filled. None of these being present is treated as
# "cannot verify" -> unfilled (fail honest), since these widgets have no
# input/checked flag to fall back on.
def _button_pressed(loc) -> bool | None:
    """Whether a toggle button reads as the selected one. Returns True/False, or
    None when the widget exposes no selection signal at all (unverifiable)."""
    try:
        state = loc.evaluate(
            "el => ({ pressed: el.getAttribute('aria-pressed'),"
            " checked: el.getAttribute('aria-checked'),"
            " selected: el.getAttribute('aria-selected'),"
            " data: el.getAttribute('data-state') })")
    except Exception:
        return None
    if not isinstance(state, dict):
        return None
    truthy = {"true", "on", "checked", "active", "selected"}
    signals = [state.get(k) for k in ("pressed", "checked", "selected", "data")]
    present = [s for s in signals if s is not None]
    if not present:
        return None
    return any(str(s).strip().lower() in truthy for s in present)


def _set_boolean(page: Page, ref: str, value: str) -> bool:
    """Click the Yes/No button matching `value` in an Ashby-style button-pair
    boolean widget. `ref` points at the Yes button; for "No" we click its
    sibling No button. Only Yes/No are valid — anything else fails honestly so
    an unresolved answer leaves the field untouched (never a blind click).

    After the click we read the button's pressed/selected attribute back when it
    exposes one, so a click that toggled nothing is not counted as filled. When
    the widget exposes NO selection signal (plain <button> with no aria/data
    state) the click itself is taken as success - there is nothing to verify
    against, and requiring a signal would drop every honest plain-button pair."""
    want = (value or "").strip().lower()
    if want not in ("yes", "no"):
        return False
    try:
        yes = page.locator(ref).first
        yes.scroll_into_view_if_needed(timeout=2000)
    except Exception:
        return False
    if want == "yes":
        try:
            yes.click(timeout=2000)
        except Exception:
            return False
        return _button_pressed(yes) is not False
    # "No" — click the sibling No button of THIS pair. Anchor on the nearest
    # ancestor that CONTAINS a No button: with per-button wrappers the nearest
    # button-having ancestor holds only the Yes, and any page-wide "No" search
    # could answer a DIFFERENT question on forms with several Yes/No groups
    # (work-auth + sponsorship + relocate). No cross-group fallback: failing
    # honestly beats clicking another group's No.
    try:
        no = yes.locator(
            "xpath=ancestor::*[.//button["
            "normalize-space(translate(., 'NO', 'no'))='no']][1]"
            "//button[normalize-space(translate(., 'NO', 'no'))='no']").first
        no.click(timeout=2000)
    except Exception:
        return False
    return _button_pressed(no) is not False


def _visible_combobox_options(page: Page) -> dict[str, Any]:
    """Visible dropdown options right now, as {text: locator}. Visibility is
    established BEFORE the MAX_OPTIONS cap: Greenhouse job boards embed an
    intl-tel-input country list of ~244 HIDDEN [role=option] nodes early in the
    DOM, so capping the raw page-wide match at 30 never reaches the open menu's
    real (visible) options. We collect the visible refs in ONE evaluate_all
    round-trip (cheap even for 250+ nodes), then cap the VISIBLE set."""
    out: dict[str, Any] = {}
    try:
        opts = page.locator("[role=option]")
        # Playwright's ":visible" filters by layout in the browser, so the cap
        # applies to only the visible subset — the hidden decoys are excluded
        # before we count. Scope to the open menu when one is present.
        vis_idx = opts.evaluate_all(
            """els => els.map((el, i) => {
                 const r = el.getBoundingClientRect();
                 const s = getComputedStyle(el);
                 return (r.width > 0 && r.height > 0 &&
                         s.visibility !== 'hidden' && s.display !== 'none')
                        ? i : -1;
               }).filter(i => i >= 0)""")
        for i in vis_idx[:MAX_OPTIONS]:
            o = opts.nth(i)
            try:
                txt = (o.inner_text(timeout=500) or "").strip()
                if txt and txt not in out:
                    out[txt] = o
            except Exception:
                continue
    except Exception:
        pass
    return out


def _open_and_filter_combobox(page: Page, loc, query: str) -> dict[str, Any]:
    """Focus the combobox and type `query` with REAL keystrokes — programmatic
    fill() sets the value without the key events these widgets listen on
    (Ashby's autocomplete stays closed on fill). Returns the visible options."""
    try:
        loc.click(timeout=2000)
        loc.fill("", timeout=1500)                  # clear any previous filter
        if query:
            loc.press_sequentially(query, timeout=2500)
    except Exception:
        try:
            page.keyboard.type(query)
        except Exception:
            return {}
    page.wait_for_timeout(400)
    return _visible_combobox_options(page)


def _combobox_display(page: Page, loc) -> str:
    """The value a combobox now shows after a selection.

    Ashby echoes the chosen label into the input's own value, so that is the
    first (cheapest) check. react-select does NOT: it clears the <input> and
    renders the label into a sibling `.select__single-value`. Worse, the input
    itself carries class `select__input` AND role=combobox, so the old
    `el.closest('[class*=select],[role=combobox]')` matched the INPUT and read
    its empty innerText — every Greenhouse selection came back '' and counted
    unfilled (re-query churn + false gate-block) while the page plainly showed
    the choice. So: search the container from el.parentElement (never self when
    self is the input), prefer a `[class*=single-value]` descendant's text, and
    fall back to a bounded ancestor climb until non-empty."""
    try:
        v = (loc.input_value(timeout=1000) or "").strip()
        if v:
            return v
    except Exception:
        pass
    # The JS: search the widget container from el.parentElement (so closest()
    # can't return the react-select input itself — class select__input +
    # role=combobox would otherwise match); prefer a single-value descendant's
    # text (react-select renders the chosen label there); else a bounded
    # ancestor climb until non-empty (plainer custom dropdowns).
    try:
        return (loc.evaluate(
            "el => {"
            "  const isInput = el.tagName === 'INPUT' ||"
            "                  el.tagName === 'TEXTAREA';"
            "  const start = isInput ? (el.parentElement || el) : el;"
            "  const box = start.closest("
            "     '[class*=control],[class*=select],[role=listbox],[role=combobox]')"
            "     || el.parentElement || el;"
            "  const sv = box.querySelector && box.querySelector("
            "     '[class*=single-value],[class*=singleValue]');"
            "  if (sv) { const t = (sv.innerText || '').trim(); if (t) return t; }"
            "  let n = box;"
            "  for (let i = 0; i < 4 && n; i++) {"
            "    const t = (n.innerText || '').trim();"
            "    if (t) return t;"
            "    n = n.parentElement;"
            "  }"
            "  return '';"
            "}") or "").strip()
    except Exception:
        return ""


def _click_and_verify_option(page: Page, loc, options: dict, target: str) -> bool:
    """Click the matched option and confirm the combobox now displays it; a
    click that selected nothing (menu closed on an empty control) must not
    report success."""
    try:
        options[target].click(timeout=2000)
    except Exception:
        return False
    return _combobox_verified(_combobox_display(page, loc), target)


def _set_combobox(page: Page, loc, value: str) -> bool:
    """Drive a react-select/custom dropdown: open, type to filter, then CLICK
    the visible option that best matches `value`, and VERIFY the control now
    displays it. Blind Enter used to report success even when the filter matched
    no option and nothing got selected (custom option sets, e.g. "How did you
    hear about this role?"). The full value can over-filter, so retry with just
    the first word, then with the unfiltered menu (some only open on ArrowDown);
    if no option matches (or the click didn't land), fail honestly - an unfilled
    field beats a silently-empty one."""
    queries = [value]
    first_word = value.split()[0] if value.split() else ""
    if first_word and first_word != value:
        queries.append(first_word)
    for query in queries:
        options = _open_and_filter_combobox(page, loc, query)
        target = match_option(value, list(options)) if options else None
        if target is None:
            continue
        if _click_and_verify_option(page, loc, options, target):
            return True
    # Last resort: enumerate the unfiltered menu (opens on ArrowDown even for
    # widgets that ignore typing) and match against the full option set.
    options = _enumerate_combobox_options(page, loc)
    target = match_option(value, list(options)) if options else None
    if target is None:
        return False
    return _click_and_verify_option(page, loc, options, target)


def _enumerate_combobox_options(page: Page, loc) -> dict[str, Any]:
    """The combobox's FULL menu as {text: locator}: clear any filter, then
    ArrowDown (opens the menu even for widgets that ignore typing)."""
    _open_and_filter_combobox(page, loc, "")
    try:
        loc.press("ArrowDown", timeout=1500)
    except Exception:
        return {}
    page.wait_for_timeout(400)
    return _visible_combobox_options(page)


_PICK_INSTRUCTIONS = """\
You are filling out a job application form. For each dropdown below, pick the
option that best expresses the applicant's desired answer.

Output a JSON array of objects, one per dropdown you can resolve:
  {{"ref": "<copy the dropdown's ref exactly>", "option": "<EXACTLY one of its options>"}}
- Prefer the closest semantic match even when the wording differs
  (e.g. desired "Company website" -> option "Acme Careers").
- OMIT a dropdown when no option reasonably expresses the desired answer.

Dropdowns:
{fields}
"""


def _pick_combobox_options_llm(pending: list[dict], llm_cfg: dict | None,
                               call: Callable[[str, str, str, str], str] | None = None,
                               ) -> dict[str, str]:
    """Resolve {ref: option} for comboboxes whose desired answer matched none
    of the option labels lexically ("Company website" vs "Cohere Careers").
    The LLM only picks among the REAL option labels; the click stays
    mechanical. Never raises; any problem returns {} (fields stay unfilled)."""
    llm_cfg = llm_cfg or {}
    if call is None:
        provider = llm_mod.provider_of(llm_cfg) if llm_cfg else ""
        call = llm_mod._PROVIDERS.get(provider) if llm_cfg else None
    if not llm_cfg or call is None:
        log.info("auto-apply agent: LLM option pick OFF - no llm/resume_llm "
                 "block in the user yaml; matching stays lexical")
        return {}
    key_env = llm_mod.api_key_env_for(llm_cfg)
    try:
        api_key = os.environ[key_env]
    except KeyError:
        log.info("auto-apply agent: LLM option pick OFF - set %s to enable "
                 "it; matching stays lexical", key_env)
        return {}
    provider = llm_mod.provider_of(llm_cfg)
    model = llm_cfg.get("model") or llm_mod.DEFAULT_MODEL.get(provider, "")
    payload = [{"ref": p["ref"], "question": p.get("label", ""),
                "desired_answer": p.get("value", ""),
                "options": p.get("options", [])} for p in pending]
    user_msg = _PICK_INSTRUCTIONS.format(
        fields=json.dumps(payload, ensure_ascii=False, indent=1))
    try:
        items = llm_mod.parse_json_array(call(model, _SYSTEM, user_msg, api_key))
    except Exception as exc:
        log.warning("combobox option pick failed (%s)", exc)
        return {}
    allowed = {p["ref"]: set(p.get("options", [])) for p in pending}
    out: dict[str, str] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        ref, option = item.get("ref"), item.get("option")
        if (isinstance(ref, str) and isinstance(option, str)
                and ref in allowed and option in allowed[ref]):
            out[ref] = option                   # no hallucinated options
    return out


def _fill_combobox_field(page: Page, ref: str, value: str,
                         ) -> tuple[bool, list[str]]:
    """Fill one combobox; on a no-lexical-match failure also return the full
    option list so the LLM pass can pick among the real labels."""
    try:
        loc = page.locator(ref).first
        loc.scroll_into_view_if_needed(timeout=2000)
    except Exception:
        return False, []
    if _set_combobox(page, loc, value):
        return True, []
    options = list(_enumerate_combobox_options(page, loc))
    try:
        page.keyboard.press("Escape")               # leave the menu closed
    except Exception:
        pass
    return False, options


def _apply_mapping(page: Page, form_fields: list[dict],
                   mapping: dict[str, str], llm_cfg: dict | None = None,
                   ) -> tuple[list[str], list[str]]:
    """Fill each mapped field mechanically. Returns (filled refs, unfilled refs).

    Comboboxes get a second chance: when the desired answer matches none of the
    option labels lexically, ONE extra LLM call picks the semantically-right
    label among the options collected from the open menu."""
    by_ref = {f["ref"]: f for f in form_fields if f.get("ref")}
    filled: list[str] = []
    unfilled: list[str] = []
    pending: list[dict] = []
    for ref, value in mapping.items():
        field = by_ref.get(ref)
        if field is None:
            unfilled.append(ref)
        elif field.get("type") == "boolean":
            (filled if _set_boolean(page, ref, value) else unfilled).append(ref)
        elif field.get("type") == "date":
            (filled if _set_date(page, ref, field, value) else unfilled).append(ref)
        elif field.get("type") == "combobox":
            ok, options = _fill_combobox_field(page, ref, value)
            if ok:
                filled.append(ref)
            elif options:
                pending.append({"ref": ref, "label": field.get("label", ""),
                                "value": value, "options": options})
            else:
                unfilled.append(ref)
        elif _set_field(page, ref, field, value):
            filled.append(ref)
        else:
            unfilled.append(ref)

    if pending:
        picks = _pick_combobox_options_llm(pending, llm_cfg)
        for item in pending:
            ref, option = item["ref"], picks.get(item["ref"])
            ok = False
            if option:
                try:
                    ok = _set_combobox(page, page.locator(ref).first, option)
                except Exception:
                    ok = False
            (filled if ok else unfilled).append(ref)
    return filled, unfilled


_MAX_REVEAL_ROUNDS = 2


def _question_key(field: dict) -> tuple[str, str] | None:
    """A ref-independent identity for a field: its QUESTION text (option suffix
    stripped for grouped fields) plus type. Used to recognise a field the reveal
    round re-emits under a DIFFERENT synthetic ref after the DOM shifted indices
    (a resume upload pushes every page-wide :nth-match(button, N) index by +1, so
    the same Yes/No pairs reappear as "new" fields). Returns None when there is
    no usable question text to key on (then we fall back to ref-only dedup)."""
    label = (field.get("label") or "").strip()
    if not label:
        return None
    if field.get("type") in ("radio", "checkbox") and " — " in label:
        label = label.split(" — ", 1)[0].strip()
    return (_norm(label), field.get("type") or "")


def _fill_revealed_fields(page: Page, seen_fields: list[dict],
                          profile: ApplyProfile, llm_cfg: dict | None,
                          ) -> tuple[list[str], list[str], list[dict]]:
    """Fill fields that only APPEAR after earlier answers (conditional reveals).

    Greenhouse's EEO block injects "Please identify your race" only once "Are
    you Hispanic/Latino?" has a value; Ashby reveals dependent questions the same
    way. Such a field is absent from the first `_extract_fields`, so it never
    enters the mapping and is left blank. Re-extract, diff against everything
    seen so far (by ref AND by question identity), and map/fill the newcomers —
    bounded to a couple of rounds so a form that keeps revealing can't loop
    forever.

    The question-identity diff (not ref alone) matters because a resume upload
    (or any DOM mutation) shifts page-wide :nth-match(button, N) indices, so the
    SAME already-filled Yes/No pairs re-appear under new refs. Keying on
    (question, type) skips them — otherwise they get re-clicked and inflate the
    filled count (and a bigger shift could misclick a different control).

    Also returns the fresh field descriptors so the submit gate can see a
    revealed REQUIRED field that stayed unfilled."""
    known = {f.get("ref") for f in seen_fields if f.get("ref")}
    known_questions = {qk for f in seen_fields
                       if (qk := _question_key(f)) is not None}
    filled: list[str] = []
    unfilled: list[str] = []
    revealed: list[dict] = []
    for _ in range(_MAX_REVEAL_ROUNDS):
        try:
            page.wait_for_timeout(400)                # let the reveal render
        except Exception:
            pass
        current = _extract_fields(page)
        fresh = []
        for f in current:
            ref = f.get("ref")
            if not ref or ref in known:
                continue
            qk = _question_key(f)
            if qk is not None and qk in known_questions:
                # Same question re-emitted under a shifted ref — already handled.
                known.add(ref)
                continue
            fresh.append(f)
        if not fresh:
            break
        for f in fresh:
            known.add(f["ref"])
            qk = _question_key(f)
            if qk is not None:
                known_questions.add(qk)
        revealed.extend(fresh)
        mapping, _ = map_fields(fresh, profile, llm_cfg)
        got, missed = _apply_mapping(page, fresh, mapping, llm_cfg=llm_cfg)
        filled.extend(got)
        unfilled.extend(missed)
        # A field we never produced a value for is unfilled for the human.
        for f in fresh:
            if f["ref"] not in mapping:
                unfilled.append(f["ref"])
    return filled, unfilled, revealed


# ------------------------------------------------------- submit gate (pure)

def _field_label(field: dict) -> str:
    """Human-facing label for a field, falling back to its ref."""
    return (field.get("label") or "").strip() or str(field.get("ref") or "")


def _report_label(field: dict) -> str:
    """The label to SHOW for an unfilled field. Radio/checkbox OPTIONS carry a
    "Question — Option" label (groupQuestion + option text); report them at the
    QUESTION level so a fully-answered EEO block doesn't list every unpicked
    option ("Race — White", "Race — Asian", ...) as 13 separate "unfilled"
    lines. All other types keep their own label."""
    label = _field_label(field)
    if field.get("type") in ("radio", "checkbox") and " — " in label:
        return label.split(" — ", 1)[0].strip() or label
    return label


def _answered_group_labels(form_fields: list[dict], filled_refs) -> set[str]:
    """Question-level labels of radio/checkbox GROUPS that have at least one
    option filled/selected. A group is ANSWERED as soon as one option is picked,
    so its remaining (unpicked) options must not drag the whole question into the
    unfilled report — the verification run listed Gender/Race/Veteran/sponsorship
    as unfilled while the screenshot showed them all answered. Only grouped
    fields collapse this way; single controls stand on their own filled/unfilled
    state."""
    by_ref = {f.get("ref"): f for f in form_fields if f.get("ref")}
    answered: set[str] = set()
    for ref in filled_refs or ():
        field = by_ref.get(ref)
        if field and field.get("type") in ("radio", "checkbox"):
            answered.add(_report_label(field))
    return answered


def split_unfilled(form_fields: list[dict], unfilled_refs,
                   filled_refs=None) -> tuple[list[str], list[str]]:
    """Split the unfilled refs into (required labels, optional labels) using the
    extracted `required` flag. Labels (not refs) so the human report is readable;
    deduped, order-stable. Unknown refs (no matching field) count as optional -
    we only ever GATE on a field we positively know is required.

    Radio/checkbox groups collapse to one QUESTION-level label (see
    _report_label): the block decision is unchanged (a required group still
    appears), only the presentation is de-duplicated to the question.

    `filled_refs` (optional) lets a group that ALREADY has an option selected be
    omitted entirely: the unpicked options of an answered group are not real
    gaps, so a fully-answered Gender/Race block should not appear as unfilled."""
    by_ref = {f.get("ref"): f for f in form_fields if f.get("ref")}
    answered = _answered_group_labels(form_fields, filled_refs)
    req: list[str] = []
    opt: list[str] = []
    seen: set = set()          # refs already consumed
    seen_labels: set = set()   # collapsed labels already emitted (per bucket)
    for ref in unfilled_refs:
        if ref in seen:
            continue
        seen.add(ref)
        field = by_ref.get(ref)
        label = _report_label(field) if field else str(ref)
        # A grouped question with any option already selected is answered — drop
        # its leftover unpicked options from the report entirely.
        if (field and field.get("type") in ("radio", "checkbox")
                and label in answered):
            continue
        bucket = req if (field and field.get("required")) else opt
        key = (label, bucket is req)
        if key in seen_labels:          # same question already listed
            continue
        seen_labels.add(key)
        bucket.append(label)
    return req, opt


def gate_block_labels(form_fields: list[dict], unfilled_refs,
                      enabled: bool = True, filled_refs=None) -> list[str]:
    """The list of REQUIRED-field labels that must block submit. Empty when the
    gate is off or nothing required is unfilled - i.e. submit may proceed. This
    is the whole gate decision, kept pure so it unit-tests without a browser.

    A required GROUP with an option already selected is answered (see
    split_unfilled's `filled_refs`) and does NOT block; a genuinely-unanswered
    required group still does."""
    if not enabled:
        return []
    required, _optional = split_unfilled(form_fields, unfilled_refs, filled_refs)
    return required


def _click_submit(page: Page) -> bool:
    for sel in _SUBMIT_SELECTORS:
        try:
            loc = page.locator(sel)
            if loc.count() > 0 and loc.first.is_visible():
                loc.first.click(timeout=1500)
                return True
        except Exception:
            continue
    for name in ("Submit Application", "Submit", "Apply", "Send Application"):
        try:
            loc = page.get_by_role("button", name=re.compile(name, re.I))
            if loc.count() > 0 and loc.first.is_visible():
                loc.first.click(timeout=1500)
                return True
        except Exception:
            continue
    return False


def _confirmation_present(page: Page) -> bool:
    for text in _CONFIRM_TEXTS:
        try:
            if page.get_by_text(re.compile(re.escape(text), re.I)).count() > 0:
                return True
        except Exception:
            pass
    return False


# ------------------------------------------------ post-submit verification
# One confirmation phrase is not enough: a real submission that words its
# success page differently used to be recorded as `error`, and (because the
# queue only re-checked applied/submitted statuses) the SAME job got submitted
# again on the next drain. verify_submission reads several INDEPENDENT in-page
# signals so any one of them proves the post landed; it records WHICH fired so
# the human (and the ledger) can see the basis. The URL comparison and the
# validation-text scan are pure, so they unit-test without a browser.

def _path_of(url: str) -> str:
    """The lower-cased path (+ nothing else) of a URL, for signal matching.
    Drops scheme/host/query/fragment so a stray ?utm= can't read as a move."""
    u = (url or "").split("#", 1)[0].split("?", 1)[0].lower()
    m = re.match(r"^[a-z]+://[^/]+(/.*)?$", u)
    if m:
        return m.group(1) or "/"
    return u


def _url_moved_off_form(before: str, after: str) -> bool:
    """True when the post-submit URL left the application-form path: it either
    reached a known confirmation fragment, or simply no longer carries any
    form/apply segment the pre-submit URL had (back to the board home). A URL
    that changed but still sits under /apply|/application|/form is NOT a move -
    single-page forms swap steps under the same path, so that alone is no proof."""
    b, a = _path_of(before), _path_of(after)
    if not a or a == b:
        return False
    if any(h in a for h in _CONFIRM_URL_HINTS):
        return True
    was_form = any(h in b for h in _FORM_URL_HINTS)
    still_form = any(h in a for h in _FORM_URL_HINTS)
    return was_form and not still_form


def _validation_error_present(page: Page) -> bool:
    for text in _VALIDATION_TEXTS:
        try:
            if page.get_by_text(re.compile(re.escape(text), re.I)).count() > 0:
                return True
        except Exception:
            pass
    return False


def _submit_control_present(page: Page) -> bool:
    """Whether a submit control is still in the DOM. Its disappearance is a
    success signal only when NO validation-error state is showing (the form can
    also re-render without the button while surfacing errors)."""
    for sel in _SUBMIT_SELECTORS:
        try:
            if page.locator(sel).count() > 0:
                return True
        except Exception:
            pass
    for name in ("Submit Application", "Submit", "Send Application"):
        try:
            if page.get_by_role("button",
                                name=re.compile(name, re.I)).count() > 0:
                return True
        except Exception:
            pass
    return False


def verify_submission(page: Page, ctx: ApplyContext) -> tuple[bool, str]:
    """Decide whether a just-clicked submit actually posted. Returns
    (confirmed, signal_name) where signal is the FIRST of these that fired:
      confirmation-text  a success phrase is on the page,
      url-moved          the URL left the application-form path,
      submit-gone        the submit control vanished with no validation error.
    Returns (False, "no-signal") when none fired (still recorded as an attempt
    upstream, so the job is never silently re-submitted)."""
    if _confirmation_present(page):
        return True, "confirmation-text"
    if _url_moved_off_form(ctx.final_url, _safe_url(page)):
        return True, "url-moved"
    if not _submit_control_present(page) and not _validation_error_present(page):
        return True, "submit-gone"
    return False, "no-signal"


def _screenshot(page: Page, ctx: ApplyContext) -> Path | None:
    out_dir = ctx.artifacts_dir
    if out_dir is None:
        return None
    try:
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        safe = (ctx.dedup_key or "agent").replace(":", "_").replace("/", "_")
        shot = out_dir / f"{safe}_agent.png"
        page.screenshot(path=str(shot), full_page=True)
        return shot
    except Exception:
        log.warning("agent screenshot failed", exc_info=True)
        return None


def _confirmation_screenshot(page: Page, ctx: ApplyContext) -> Path | None:
    """Capture the final page as confirmation.png in the run's artifacts dir so
    the user gets one-click visual proof the submission went through."""
    out_dir = ctx.artifacts_dir
    if out_dir is None:
        return None
    try:
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        shot = out_dir / "confirmation.png"
        page.screenshot(path=str(shot), full_page=True)
        return shot
    except Exception:
        log.warning("confirmation screenshot failed", exc_info=True)
        return None


def _repo_rel(path: Path | None) -> str | None:
    """Repo-relative POSIX path for storing in the ledger (falls back to the
    absolute POSIX form when the artifact lives outside the repo tree)."""
    if path is None:
        return None
    try:
        return Path(path).resolve().relative_to(DATA_ROOT).as_posix()
    except Exception:
        return Path(path).as_posix()


def _safe_url(page: Page) -> str:
    try:
        return page.url or ""
    except Exception:
        return ""


# ------------------------------------------------------------------- filler

class AgentFiller:
    """LLM-mapped, mechanically-filled fallback for unknown ATS forms."""

    family = ATSFamily.unknown

    def apply(self, page: Page, ctx: ApplyContext) -> ApplyResult:
        try:
            return self._apply(page, ctx)
        except Exception as exc:                     # last-resort guard
            log.exception("agent filler crashed")
            return ApplyResult(status=ApplyStatus.error, family=self.family,
                               message=f"{type(exc).__name__}: {exc}",
                               final_url=_safe_url(page))

    def _apply(self, page: Page, ctx: ApplyContext) -> ApplyResult:
        # Captcha only blocks unattended submit; autofill fills and pauses, so an
        # ever-present reCAPTCHA badge must not stop us. (Submit re-checks below.)
        if ctx.mode is ApplyMode.submit and has_visible_captcha(page):
            return ApplyResult(status=ApplyStatus.blocked_captcha,
                               family=self.family, message="visible captcha detected",
                               final_url=_safe_url(page))

        # Let the (possibly remote/SPA) form finish rendering before the FIRST
        # extract — poll the candidate-field count until it settles rather than
        # sleeping a fixed interval, so a slow Browserbase render doesn't yield a
        # half-populated form (Palantir Lever: 9 of 61+ fields at extract time).
        _wait_for_form_stable(page)
        form_fields = _extract_fields(page)
        # The URL may be a job posting, not the form — try to open it.
        if not form_fields and advance_to_application_form(page):
            try:
                page.wait_for_timeout(1500)         # let a late SPA form render
            except Exception:
                pass
            _wait_for_form_stable(page)
            form_fields = _extract_fields(page)
        if not form_fields:
            return ApplyResult(status=ApplyStatus.unsupported,
                               family=self.family,
                               message="no fillable form fields found "
                                       "(no application form reachable from this URL)",
                               final_url=_safe_url(page))

        resume_ok = _attach_resume(page, ctx.resume_path)

        llm_cfg = _llm_cfg(ctx.user)
        mapping, notes = map_fields(form_fields, ctx.profile, llm_cfg)
        filled, unfilled_refs = _apply_mapping(page, form_fields, mapping,
                                               llm_cfg=llm_cfg)

        # Conditional fields: answering one question can inject NEW controls the
        # first extract never saw (Greenhouse's EEO "Please identify your race"
        # appears only after "Are you Hispanic/Latino?" is answered; Ashby reveals
        # follow-up questions the same way). Re-extract and fill any field that
        # wasn't present before, bounded to a couple of reveal rounds.
        rev_filled, rev_unfilled, revealed = _fill_revealed_fields(
            page, form_fields, ctx.profile, llm_cfg)
        filled.extend(rev_filled)
        unfilled_refs.extend(rev_unfilled)

        if resume_ok:
            filled.append("resume")

        # Any field we never produced a value for is "unfilled" for the human.
        # `all_fields` (initial + conditionally-revealed) is what the gate and
        # the required/optional split consult for each unfilled ref's label and
        # required flag.
        all_fields = form_fields + revealed
        mapped = set(mapping)
        for f in form_fields:
            ref = f.get("ref")
            if ref and ref not in mapped:
                unfilled_refs.append(ref)

        message = "; ".join(notes)
        required_missing, optional_missing = split_unfilled(all_fields,
                                                            unfilled_refs, filled)

        if ctx.mode == ApplyMode.autofill:
            shot = _screenshot(page, ctx)
            # Pause-before-submit: surface required vs optional gaps so the human
            # knows which blanks would actually block a submit.
            if required_missing:
                message = (message + "; " if message else "") + \
                    f"required unfilled: {', '.join(required_missing)}"
            return ApplyResult(status=ApplyStatus.filled_paused,
                               family=self.family, message=message,
                               final_url=_safe_url(page),
                               filled_fields=filled,
                               unfilled_fields=sorted(set(optional_missing)) +
                                               sorted(set(required_missing)),
                               screenshot_path=shot)

        # submit mode: fail closed BEFORE clicking when a required field is
        # blank and the gate is on. Detected-required is a lower bound (an
        # undetected required field is not caught here), so the post-submit
        # confirmation check below stays the real proof of success.
        blocking = gate_block_labels(all_fields, unfilled_refs,
                                     enabled=ctx.submit_gate, filled_refs=filled)
        if blocking:
            return ApplyResult(status=ApplyStatus.blocked_incomplete,
                               family=self.family,
                               message="required fields unfilled; not submitting: "
                                       + ", ".join(blocking) + "; " + message,
                               final_url=_safe_url(page),
                               filled_fields=filled,
                               unfilled_fields=sorted(set(blocking)))

        if not _click_submit(page):
            return ApplyResult(status=ApplyStatus.error, family=self.family,
                               message="no submit button found; " + message,
                               final_url=_safe_url(page),
                               filled_fields=filled,
                               unfilled_fields=sorted(set(unfilled_refs)))
        try:
            page.wait_for_load_state("networkidle", timeout=8000)
        except Exception:
            pass

        # The click is done: whatever the confirmation check decides, this job
        # was submitted-or-maybe-submitted, so build the attempt record NOW and
        # let the queue persist it to the permanent ledger. A false-negative
        # confirmation then can never cause a second submission.
        confirmed, signal = verify_submission(page, ctx)
        shot = _confirmation_screenshot(page, ctx)
        final_url = _safe_url(page)
        attempt = {"on": self._today_iso(), "family": self.family.value,
                   "final_url": final_url, "confirmed": confirmed,
                   "signal": signal, "screenshot": _repo_rel(shot)}

        if has_visible_captcha(page):
            # A captcha AFTER the click is ambiguous (the post may or may not
            # have landed), so keep the attempt so we never blindly re-submit.
            return ApplyResult(status=ApplyStatus.blocked_captcha,
                               family=self.family,
                               message="captcha challenge on submit; " + message,
                               final_url=final_url, filled_fields=filled,
                               submit_attempt=attempt)
        if confirmed:
            return ApplyResult(status=ApplyStatus.submitted, family=self.family,
                               message=f"confirmed via {signal}; " + message
                                       if message else f"confirmed via {signal}",
                               final_url=final_url, filled_fields=filled,
                               screenshot_path=shot, submit_attempt=attempt)
        return ApplyResult(status=ApplyStatus.error, family=self.family,
                           message="submitted but no confirmation observed; " + message,
                           final_url=final_url, filled_fields=filled,
                           screenshot_path=shot, submit_attempt=attempt)

    @staticmethod
    def _today_iso() -> str:
        return dt.datetime.now(dt.UTC).date().isoformat()
