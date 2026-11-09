"""Coverage gaps: which employers the user had to add by hand.

Every manual add (a `[MANUAL]` match, `manual:` ledger key) is a posting the
pipeline missed. This module maps each manual URL to the ATS and board that
host it, diffs that against data/ats_boards.yaml, and renders:

- ready-to-paste ats_boards.yaml rows for boards on an ATS the ats-boards
  adapter already speaks but that nobody configured yet;
- the employers on an ATS with no adapter, with miss counts, so the next
  adapter is picked by evidence;
- the hand-check watchlist (employers with no usable public API) with when
  each was last checked.

`scripts/gap_report.py` is the CLI; `.github/workflows/gap-report.yml` runs it
weekly and keeps one "coverage gaps" issue current. Read-only: it never
writes state.

The URL -> (ats, board) table is mirrored in convex/ats_detect.ts; both are
pinned by shared/ats-board-cases.json.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import json
import logging
import os
import re
import sys
from collections import Counter, defaultdict
from collections.abc import Callable, Iterable
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import yaml

from .adapters import ats_boards

# Vanity hosts that front a polled tenant, listed (never guessed) next to the
# URL identity code; convex/ats_detect.ts mirrors them.
from .normalize import _JIBE_HOSTS as JIBE_HOSTS
from .normalize import _ORACLE_CUSTOM_HOSTS as ORACLE_CUSTOM_HOSTS
from .paths import DATA_ROOT

log = logging.getLogger(__name__)

BOARDS_FILE = "data/ats_boards.yaml"  # template under ROOT, overlay under DATA_ROOT
WATCHLIST_FILE = DATA_ROOT / "manual_watchlist.yaml"
LEDGER_FILE = DATA_ROOT / "state" / "applications.json"


@dataclasses.dataclass(frozen=True)
class Board:
    ats: str
    # The identifier an ats_boards.yaml row would carry in `slug`; None when
    # the URL proves the ATS but not the board (a gh_jid on a custom domain).
    board: str | None
    # Set only with board=None: the host a URL names when the full slug isn't
    # in it (a bare <tenant>.eightfold.ai, whose slug adds a company domain).
    scope: str | None = None


# -- URL -> (ats, board) -----------------------------------------------------
#
# One ordered table, first hit wins. ATS names are the `ats:` values
# data/ats_boards.yaml uses; when a listing adapter lands under a different
# name, rename it here and in convex/ats_detect.ts (the shared fixture
# catches a mismatch).

_Rule = Callable[[str, list[str], dict[str, list[str]]], Board | None]


def _seg(path: list[str], i: int) -> str | None:
    return path[i] if len(path) > i and path[i] else None


def _greenhouse(host: str, path: list[str], q: dict[str, list[str]]) -> Board | None:
    m = re.fullmatch(r"(?:job-)?boards(?:-api)?(\.eu)?\.greenhouse\.io", host)
    if m:
        ats = "greenhouse-eu" if m.group(1) else "greenhouse"
        if _seg(path, 0) == "embed":
            return Board(ats, next(iter(q.get("for") or []), None))
        if _seg(path, 0) == "v1" and _seg(path, 1) == "boards":
            return Board(ats, _seg(path, 2))
        return Board(ats, _seg(path, 0))
    if "gh_jid" in q:
        return Board("greenhouse", None)
    return None


def _lever(host: str, path: list[str], q: dict[str, list[str]]) -> Board | None:
    m = re.fullmatch(r"jobs(\.eu)?\.lever\.co", host)
    if m:
        return Board("lever-eu" if m.group(1) else "lever", _seg(path, 0))
    return None


def _ashby(host: str, path: list[str], q: dict[str, list[str]]) -> Board | None:
    if host == "jobs.ashbyhq.com":
        return Board("ashby", _seg(path, 0))
    if "ashby_jid" in q:
        return Board("ashby", None)
    return None


def _smartrecruiters(host: str, path: list[str], q: dict[str, list[str]]) -> Board | None:
    if host in ("jobs.smartrecruiters.com", "careers.smartrecruiters.com"):
        return Board("smartrecruiters", _seg(path, 0))
    return None


# Hosts that front a tenant one of the listing adapters polls. Mirrors the
# explicit maps in src/normalize.py (_ORACLE_CUSTOM_HOSTS,
# _EIGHTFOLD_CUSTOM_HOSTS, _JIBE_HOSTS) and the board rows that use them:
# listed, never guessed. Keep convex/ats_detect.ts in step.
# Eightfold slugs carry the tenant's company domain, which no posting URL
# shows: the employer hosts in normalize._EIGHTFOLD_CUSTOM_HOSTS, with the
# board slug their data/ats_boards.yaml row uses (a test keeps them aligned).
EIGHTFOLD_BOARDS = {
    "apply.careers.microsoft.com": "apply.careers.microsoft.com/microsoft.com",
    "careers.micron.com": "micron.eightfold.ai/micron.com",
}


def _workday(host: str, path: list[str], q: dict[str, list[str]]) -> Board | None:
    # Board slug is "<tenant>.<wdN>/<site>" (workday_api.split_slug).
    m = re.fullmatch(r"([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com", host)
    if m:
        rest = path[1:] if path and re.fullmatch(r"[a-z]{2}-[A-Z]{2}", path[0]) else path
        site = _seg(rest, 0)
        return Board("workday", f"{m.group(1)}.{m.group(2)}/{site}" if site else None)
    # myworkdaysite.com career sites aren't pollable by the Workday adapter;
    # the tenant usually also has a myworkdayjobs site, found by hand.
    if re.fullmatch(r"wd\d+\.myworkdaysite\.com", host):
        return Board("workday", None)
    return None


def _oracle(host: str, path: list[str], q: dict[str, list[str]]) -> Board | None:
    # Oracle Recruiting Cloud: /hcmUI/CandidateExperience/<lang>/sites/<site>/
    # on <pod>.oraclecloud.com, or /<lang>/sites/<site>/ behind an employer's
    # own domain. A board is "<pod host>/<site>" (oracle_cx.split_slug), so a
    # vanity host counts only when its pod is known.
    for i, part in enumerate(path):
        if part != "sites" or i < 1 or not re.fullmatch(r"[a-z]{2}(-[A-Z]{2})?", path[i - 1]):
            continue
        site = _seg(path, i + 1)
        if not site:
            continue
        if host.endswith(".oraclecloud.com"):
            return Board("oracle", f"{host}/{site}")
        if host in ORACLE_CUSTOM_HOSTS:
            return Board("oracle", f"{ORACLE_CUSTOM_HOSTS[host]}/{site}")
        if re.fullmatch(r"CX(_\d+)?", site):
            return Board("oracle", None)
    return None


def _eightfold(host: str, path: list[str], q: dict[str, list[str]]) -> Board | None:
    # Board slug is "<host>/<company domain>" (eightfold.split_slug); the
    # domain isn't in a posting URL, so only listed hosts name their board.
    if host in EIGHTFOLD_BOARDS:
        return Board("eightfold", EIGHTFOLD_BOARDS[host])
    if host.endswith(".eightfold.ai"):
        return Board("eightfold", None, host)
    return None


def _ibm(host: str, path: list[str], q: dict[str, list[str]]) -> Board | None:
    if host == "careers.ibm.com" or (host == "ibm.com" and _seg(path, 0) == "careers"):
        return Board("ibm", "careers")  # one board (ibm_careers.py)
    return None


def _jibe(host: str, path: list[str], q: dict[str, list[str]]) -> Board | None:
    return Board("jibe", host) if host in JIBE_HOSTS else None


def _host_rule(ats: str, pattern: str, board: Callable[[re.Match[str]], str]) -> _Rule:
    rx = re.compile(pattern)

    def rule(host: str, path: list[str], q: dict[str, list[str]]) -> Board | None:
        m = rx.fullmatch(host)
        return Board(ats, board(m)) if m else None
    return rule


def _workable(host: str, path: list[str], q: dict[str, list[str]]) -> Board | None:
    if host == "apply.workable.com":
        return Board("workable", _seg(path, 0))
    m = re.fullmatch(r"([a-z0-9-]+)\.workable\.com", host)
    return Board("workable", m.group(1)) if m else None


def _radancy(host: str, path: list[str], q: dict[str, list[str]]) -> Board | None:
    # TalentBrew (Radancy) career sites: /job/<city>/<title>/<org>/<id>.
    if len(path) >= 5 and path[0] == "job" and all(
            re.fullmatch(r"[0-9]+", p) for p in path[-2:]):
        return Board("radancy", host)
    return None


# greenhouse-eu, lever-eu, avature, icims, workable, taleo, successfactors and
# radancy have no adapter: they only ever label "unsupported" misses.
RULES: list[_Rule] = [
    _greenhouse,
    _lever,
    _ashby,
    _smartrecruiters,
    _workday,
    _oracle,
    _eightfold,
    _ibm,
    _jibe,
    _host_rule("avature", r"[a-z0-9-]+\.avature\.net", lambda m: m.group(0)),
    _host_rule("icims", r"([a-z0-9-]+)\.icims\.com", lambda m: m.group(1)),
    _workable,
    _host_rule("taleo", r"([a-z0-9-]+)\.taleo\.net", lambda m: m.group(1)),
    _host_rule("successfactors", r"[a-z0-9.-]+\.successfactors\.(?:com|eu)",
               lambda m: m.group(0)),
    _radancy,
]


def detect(url: str) -> Board | None:
    """The ATS and board behind a posting URL; ats "other" (board = host)
    for a site no rule knows, None for something that is not an http URL."""
    try:
        parts = urlsplit((url or "").strip())
    except ValueError:
        return None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return None
    host = parts.hostname.lower()
    if host.startswith("www."):
        host = host[4:]
    path = [p for p in parts.path.split("/") if p]
    q = parse_qs(parts.query, keep_blank_values=True)
    for rule in RULES:
        hit = rule(host, path, q)
        if hit:
            return hit
    return Board("other", host)


# -- configured boards ---------------------------------------------------------

def load_boards() -> list[dict]:
    """Every board the watcher polls (template + instance overlay), loaded
    exactly as the ats-boards adapter loads them."""
    return ats_boards.load_boards(BOARDS_FILE)


def watched_board_ids(rows: Iterable[dict] | None = None) -> list[str]:
    """Every polled board as "ats:slug" (ats_boards.board_id: slug lower-
    cased) - what the web app compares a hand-added URL against (shipped in
    the watch report)."""
    rows = load_boards() if rows is None else rows
    return sorted({ats_boards.board_id(r) for r in rows if r.get("ats") and r.get("slug")})


def is_watched(board: Board, ids: set[str]) -> bool:
    """Exact board match - a listing is per board (Oracle lists one site of a
    pod, Eightfold one company domain of a host), so a sibling board on the
    same host does not cover this one. The one exception: a URL that names
    only its host (board None, scope set) is covered when exactly one polled
    board sits on that host, since that board is the only listing it can be."""
    if board.board:
        return f"{board.ats}:{board.board.lower()}" in ids
    if board.scope:
        prefix = f"{board.ats}:{board.scope.lower()}/"
        return sum(i.startswith(prefix) for i in ids) == 1
    return False


def supported_ats() -> list[str]:
    """ATSes the ats-boards adapter can poll - never the boards file (a row
    for an ATS without an adapter is a bug, not support)."""
    return sorted(ats_boards.polled_ats())


# -- manual adds -----------------------------------------------------------------

def is_manual(rec: dict) -> bool:
    key = str(rec.get("key") or "")
    return (key.startswith("manual:") or rec.get("tag") == "[MANUAL]"
            or rec.get("source") == "manual")


@dataclasses.dataclass
class Miss:
    user: str
    company: str
    url: str
    via: str
    added: str
    board: Board


_GENERIC_COMPANY = re.compile(r"^(jobs?|apply|join|careers?|unknown)$|careers? \|", re.I)


def display_company(company: str, board: Board) -> str:
    """Manual ingest sometimes reads the site's chrome as the employer
    ("Jobs", "Apply"); fall back to the board so the row still says who."""
    company = (company or "").strip()
    if not company or _GENERIC_COMPANY.search(company):
        return board.board or company or "?"
    return company


def collect_misses(books: dict[str, dict], matches: dict[str, list[dict]],
                   failed: dict[str, list[dict]] | None = None) -> list[Miss]:
    """Manual adds from ledger books ({user: {short: record}}), Convex match
    lists ({user: [item]}) and failed Convex ingests ({user: [row]}, adds
    whose fetch never produced a match), one per (user, url)."""
    failed = failed or {}
    out: list[Miss] = []
    seen: set[tuple[str, str]] = set()
    for user in sorted(set(books) | set(matches) | set(failed)):
        recs = (list((books.get(user) or {}).values()) + list(matches.get(user) or [])
                + [{**r, "source": "manual"} for r in failed.get(user) or []])
        for rec in recs:
            url = str(rec.get("url") or "")
            if not is_manual(rec) or (user, url) in seen:
                continue
            board = detect(url)
            if board is None:
                continue
            seen.add((user, url))
            company = display_company(str(rec.get("company") or ""), board)
            out.append(Miss(user=user, company=company, url=url,
                            via=str(rec.get("foundVia") or "").strip().lower(),
                            added=str(rec.get("added") or rec.get("applied") or ""),
                            board=board))
    return out


# -- report ----------------------------------------------------------------------

@dataclasses.dataclass
class Gap:
    ats: str
    board: str | None
    companies: Counter[str]
    misses: list[Miss]
    sample: Board  # the detected board the group stands for

    @property
    def company(self) -> str:
        return self.companies.most_common(1)[0][0]

    @property
    def last_added(self) -> str:
        return max((m.added for m in self.misses), default="")


@dataclasses.dataclass
class Report:
    addable: list[Gap]       # supported ATS, board known, not configured
    configured: list[Gap]    # board IS configured; the miss is a filter/timing gap
    unknown_board: list[Gap]  # supported ATS, board not derivable from the URL
    unsupported: list[Gap]   # no adapter for this ATS
    by_via: Counter[str]
    total: int


def build_report(misses: list[Miss], rows: list[dict],
                 supported: set[str] | None = None) -> Report:
    supported = set(supported_ats()) if supported is None else supported
    ids = set(watched_board_ids(rows))
    # An EU-hosted Greenhouse board also answers the US embed URL, but not the
    # US API the adapter polls - so a board seen on the EU host is EU.
    eu = {m.board.board.lower() for m in misses
          if m.board.ats == "greenhouse-eu" and m.board.board}
    groups: dict[tuple[str, str | None], Gap] = {}
    for m in misses:
        b = m.board.board.lower() if m.board.board else None
        board = m.board
        if board.ats == "greenhouse" and b in eu:
            board = Board("greenhouse-eu", board.board)
        key = (board.ats, b if b is not None else (board.scope or "").lower() or None)
        gap = groups.setdefault(key, Gap(board.ats, board.board, Counter(), [], board))
        gap.companies[m.company] += 1
        gap.misses.append(m)
    rep = Report([], [], [], [], Counter(m.via or "unspecified" for m in misses), len(misses))
    for gap in groups.values():
        if gap.ats not in supported:
            rep.unsupported.append(gap)
        elif is_watched(gap.sample, ids):
            rep.configured.append(gap)
        elif gap.board is None:
            rep.unknown_board.append(gap)
        else:
            rep.addable.append(gap)
    for lst in (rep.addable, rep.configured, rep.unknown_board, rep.unsupported):
        lst.sort(key=lambda g: (-len(g.misses), g.ats, g.board or ""))
    return rep


def suggested_rows(rep: Report) -> list[dict]:
    return [{"company": g.company, "ats": g.ats, "slug": g.board} for g in rep.addable]


def load_watchlist(path: Path = WATCHLIST_FILE) -> list[dict]:
    if not path.exists():
        return []
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return [e for e in (data.get("employers") or []) if isinstance(e, dict) and e.get("company")]


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", s.casefold()).strip()


def _watchlist_rows(watch: list[dict], misses: list[Miss], today: dt.date) -> list[str]:
    out = []
    for e in watch:
        name = str(e["company"])
        needles = [_norm(n) for n in [name, *(e.get("aliases") or [])] if _norm(str(n))]
        hits = [m for m in misses
                if any(n in _norm(m.company) or n in _norm(m.url) for n in needles)]
        last_add = max((m.added for m in hits), default="")
        checked = str(e.get("last_checked") or "")
        every = int(e.get("check_every_days") or 7)
        try:
            due = (today - dt.date.fromisoformat(checked)).days >= every
        except ValueError:
            due = True
        url = e.get("url") or ""
        link = f"[{name}]({url})" if url else name
        out.append(f"| {'🔴' if due else '🟢'} {link} | {checked or 'never'} | {every}d "
                   f"| {last_add or '-'} | {len(hits)} |")
    return out


def render_markdown(rep: Report, watch: list[dict], today: dt.date) -> str:
    misses = [m for g in (rep.addable + rep.configured + rep.unknown_board + rep.unsupported)
              for m in g.misses]
    lines = [
        f"_Updated {today.isoformat()} by the gap-report workflow. "
        f"{rep.total} hand-added postings analysed._",
        "",
        "Every manual add is a posting the watcher missed. Close the gap so it "
        "does not recur: paste the rows below into `data/ats_boards.yaml` in the "
        "code repo, or build an adapter for the ATSes at the bottom.",
        "",
        "## Ready to add to `data/ats_boards.yaml`",
        "",
    ]
    rows = suggested_rows(rep)
    if rows:
        lines += ["```yaml", yaml.safe_dump(rows, sort_keys=False, allow_unicode=True).rstrip(),
                  "```", "", "| board | misses | last added |", "|---|---|---|"]
        lines += [f"| {g.ats}:{g.board} ({g.company}) | {len(g.misses)} | {g.last_added} |"
                  for g in rep.addable]
    else:
        lines.append("Nothing: every hand-added board on a supported ATS is already configured.")
    lines += ["", "## Unsupported ATS (needs an adapter)", ""]
    if rep.unsupported:
        by_ats: dict[str, list[Gap]] = defaultdict(list)
        for g in rep.unsupported:
            by_ats[g.ats].append(g)
        lines += ["| ATS | employer | board | misses |", "|---|---|---|---|"]
        for ats in sorted(by_ats, key=lambda a: -sum(len(g.misses) for g in by_ats[a])):
            for g in by_ats[ats]:
                lines.append(f"| {ats} | {g.company} | {g.board or '?'} | {len(g.misses)} |")
    else:
        lines.append("None.")
    if rep.unknown_board:
        lines += ["", "## Supported ATS, board not in the URL", "",
                  "These links prove the ATS (e.g. a `gh_jid` on the employer's own "
                  "domain) but not the board slug - look it up once by hand.", ""]
        lines += [f"- {g.ats}: {', '.join(sorted(g.companies))} ({len(g.misses)})"
                  for g in rep.unknown_board]
    if rep.configured:
        lines += ["", "## Already watched, still added by hand", "",
                  "The board is configured, so the miss came from the intern-title "
                  "prefilter, a filter rejection, or a posting added before the board was.", ""]
        lines += [f"- {g.ats}:{g.board or g.sample.scope} ({g.company}) x{len(g.misses)}"
                  for g in rep.configured]
    lines += ["", "## Where the links came from", ""]
    lines += [f"- {via}: {n}" for via, n in rep.by_via.most_common()] or ["- (none)"]
    if watch:
        lines += ["", "## Hand-check watchlist", "",
                  "Employers with no usable public API. Bump `last_checked` in "
                  "`manual_watchlist.yaml` (data repo) after each pass.", "",
                  "| employer | last checked | every | last manual add | adds |",
                  "|---|---|---|---|---|"]
        lines += _watchlist_rows(watch, misses, today)
    return "\n".join(lines) + "\n"


# -- inputs ----------------------------------------------------------------------

def load_books(path: Path = LEDGER_FILE) -> dict[str, dict]:
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {u: b for u, b in data.items() if isinstance(b, dict)}


def _user_names() -> list[str]:
    return sorted(p.stem for p in (DATA_ROOT / "users").glob("*.yaml")
                  if not p.stem.startswith("_") and "example" not in p.stem)


@dataclasses.dataclass
class ConvexInputs:
    books: dict[str, dict] = dataclasses.field(default_factory=dict)
    matches: dict[str, list[dict]] = dataclasses.field(default_factory=dict)
    failed: dict[str, list[dict]] = dataclasses.field(default_factory=dict)


def load_convex(users: list[str]) -> ConvexInputs:
    """Ledger books, matches and failed manual ingests from Convex, when
    STORE=convex is configured. Best effort: an unreachable store leaves the
    git ledger as the only input."""
    got = ConvexInputs()
    if os.environ.get("STORE") != "convex":
        return got
    from .store import ConvexStore
    try:
        store = ConvexStore(DATA_ROOT)
        for u in users:
            got.books[u] = store.get_ledger(u)
            got.matches[u] = store.get_matches(u) or []
            got.failed[u] = store.get_failed_ingests(u)
    except Exception as exc:  # noqa: BLE001 - report on what we have
        log.warning("convex read failed, using what was read so far: %s", exc)
    return got


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--format", choices=("markdown", "yaml", "json"), default="markdown")
    ap.add_argument("--user", action="append", help="limit to these users")
    ap.add_argument("--watchlist", type=Path, default=WATCHLIST_FILE)
    ap.add_argument("--out", type=Path, help="write here instead of stdout")
    ap.add_argument("--skip-if-empty", action="store_true",
                    help="write nothing when there are no manual adds and no watchlist")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    books = load_books()
    users = args.user or sorted(set(books) | set(_user_names()))
    cx = load_convex(users)
    for u, b in cx.books.items():
        books[u] = {**books.get(u, {}), **b}
    if args.user:
        books = {u: b for u, b in books.items() if u in args.user}

    rows = load_boards()
    rep = build_report(collect_misses(books, cx.matches, cx.failed), rows)
    watch = load_watchlist(args.watchlist)
    if args.skip_if_empty and rep.total == 0 and not watch:
        log.info("no manual adds and no watchlist: nothing to report")
        return 0
    if args.format == "yaml":
        text = yaml.safe_dump(suggested_rows(rep), sort_keys=False, allow_unicode=True)
    elif args.format == "json":
        text = json.dumps({
            "addable": suggested_rows(rep),
            "unsupported": [{"ats": g.ats, "board": g.board, "company": g.company,
                             "misses": len(g.misses)} for g in rep.unsupported],
            "by_via": dict(rep.by_via), "total": rep.total}, indent=1) + "\n"
    else:
        text = render_markdown(rep, watch, dt.date.today())
    if args.out:
        args.out.write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
