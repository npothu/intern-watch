"""Acquire JD text for any Job, automatically.

The manual CLI takes a `--jd` file; the watcher has only a `Job`. This bridges
the gap with a fallback chain (first hit wins) so a matched job can be
tailored with no human paste: in-memory description, Greenhouse content API,
then the jobright info page and a generic scrape of the apply URL, in
whichever order is more likely to succeed -- if `url` is itself a jobright
link the jobright page goes first (as it always has); if `url` is a real
employer link, the scrape goes first and the jobright page (when a
`jobright_id` is available) is only a fallback for employer sites that block
bots. Every tier fails open: an exception or a too-short result just falls
through to the next source, and an all-miss returns None.
"""

from __future__ import annotations

import json
import logging
import re

import httpx

from ..adapters.ats_boards import JD_MAX_CHARS
from ..adapters.jobright_page import _PAGE_UA, fetch_description
from ..normalize import extract_jobright_id, strip_html

log = logging.getLogger(__name__)

# A result shorter than this is almost certainly an empty SPA shell / nav
# chrome, not a real JD — treat it as a miss and try the next source.
MIN_JD_CHARS = 200

# JSON-LD / __NEXT_DATA__ description heuristics for the generic scrape tier.
_NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.S)
_JSON_LD_RE = re.compile(
    r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
    re.S | re.I)
_WS_RE = re.compile(r"\s+")

# Anti-bot / challenge / empty-SPA-shell tells. A 403 already raises, but many
# blockers serve a 200 with one of these instead of the JD — building a resume
# from "Access Denied" would be worse than reporting no JD (the user can then
# paste it). Checked against the raw HTML head, where these markers sit.
_BLOCKED_RE = re.compile(
    r"access denied|don.?t have permission|request (?:was )?blocked|"
    r"are you (?:a )?(?:human|robot)|verify you are human|captcha|"
    r"unusual traffic|enable javascript to|please enable js|forbidden",
    re.I)

# The full-body scrape fallback (used only when no structured description was
# found) has no guarantee the visible text is actually a JD -- a script-heavy
# page whose hydration payload leaked past strip_html's script/style/noscript
# strip (or any other JS/serialized-data debris left in the body) can still
# clear MIN_JD_CHARS. _looks_like_jd rejects text that reads like JS rather
# than prose, so an honest miss (fall through to the next tier) beats a JD
# built from tracker script or framework internals.
_JS_TOKEN_RE = re.compile(
    r"function\s*\(|=>|\bwindow\.|\bdocument\.|\bvar\s+\w|__next|null,\s*\{|"
    r'\\+"\$',
    re.I)
_JD_MARKER_RE = re.compile(
    r"responsibilit|qualification|requirement|you will|we are looking|"
    r"experience\s+(?:in|with)|degree",
    re.I)
# Tokens-per-1000-chars above this, with no JD marker present, reads as JS.
_JS_TOKEN_DENSITY_THRESHOLD = 2.0


def _looks_like_jd(text: str) -> bool:
    """True unless `text` reads like JavaScript/serialized-data debris rather
    than job-description prose: a JD marker anywhere is enough to keep it;
    otherwise a high density of JS/serialization tokens rejects it."""
    if _JD_MARKER_RE.search(text):
        return True
    if not text:
        return True
    density = len(_JS_TOKEN_RE.findall(text)) / (len(text) / 1000)
    return density < _JS_TOKEN_DENSITY_THRESHOLD


def _ok(text: str | None) -> str | None:
    """Capped, whitespace-collapsed text if it clears MIN_JD_CHARS, else None."""
    if not text:
        return None
    text = _WS_RE.sub(" ", text).strip()[:JD_MAX_CHARS]
    return text if len(text) >= MIN_JD_CHARS else None


# -- ATS public-API tier (mirror of convex/jd_acquire.ts; keep in lockstep) --

