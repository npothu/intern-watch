"""Deterministic JD analysis: extract weighted skill keywords.

No LLM here. A fixed lexicon of canonical skills (each with alias regexes)
is matched against the JD text; mentions inside requirements/qualifications
blocks count double. The same alias matcher is reused by select.py to score
projects and reorder skill lines, so both sides of the match speak the same
vocabulary.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# canonical skill -> alias regexes (matched case-insensitively, on raw text)
LEXICON: dict[str, list[str]] = {
    "python": [r"\bpython\b"],
    "java": [r"\bjava\b(?!script)"],
    "javascript": [r"\bjavascript\b", r"(?<![.\w])js\b", r"\bnode(?:\.js|js)?\b"],
    "typescript": [r"\btypescript\b", r"(?<![.\w])ts\b"],
    "c": [r"(?<![\w+#.])c(?![\w+#])"],
    "c++": [r"c\+\+"],
    "c#": [r"c#", r"\b\.net\b"],
    "golang": [r"\bgo(?:lang)?\b"],
    "sql": [r"\bsql\b"],
    "bash": [r"\bbash\b", r"\bshell script"],
    "assembly": [r"\bassembly\b", r"\brisc-?v\b", r"\bmips\b", r"\bx86\b"],
    "html/css": [r"\bhtml\b", r"\bcss\b"],
    "machine learning": [r"\bmachine learning\b", r"(?<![\w/])ml(?![\w/])",
                         r"\bdeep learning\b", r"\bneural net"],
    "ai": [r"(?<![\w/])ai(?![\w/])", r"\bartificial intelligence\b",
           r"\bllms?\b", r"\bgenerative ai\b", r"\bgenai\b"],
    "pytorch": [r"\bpytorch\b", r"\btorch\b"],
    "tensorflow": [r"\btensorflow\b", r"\bkeras\b"],
    "xgboost": [r"\bxgboost\b", r"\bgradient boost"],
    "scikit-learn": [r"\bscikit-?learn\b", r"\bsklearn\b"],
    "pandas": [r"\bpandas\b"],
    "numpy": [r"\bnumpy\b"],
    "feature engineering": [r"\bfeature engineering\b", r"\bfeature selection\b"],
    "data pipelines": [r"\bdata pipeline", r"\betl\b", r"\bdata processing\b",
                       r"\bdata engineering\b"],
    "computer vision": [r"\bcomputer vision\b", r"(?<![\w/])cv(?![\w/])",
                        r"\bimage processing\b"],
    "nlp": [r"\bnlp\b", r"\bnatural language\b"],
    "signal processing": [r"\bsignal processing\b", r"\btime[- ]series\b"],
    "rest apis": [r"\brest(?:ful)?\b", r"\bapis?\b", r"\bhttp\b"],
    "fastapi": [r"\bfastapi\b"],
    "react": [r"\breact\b"],
    "frontend": [r"\bfront[- ]?end\b", r"\bui\b", r"\buser interface"],
    "backend": [r"\bback[- ]?end\b", r"\bserver[- ]side\b"],
    "full stack": [r"\bfull[- ]?stack\b"],
    "docker": [r"\bdocker\b", r"\bcontainer"],
    "kubernetes": [r"\bkubernetes\b", r"\bk8s\b"],
    "aws": [r"\baws\b", r"\bamazon web services\b", r"\bec2\b", r"\bs3\b",
            r"\blambda\b"],
    "gcp": [r"\bgcp\b", r"\bgoogle cloud\b"],
    "azure": [r"\bazure\b"],
    "cloud": [r"\bcloud\b"],
    "ci/cd": [r"\bci/?cd\b", r"\bcontinuous integration\b", r"\bjenkins\b",
              r"\bgithub actions\b"],
    "git": [r"\bgit\b(?!hub actions)"],
    "linux": [r"\blinux\b", r"\bunix\b", r"\bposix\b"],
    "kernel": [r"\bkernel\b", r"\bsystems? programming\b", r"\blow[- ]level\b"],
    "operating systems": [r"\boperating systems?\b", r"(?<![\w/])os(?![\w/])"],
    "embedded": [r"\bembedded\b", r"\bmicrocontroller", r"\bstm32\b",
                 r"\bbare[- ]metal\b", r"\bspi\b", r"\bi2c\b", r"\buart\b"],
    "firmware": [r"\bfirmware\b"],
    "real-time": [r"\breal[- ]time\b", r"\brtos\b"],
    "hardware": [r"\bhardware\b", r"\bsensors?\b", r"\bimu\b", r"\bavionics\b",
                 r"\bflight (?:software|computer)\b", r"\baerospace\b"],
    "robotics": [r"\brobotics?\b", r"\bautonom"],
    "concurrency": [r"\bconcurren", r"\bmulti[- ]?thread", r"\bparallel",
                    r"\basync", r"\bsynchronization\b", r"\block-free\b"],
    "memory management": [r"\bmemory management\b", r"\bmemory alloc",
                          r"\bperformance optimi"],
    "distributed systems": [r"\bdistributed\b", r"\bscalab", r"\bmicroservices?\b",
                            r"\bhigh[- ]throughput\b", r"\bgrpc\b",
                            r"\blarge[- ]scale\b"],
    "databases": [r"\bdatabases?\b", r"\bdata model", r"\bschema\b",
                  r"\bstored procedures?\b", r"\brelational\b"],
    "mysql": [r"\bmysql\b"],
    "postgresql": [r"\bpostgres(?:ql)?\b"],
    "nosql": [r"\bnosql\b", r"\bfirestore\b", r"\bmongodb\b", r"\bdynamodb\b",
              r"\bredis\b"],
    "caching": [r"\bcach(?:e|ing)\b", r"\blatency\b"],
    "testing": [r"\bunit test", r"\btest[- ]driven\b", r"\btdd\b", r"\btesting\b",
                r"\bintegration test", r"\bqa\b"],
    "playwright": [r"\bplaywright\b", r"\bselenium\b", r"\bbrowser automation\b"],
    "automation": [r"\bautomat(?:e|ion|ing)\b", r"\bscripting\b"],
    "agile": [r"\bagile\b", r"\bscrum\b", r"\bsprint", r"\bkanban\b"],
    "oauth": [r"\boauth\b", r"\bauthentication\b", r"\bsso\b"],
    "security": [r"\bsecurity\b", r"\bsecure\b", r"\bvulnerabilit"],
    "compilers": [r"\bcompilers?\b", r"\bllvm\b", r"\bstatic analysis\b",
                  r"\bprogram analysis\b"],
    "chrome extensions": [r"\bchrome extension", r"\bbrowser extension"],
    "mobile": [r"\bandroid\b", r"\bios\b", r"\bmobile\b"],
    "data visualization": [r"\bvisualization\b", r"\bdashboards?\b"],
    "model serving": [r"\bmodel serving\b", r"\binference\b", r"\bml ops\b",
                      r"\bmlops\b", r"\bmodel deploy"],
}

_COMPILED: dict[str, list[re.Pattern]] = {
    skill: [re.compile(p, re.IGNORECASE) for p in pats]
    for skill, pats in LEXICON.items()
}

# Block headers that mark requirements/qualifications text (weighted double).
_REQ_HEADER = re.compile(
    r"(requirements?|qualifications?|must[- ]haves?|what you.{0,3}ll need|"
    r"what we.{0,3}re looking for|who you are|skills?\s*:|nice to have|"
    r"preferred|minimum|basic qualifications)", re.IGNORECASE)

REQ_WEIGHT = 2          # multiplier inside requirements blocks
MENTION_CAP = 3         # repeated mentions saturate


@dataclass
class JDProfile:
    text: str
    weights: dict[str, float]       # canonical skill -> weight, desc-sortable

    def ranked(self) -> list[str]:
        return sorted(self.weights, key=lambda s: (-self.weights[s], s))


def matches(skill: str, text: str) -> bool:
    """Does `text` mention `skill` (by any alias)? Shared with select.py."""
    return any(p.search(text) for p in _COMPILED[skill])


def _blocks(text: str) -> list[tuple[str, bool]]:
    """Split into blank-line blocks, flagging requirements blocks. A header
    block flags itself and the following block (headers often sit alone)."""
    blocks = [b for b in re.split(r"\n\s*\n", text) if b.strip()]
    out: list[tuple[str, bool]] = []
    carry = False
    for b in blocks:
        is_req = bool(_REQ_HEADER.search(b.split("\n", 1)[0])) or carry
        carry = bool(_REQ_HEADER.search(b)) and len(b) < 600
        out.append((b, is_req))
    return out


def analyze(jd_text: str) -> JDProfile:
    weights: dict[str, float] = {}
    blocks = _blocks(jd_text)
    for skill, pats in _COMPILED.items():
        plain = req = 0
        for block, is_req in blocks:
            n = sum(len(p.findall(block)) for p in pats)
            if is_req:
                req += n
            else:
                plain += n
        if plain + req == 0:
            continue
        weights[skill] = (min(plain, MENTION_CAP)
                          + REQ_WEIGHT * min(req, MENTION_CAP))
    return JDProfile(text=jd_text, weights=weights)
