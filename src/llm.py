"""Batched LLM classification for jobs the rule engine couldn't decide.

Provider-agnostic: the per-user yaml picks `provider` (anthropic | gemini),
`model`, and `api_key_env`. One call per user per run, ambiguous survivors
only, hard-capped by llm.max_jobs_per_run. Verdicts are cached in seen.json
by the caller, so a job is never billed twice for the same question.
"""

from __future__ import annotations

import json
import logging
import os
import random
import re
import time

import httpx

from .models import Job

log = logging.getLogger(__name__)

_TERM_RE = re.compile(r"^(Spring|Summer|Fall|Winter) 20\d\d$")

# Per-job JD budget in the prompt: ~375 tokens. At the 40-job cost-guard cap
# that is ~15k input tokens per call -- still fractions of a cent on the
# configured flash-lite tier.
JD_EXCERPT_CHARS = 1500

DEFAULT_MODEL = {
    "anthropic": "claude-haiku-4-5-20251001",
    "gemini": "gemini-flash-lite-latest",
}
DEFAULT_KEY_ENV = {
    "anthropic": "ANTHROPIC_API_KEY",
    "gemini": "GEMINI_API_KEY",
}

_SYSTEM = (
    "You classify software-internship postings for a job-alert tool. "
    "Respond with ONLY a JSON array -- no prose, no markdown, no code fences."
)

_INSTRUCTIONS = """\
For every job in the input, output one object:
  {{"dedup_key": "<copy exactly>",
    "term": "<Season Year>" or null,
    "is_top_company": true/false,
    "in_atlanta_metro": true/false,
    "reason": "<one short sentence>"}}

- "term": the internship term (e.g. "Fall 2026"). Use the title, and
  source_terms if present. null if you genuinely cannot tell.
- Some jobs include a "description" excerpt from the posting; when present,
  prefer it over guessing from the title.
- "is_top_company": whether the company fits this user's definition. Judge
  the EMPLOYER (the brand/company family), never the specific role or team,
  so two postings from the same employer always get the same verdict:
  {definition}
- "in_atlanta_metro": whether ANY listed location is within ~35 miles of
  Atlanta, GA (Alpharetta, Marietta, Sandy Springs, Decatur, etc.).
  false for remote-only or unknown locations.

The user is targeting these terms: {terms}.

Jobs:
{jobs}
"""


def provider_of(llm_cfg: dict) -> str:
    return (llm_cfg.get("provider") or "anthropic").lower()


def api_key_env_for(llm_cfg: dict) -> str:
    return llm_cfg.get("api_key_env") or DEFAULT_KEY_ENV.get(
        provider_of(llm_cfg), "ANTHROPIC_API_KEY")


def parse_json_array(text: str) -> list:
    text = re.sub(r"```(?:json)?", "", text)
    start, end = text.find("["), text.rfind("]")
    if start == -1 or end <= start:
        raise ValueError("no JSON array in model response")
    return json.loads(text[start:end + 1])


# ------------------------------------------------------------- providers

def _call_anthropic(model: str, system: str, user_msg: str, api_key: str) -> str:
    import anthropic  # deferred: only needed when this provider is used

    client = anthropic.Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=model,
        max_tokens=8192,
        system=system,
        messages=[{"role": "user", "content": user_msg}],
    )
    return "".join(b.text for b in resp.content if b.type == "text")


def _call_gemini(model: str, system: str, user_msg: str, api_key: str) -> str:
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{model}:generateContent")
    payload = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user_msg}]}],
        "generationConfig": {
            "responseMimeType": "application/json",  # forces raw JSON output
            "maxOutputTokens": 8192,
            "temperature": 0,
        },
    }
    resp = httpx.post(url, json=payload, timeout=120.0,
                      headers={"x-goog-api-key": api_key})
    resp.raise_for_status()
    data = resp.json()
    try:
        parts = data["candidates"][0]["content"]["parts"]
    except (KeyError, IndexError) as exc:
        raise ValueError(f"unexpected gemini response shape: {data}") from exc
    return "".join(p.get("text", "") for p in parts)


_PROVIDERS = {
    "anthropic": _call_anthropic,
    "gemini": _call_gemini,
}


# --------------------------------------------------------------- retry

# Conservative defaults: 3 attempts (i.e. up to 2 retries) and a 1s base
# delay, so the happy path makes a single call and never sleeps. Both are
# overridable via llm.retry in the per-user yaml.
DEFAULT_RETRY_ATTEMPTS = 3
DEFAULT_RETRY_BASE_DELAY = 1.0


def _http_status_of(exc: Exception):
    """HTTP status code for a provider error, or None if not HTTP-status-shaped.

    Covers httpx.HTTPStatusError (gemini, via raise_for_status) and the
    anthropic SDK's APIStatusError, which both expose ``.response.status_code``.
    """
    resp = getattr(exc, "response", None)
    code = getattr(resp, "status_code", None)
    if isinstance(code, int):
        return code
    code = getattr(exc, "status_code", None)
    return code if isinstance(code, int) else None