_WORKDAY_HOST_RE = re.compile(r"\.wd\d+\.myworkdayjobs\.com$")
# <pod>.fa.<dc>.oraclecloud.com and fa-<x>-saasfaprod1.fa.ocs.oraclecloud.com
_ORACLE_HOST_RE = re.compile(r"^[a-z0-9-]+\.fa(?:\.[a-z0-9-]+)*\.oraclecloud\.com$")
# [/hcmUI/CandidateExperience]/<lang>[/sites/<site>]/job/<id>
_ORACLE_PATH_RE = re.compile(
    r"^(/hcmUI/CandidateExperience)?/[a-z]{2}(?:[-_][A-Za-z]{2})?/"
    r"(?:sites/([A-Za-z0-9_]+)/)?(?:requisitions/preview|job)/(\d+)(?:/|$)")
_ORACLE_POD_RE = re.compile(
    r"\b([a-z0-9-]+\.fa(?:\.[a-z0-9-]+)*\.oraclecloud\.com)\b", re.I)
_PHENOM_DDO_RE = re.compile(r"phApp\.ddo\s*=\s*\{")
_CRAWLER_UA = "Mozilla/5.0 (compatible; intern-baddie/1.0)"


def _oracle_api_url(host: str, site: str | None, job_id: str) -> str:
    """Oracle Recruiting Cloud's public requisition-detail feed (the one its
    CandidateExperience page calls). siteNumber is optional; only the quotes
    are escaped -- the finder's `;` `,` `=` stay literal."""
    finder = f"ById;Id=%22{job_id}%22" + (f",siteNumber={site}" if site else "")
    return (f"https://{host}/hcmRestApi/resources/latest/"
            "recruitingCEJobRequisitionDetails?expand=all&onlyData=true"
            f"&finder={finder}")


def _oracle_api_from_page(url: str, html: str) -> tuple[str, str] | None:
    """Oracle CX on a custom domain (careers.<employer>.com/en/sites/<site>/
    job/<id>): the fetched page names its oraclecloud pod."""
    try:
        path = httpx.URL(url).path
    except Exception:  # noqa: BLE001
        return None
    m = _ORACLE_PATH_RE.match(path)
    if not m or not m[2]:
        return None
    pod = _ORACLE_POD_RE.search(html)
    if not pod or not _ORACLE_HOST_RE.match(pod[1].lower()):
        return None
    return ("oracle", _oracle_api_url(pod[1].lower(), m[2], m[3]))


def _page_fetch_url(url: str) -> str:
    """The URL whose HTML carries the posting: iCIMS wraps the JD in an
    iframe, whose `?in_iframe=1` page is the small one with the JSON-LD."""
    try:
        parsed = httpx.URL(url)
    except Exception:  # noqa: BLE001
        return url
    host = (parsed.host or "").lower()
    if (host.endswith(".icims.com") and re.match(r"^/jobs/\d+(?:/|$)", parsed.path)
            and parsed.params.get("in_iframe") != "1"):
        return str(parsed.copy_set_param("in_iframe", "1"))
    return url


def _ats_api_for(url: str) -> tuple[str, str] | None:
    """(kind, api_url) for a supported ATS posting URL, else None. Pure
    string work; the full-fidelity JD then comes from the ATS's own JSON."""
    try:
        parsed = httpx.URL(url)
    except Exception:  # noqa: BLE001 - malformed URL is just a miss
        return None
    host = parsed.host.lower().removeprefix("www.") if parsed.host else ""
    path = parsed.path.rstrip("/")
    if host.endswith("greenhouse.io"):
        m = re.match(r"^/([^/]+)/jobs/(\d+)", path)
        if m:
            return ("greenhouse",
                    f"https://boards-api.greenhouse.io/v1/boards/{m[1]}/jobs/{m[2]}")
    if host.endswith("lever.co"):
        m = re.match(r"^/([^/]+)/([0-9a-f-]{36})", path, re.I)
        if m:
            return ("lever", f"https://api.lever.co/v0/postings/{m[1]}/{m[2]}")
    if host.endswith("ashbyhq.com"):
        m = re.match(r"^/([^/]+)/([0-9a-f-]{36})", path, re.I)
        if m:
            return (f"ashby:{m[2].lower()}",
                    "https://api.ashbyhq.com/posting-api/job-board/"
                    f"{m[1]}?includeCompensation=false")
    if host.endswith("smartrecruiters.com"):
        m = re.match(r"^/([^/]+)/(\d+)", path)
        if m:
            return ("smartrecruiters",
                    f"https://api.smartrecruiters.com/v1/companies/{m[1]}/postings/{m[2]}")
    if _WORKDAY_HOST_RE.search(host):
        tenant = host.split(".")[0]
        m = re.match(r"^(?:/[a-z]{2}(?:-[A-Za-z]{2})?)?/([^/]+)/job/(.+)$", path)
        if m:
            return ("workday", f"https://{host}/wday/cxs/{tenant}/{m[1]}/job/{m[2]}")
    if host.endswith("workable.com"):
        m = re.match(r"^/([^/]+)/j/([A-Za-z0-9]+)", path)
        if m:
            return ("workable",
                    f"https://apply.workable.com/api/v1/accounts/{m[1]}/jobs/{m[2].upper()}")
    if _ORACLE_HOST_RE.match(host):
        m = _ORACLE_PATH_RE.match(path)
        if m and m[1]:
            return ("oracle", _oracle_api_url(host, m[2], m[3]))
    # Eightfold (<org>.eightfold.ai, Microsoft's apply.careers.microsoft.com;
    # robots.txt allows /api/apply).
    if host.endswith(".eightfold.ai") or host == "apply.careers.microsoft.com":
        m = re.match(r"^/careers/job/(\d+)", path)
        job_id = m[1] if m else (parsed.params.get("pid") if path == "/careers" else None)
        if job_id and job_id.isdigit():
            return ("eightfold", f"https://{host}/api/apply/v2/jobs/{job_id}")
    if host == "jobs.apple.com":
        m = re.match(r"^(?:/[a-z]{2}-[a-z]{2})?/details/([A-Za-z0-9-]+)", path, re.I)
        if m:
            return ("apple", f"https://jobs.apple.com/api/v1/jobDetails/{m[1]}")
    return None


def _join_sections(parts: list[tuple[str, object]]) -> str:
    out = []
    for heading, body in parts:
        text = strip_html(body) if isinstance(body, str) else ""
        if text:
            out.append(f"{heading}\n{text}" if heading else text)
    return "\n\n".join(out)


def _jd_from_ats_payload(kind: str, payload) -> str | None:
    """Full JD text out of an ATS API's JSON payload (jd_acquire.ts twin)."""
    if not isinstance(payload, dict):
        return None
    if kind == "greenhouse":
        return _ok(strip_html(payload.get("content") or ""))
    if kind == "lever":
        parts = [payload.get("descriptionPlain")
                 or strip_html(payload.get("description") or "")]
        for lst in payload.get("lists") or []:
            parts.extend([lst.get("text") or "",
                          strip_html(lst.get("content") or "")])
        parts.append(payload.get("additionalPlain") or "")
        return _ok("\n".join(p for p in parts if p))
    if kind.startswith("ashby:"):
        want = kind.removeprefix("ashby:")
        for j in payload.get("jobs") or []:
            if str(j.get("id", "")).lower() == want:
                return _ok(j.get("descriptionPlain")
                           or strip_html(j.get("descriptionHtml") or ""))
        return None
    if kind == "smartrecruiters":
        sections = (payload.get("jobAd") or {}).get("sections") or {}
        parts = [f"{sec.get('title') or ''}\n{strip_html(sec.get('text') or '')}"
                 for sec in sections.values() if isinstance(sec, dict)]
        return _ok("\n\n".join(parts))
    if kind == "workday":
        info = payload.get("jobPostingInfo") or {}
        return _ok(strip_html(info.get("jobDescription") or ""))
    if kind == "workable":
        parts = [strip_html(payload.get(k) or "")
                 for k in ("description", "requirements", "benefits")]
        return _ok("\n\n".join(p for p in parts if p))
    if kind == "oracle":
        items = payload.get("items") or []
        if not items or not isinstance(items[0], dict):
            return None  # closed, or the wrong site
        it = items[0]
        return _ok(_join_sections([
            ("", it.get("ExternalDescriptionStr")),
            ("Responsibilities", it.get("ExternalResponsibilitiesStr")),
            ("Qualifications", it.get("ExternalQualificationsStr")),
        ]))
    if kind == "eightfold":
        return _ok(strip_html(payload.get("job_description") or ""))
    if kind == "apple":
        inner = payload.get("res")
        res: dict = inner if isinstance(inner, dict) else payload
        return _ok(_join_sections([
            ("Summary", res.get("jobSummary")),
            ("Description", res.get("description")),
            ("Minimum Qualifications", res.get("minimumQualifications")),
            ("Preferred Qualifications", res.get("preferredQualifications")),
        ]))
    return None