def _retry_after_seconds(exc: Exception):
    """Server-requested wait from a Retry-After header, or None if absent."""
    resp = getattr(exc, "response", None)
    headers = getattr(resp, "headers", None)
    if not headers:
        return None
    raw = headers.get("Retry-After") or headers.get("retry-after")
    if not raw:
        return None
    try:                                  # Retry-After may be a delay in seconds
        return max(0.0, float(raw))
    except (TypeError, ValueError):
        return None                        # HTTP-date form: fall back to backoff


def _is_retryable(exc: Exception) -> bool:
    """Transient failures only: network timeouts, HTTP 429, and 5xx."""
    if isinstance(exc, httpx.TimeoutException):
        return True
    if isinstance(exc, httpx.TransportError):  # connect/read/network errors
        return True
    status = _http_status_of(exc)
    if status is None:
        return False
    return status == 429 or 500 <= status <= 599


def _retry_cfg(llm_cfg: dict) -> tuple[int, float]:
    retry = llm_cfg.get("retry") or {}
    try:
        attempts = int(retry.get("max_attempts", DEFAULT_RETRY_ATTEMPTS))
    except (TypeError, ValueError):
        attempts = DEFAULT_RETRY_ATTEMPTS
    try:
        base = float(retry.get("base_delay", DEFAULT_RETRY_BASE_DELAY))
    except (TypeError, ValueError):
        base = DEFAULT_RETRY_BASE_DELAY
    return max(1, attempts), max(0.0, base)


def _call_with_retry(call, *args, max_attempts: int, base_delay: float):
    """Invoke ``call(*args)``, retrying transient errors with exponential
    backoff + jitter. Honors a Retry-After header when the server sends one.
    Non-retryable errors (e.g. HTTP 400) and the final attempt re-raise."""
    for attempt in range(1, max_attempts + 1):
        try:
            return call(*args)
        except Exception as exc:           # noqa: BLE001 -- re-raised below
            if attempt >= max_attempts or not _is_retryable(exc):
                raise
            wait = _retry_after_seconds(exc)
            if wait is None:
                # full-jitter exponential backoff: random in [0, base*2^(n-1)]
                wait = random.uniform(0, base_delay * (2 ** (attempt - 1)))
            log.warning("llm: retryable error on attempt %d/%d (%s); "
                        "sleeping %.2fs", attempt, max_attempts,
                        type(exc).__name__, wait)
            time.sleep(wait)
    return None


# ------------------------------------------------------------------ main

def classify(jobs: list[Job], definition: str, wanted_terms: list[str],
             llm_cfg: dict) -> dict[str, dict]:
    """Returns {dedup_key: {term, is_top_company, in_atlanta_metro, reason}}.
    Raises on API/parse failure -- caller defers those jobs to the next run."""
    if not jobs:
        return {}
    provider = provider_of(llm_cfg)
    call = _PROVIDERS.get(provider)
    if call is None:
        raise ValueError(f"unknown llm provider '{provider}' "
                         f"(supported: {sorted(_PROVIDERS)})")
    model = llm_cfg.get("model") or DEFAULT_MODEL[provider]
    api_key = os.environ[api_key_env_for(llm_cfg)]

    payload = [{
        "dedup_key": j.dedup_key,
        "company": j.company,
        "title": j.raw_title or j.title,
        "locations": j.locations[:6],
        "source_terms": j.terms,
        **({"description": j.description[:JD_EXCERPT_CHARS]}
           if j.description else {}),
    } for j in jobs]
    user_msg = _INSTRUCTIONS.format(
        definition=definition.strip() or "well-known, selective tech employers",
        terms=", ".join(wanted_terms),
        jobs=json.dumps(payload, ensure_ascii=False, indent=1),
    )

    max_attempts, base_delay = _retry_cfg(llm_cfg)
    text = _call_with_retry(call, model, _SYSTEM, user_msg, api_key,
                            max_attempts=max_attempts, base_delay=base_delay)
    out: dict[str, dict] = {}
    valid_keys = {j.dedup_key for j in jobs}
    for item in parse_json_array(text):
        if not isinstance(item, dict) or item.get("dedup_key") not in valid_keys:
            continue
        term = item.get("term")
        if not (isinstance(term, str) and _TERM_RE.match(term)):
            term = None
        out[item["dedup_key"]] = {
            "term": term,
            "is_top_company": bool(item.get("is_top_company")),
            "in_atlanta_metro": bool(item.get("in_atlanta_metro")),
            "reason": str(item.get("reason", ""))[:200],
        }
    missing = valid_keys - out.keys()
    if missing:
        log.warning("llm(%s): %d job(s) missing from model response",
                    provider, len(missing))
    return out