def _try_ats_api(client: httpx.Client, url: str, job) -> str | None:
    resolved = _ats_api_for(url)
    if not resolved:
        return None
    kind, api = resolved
    try:
        resp = client.get(api, follow_redirects=True)
        resp.raise_for_status()
        return _jd_from_ats_payload(kind, resp.json())
    except Exception as exc:  # noqa: BLE001 - fall through to next tier
        log.debug("jd_source ats-api miss (%s) for %s: %s",
                  kind, job.dedup_key, exc)
        return None


def _from_greenhouse(client: httpx.Client, jd_url: str) -> str | None:
    """Same call main.enrich_jds makes: Greenhouse content API -> stripped HTML."""
    resp = client.get(jd_url)
    resp.raise_for_status()
    content = resp.json().get("content") or ""
    return strip_html(content)[:JD_MAX_CHARS] or None


def _walk_json_descriptions(obj) -> list[str]:
    """Collect every string under a "description" key, at any depth."""
    found: list[str] = []
    if isinstance(obj, dict):
        for key, val in obj.items():
            if key == "description" and isinstance(val, str):
                found.append(val)
            else:
                found.extend(_walk_json_descriptions(val))
    elif isinstance(obj, list):
        for item in obj:
            found.extend(_walk_json_descriptions(item))
    return found


def _phenom_description(html: str) -> str | None:
    """Phenom career sites server-render the posting into `phApp.ddo = {...}`
    (jobDetail.data.job.description). jd_acquire.ts phenomJob twin."""
    m = _PHENOM_DDO_RE.search(html)
    if not m:
        return None
    try:
        ddo, _ = json.JSONDecoder().raw_decode(html, m.end() - 1)
        job = ddo["jobDetail"]["data"]["job"]
    except Exception:  # noqa: BLE001 - not a Phenom page after all
        return None
    desc = job.get("description") if isinstance(job, dict) else None
    return _ok(strip_html(desc)) if isinstance(desc, str) else None


def _embedded_description(html: str) -> str | None:
    """Prefer a structured `description` from Phenom's phApp.ddo,
    __NEXT_DATA__ or JSON-LD; these carry the JD prose without the page's
    nav/footer chrome."""
    phenom = _phenom_description(html)
    if phenom:
        return phenom
    for pat in (_NEXT_DATA_RE, _JSON_LD_RE):
        for m in pat.finditer(html):
            try:
                data = json.loads(m.group(1))
            except Exception:  # noqa: BLE001 — malformed blob, try the next
                continue
            for desc in _walk_json_descriptions(data):
                # description values are often HTML themselves.
                got = _ok(strip_html(desc))
                if got:
                    return got
    return None


def _generic_scrape(client: httpx.Client, url: str,
                    html_out: list[str] | None = None) -> str | None:
    """Browser-UA GET of an arbitrary apply page. Prefer an embedded
    structured description; else fall back to the full stripped body.
    When `html_out` is given, the fetched page is appended to it even on a
    miss, so the caller's LLM last-resort tier has something to extract
    from."""
    page_url = _page_fetch_url(url)
    # iCIMS's WAF captchas a desktop-Chrome UA that cannot run JS but serves
    # the posting to an honest crawler UA (ingest_node.ts BROWSER_HEADERS).
    ua = _CRAWLER_UA if page_url != url else _PAGE_UA
    resp = client.get(page_url, headers={"User-Agent": ua}, follow_redirects=True)
    resp.raise_for_status()
    # Avature answers bots with an (often empty) HTTP 202 WAF challenge;
    # a 202 is never the posting (ingest_node.ts fetchOnce twin).
    if (getattr(resp, "status_code", 200) == 202
            or (getattr(resp, "headers", None) or {}).get("x-amzn-waf-action")):
        log.debug("jd_source scrape blocked (HTTP 202 challenge): %s", url)
        return None
    html = resp.text
    if html_out is not None:
        html_out.append(html)
    if _BLOCKED_RE.search(html[:2000]):  # a challenge/denial page, not a JD
        log.debug("jd_source scrape blocked (anti-bot/JS shell): %s", url)
        return None
    # Oracle CX on a custom domain: the page names its pod, whose REST feed
    # carries the JD the JS shell never renders server-side.
    hinted = None if _ats_api_for(url) else _oracle_api_from_page(url, html)
    if hinted:
        try:
            api = client.get(hinted[1], follow_redirects=True)
            api.raise_for_status()
            got = _jd_from_ats_payload(hinted[0], api.json())
            if got:
                return got
        except Exception as exc:  # noqa: BLE001 - fall through to the page
            log.debug("jd_source oracle page-hint miss for %s: %s", url, exc)
    embedded = _embedded_description(html)
    if embedded:
        return embedded
    fallback = _ok(strip_html(html))
    if fallback and not _looks_like_jd(fallback):
        log.debug("jd_source scrape rejected (looks like JS, not a JD): %s",
                  url)
        return None
    return fallback


def _try_scrape(client: httpx.Client, url: str, job,
                html_out: list[str] | None = None) -> str | None:
    try:
        return _generic_scrape(client, url, html_out)
    except Exception as exc:  # noqa: BLE001 — fall through to next tier
        log.debug("jd_source scrape miss for %s: %s", job.dedup_key, exc)
        return None


_LLM_EXTRACT_SYSTEM = (
    "You extract job descriptions from raw webpage text. Reply with the "
    "complete job description verbatim - responsibilities, qualifications, "
    "preferred skills, everything - as plain text. No commentary, no "
    "summarizing, no rewording. If the text contains no job description, "
    "reply with exactly NONE.")


def _llm_extract(html: str, llm_cfg: dict | None, job) -> str | None:
    """Last-resort tier: ask the configured LLM to extract the JD from the
    fetched page. Same fail-open contract as every other tier; gated on the
    provider key being present, so a keyless run just skips it."""
    if not html or not llm_cfg:
        return None
    import os as _os

    from ..llm import _PROVIDERS, DEFAULT_MODEL, api_key_env_for, provider_of
    provider = provider_of(llm_cfg)
    call = _PROVIDERS.get(provider)
    api_key = _os.environ.get(api_key_env_for(llm_cfg))
    if call is None or not api_key:
        return None
    page_text = strip_html(html)[:28000]
    if len(page_text) < MIN_JD_CHARS:
        return None
    try:
        model = llm_cfg.get("model") or DEFAULT_MODEL[provider]
        out = (call(model, _LLM_EXTRACT_SYSTEM, page_text, api_key) or "").strip()
    except Exception as exc:  # noqa: BLE001 - extraction is best-effort
        log.debug("jd_source llm-extract miss for %s: %s", job.dedup_key, exc)
        return None
    if out == "NONE":
        return None
    got = _ok(out)
    return got if got and _looks_like_jd(got) else None


def _try_jobright(client: httpx.Client, jobright_id: str, job) -> str | None:
    try:
        return _ok(fetch_description(client, jobright_id))
    except Exception as exc:  # noqa: BLE001 — fall through to next tier
        log.debug("jd_source jobright miss for %s: %s", job.dedup_key, exc)
        return None


def acquire_jd(job, *, client: httpx.Client | None = None,
               allow_scrape: bool = True,
               llm_cfg: dict | None = None,
               employer_url: str | None = None) -> str | None:
    """JD text for a Job, trying (first hit wins): in-memory description,
    the per-job content API named by `jd_url`, the ATS public API resolved
    from the apply URL's shape (Greenhouse/Lever/Ashby/SmartRecruiters/
    Workday CXS/Workable/Oracle CX/Eightfold/Apple -- full-fidelity, no
    scraping), then jobright info
    page and generic scrape of the apply URL -- scrape first when `url` is a
    real employer link, jobright page first when `url` is itself a jobright
    link -- and, when `llm_cfg` carries a keyed provider, LLM extraction from
    the fetched page as the last resort. Returns None if every source
    misses. Uses `client` if given, else makes (and closes) its own.

    `employer_url` is the job's resolved apply/original URL for aggregator
    jobs (jobright: cached in state by delivery, or resolved via the
    authenticated session). When given, it is tried FIRST through the ATS
    API, and its scraped page beats the jobright summary only when it is at
    least as long - short employer pages are nav shells (observed 350-750
    chars from applicantpro/hrmdirect), not postings.
    Mirror of convex/jd_acquire.ts; keep the tier order in lockstep."""
    # Tier 1: already in memory — free, no network.
    got = _ok(job.description)
    if got:
        return got

    # A non-optional local: every tier below needs a real client, and `own`
    # alone doesn't tell the type checker that `client` stopped being None.
    own = client is None
    http = client if client is not None else httpx.Client(timeout=20.0)
    try:
        # Tier 2: Greenhouse per-job content API.
        if getattr(job, "jd_url", None):
            try:
                got = _ok(_from_greenhouse(http, job.jd_url))
                if got:
                    return got
            except Exception as exc:  # noqa: BLE001 — fall through to next tier
                log.debug("jd_source greenhouse miss for %s: %s",
                          job.dedup_key, exc)

        url = getattr(job, "url", None)
        jobright_id = getattr(job, "jobright_id", None)

        # ATS public API resolved from the URL itself: the strongest source
        # after an explicit jd_url, and immune to JS shells and bot walls.
        # The resolved employer URL (aggregator jobs) goes first: it is the
        # real posting, where `url` may be the aggregator's own page.
        for candidate in (employer_url, url):
            if candidate:
                got = _try_ats_api(http, candidate, job)
                if got:
                    return got

        # An employer url (not itself a jobright link) is the stronger
        # source: try scraping it before the jobright page, which is then
        # only a fallback for employer sites that block bots.
        scrape_first = bool(allow_scrape and url
                             and extract_jobright_id(url) is None)
        page_html: list[str] = []

        if scrape_first and url:
            got = _try_scrape(http, url, job, page_html)
            if got:
                return got

        # jobright info page (composed __NEXT_DATA__ blob) - the summary.
        # With an employer URL in hand, its scraped page is the fuller source
        # when it is a real posting (at least as long as the summary); a
        # short employer page is a JS/nav shell and loses to the summary.
        if jobright_id:
            summary = _try_jobright(http, jobright_id, job)
            if employer_url and allow_scrape:
                scraped = _try_scrape(http, employer_url, job, page_html)
                if scraped and len(scraped) >= len(summary or ""):
                    return scraped
            if summary:
                return summary

        # generic scrape of the apply URL, if not already tried above.
        if not scrape_first and allow_scrape and url:
            got = _try_scrape(http, url, job, page_html)
            if got:
                return got

        # Last resort: LLM extraction from whatever page we did fetch.
        if page_html:
            got = _llm_extract(page_html[-1], llm_cfg, job)
            if got:
                return got
    finally:
        if own:
            http.close()

    return None
