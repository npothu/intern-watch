"""First-sight seeding: a newly added source or ATS board must not flood email.

When a source (a `sources.yaml` row, identified by `name`) or an ATS board (a
`data/ats_boards.yaml` row inside the `ats-boards` source, identified by
`<ats>:<slug>`) is fetched successfully for the first time, every job it lists
that is new this run is its *backlog*. Those jobs are marked seen without
being evaluated, and their state entry is tagged `seeded: <date>` so later
logic (e.g. a recheck of rejected jobs) can tell seeded from evaluated.

A new job is seeded only when EVERY raw row that produced it came from a
first-sight origin. One arriving in the same run from an already-known source
or board is evaluated normally: it is genuinely new news, not backlog.

Opt-out: `backfill: true` on a sources.yaml row or an ats_boards.yaml row
means "deliver this origin's backlog": it is recorded as known but never
seeded.

Seeding is final, like a rejection, and has no exceptions: a priority
employer's backlog on a new board is seeded too (the owner's call: a new
board must never flood email; use `backfill: true` when the backlog is
wanted). Seeded jobs still register their employer URL in `url_index`, as
`--seed` always has, so a later copy of one from another source is joined to
it rather than delivered.

Known origins live in `state["_meta"]["known_sources"]` and
`["known_boards"]` (sorted lists). Bootstrap: those lists do not exist before
this code first runs, and every origin would look new. So an origin is also
known when state already holds evidence of it from an earlier run:

- a source is known if its name appears in any job entry's `sources`;
- a board is known if state holds a job ingested through the board's source
  under the same URL path as one of the board's current jobs (the dedup key
  up to its last "/": `url:https://boards.greenhouse.io/<slug>/jobs/`,
  `url:https://jobs.lever.co/<slug>/`, ...). A board whose current postings
  are all new still matches the keys its earlier, closed postings left.

Both checks look at state as it was BEFORE this run's `touch`, and the board
check only counts entries whose `sources` include the board's source, so a job
first ingested from another source (simplify, say) does not make a new board
look known. The evidence rule stays on after bootstrap, so a board that failed
on the bootstrap run, and so was never recorded, is still recognised the next
time it answers. Blind spots: a board whose earlier postings have all been
pruned from state (120 days unseen), or whose job URLs share no path with its
earlier ones, is seeded once on the bootstrap run.

Adapters that serve several boards report them on `Adapter.fetched_boards`
(board id -> backfill flag) and stamp `Job.board` with the same id. A board is
recorded only when its fetch succeeded, even with zero rows, so a board that
lists nothing today is known and its first real posting later is delivered
(any board seen on a job also counts as answered, in case an adapter forgets
fetched_boards). A SOURCE, by contrast, is recorded only once it has returned
at least one job: a new list whose first answer is an empty file must not
have its first real contents delivered as news.
"""

from __future__ import annotations

import datetime as dt
import logging
import re
from collections import defaultdict
from dataclasses import dataclass, field

from .models import Job

log = logging.getLogger(__name__)


@dataclass
class FetchReport:
    """What answered this run: source name / board id -> its row's
    `backfill` flag. Failed sources and boards are absent."""

    sources: dict[str, bool] = field(default_factory=dict)
    boards: dict[str, bool] = field(default_factory=dict)


def _known(state: dict, kind: str) -> set[str]:
    return set(state["_meta"].get(kind, []))


def record_known(state: dict, report: FetchReport) -> None:
    """Add every origin that answered this run to the known lists."""
    meta = state["_meta"]
    meta["known_sources"] = sorted(_known(state, "known_sources")
                                   | set(report.sources))
    meta["known_boards"] = sorted(_known(state, "known_boards")
                                  | set(report.boards))


def _path(key: str) -> str | None:
    """A board's URL path, or None when the key names no board.

    The dedup key up to its last "/", or up to "/job/" (Workday and Oracle
    put a per-location segment after it). A last segment with a query is a
    shared endpoint (Greenhouse embeds): only its `for=` tenant identifies
    the board, and without one the key is no evidence at all."""
    if "/job/" in key:
        return key.split("/job/", 1)[0]
    head, _, last = key.rpartition("/")
    if "?" not in last:
        return head
    tenant = re.search(r"[?&]for=([^&#]+)", last)
    return f"{head}/?for={tenant.group(1)}" if tenant else None


def first_sight(state: dict, raw_jobs: list[Job],
                report: FetchReport) -> dict[str, list[str]]:
    """Return {dedup_key: [first-sight origins]} for the jobs to seed.

    Call after dedupe (raw jobs carry their dedup_key) and BEFORE st.touch,
    so "new" and the bootstrap evidence both read last run's state. Does not
    write state; `record_known` does that."""
    jobs = state["jobs"]
    known_sources = _known(state, "known_sources")
    known_boards = _known(state, "known_boards")
    known_sources |= {s for e in jobs.values() for s in e.get("sources", [])}

    # Board evidence: state already holds a job under the same URL path,
    # ingested through the board's own source.
    board_sources = {job.source for job in raw_jobs if job.board}
    seen_paths = {(src, path) for key, e in jobs.items()
                  if (path := _path(key)) is not None
                  for src in e.get("sources", []) if src in board_sources}
    for job in raw_jobs:
        path = _path(job.dedup_key)
        if (job.board and job.board not in known_boards and path is not None
                and (job.source, path) in seen_paths):
            known_boards.add(job.board)

    def fresh(job: Job) -> str | None:
        """The first-sight origin this raw row came from, or None if known."""
        board_backfill = report.boards.get(job.board or "", False)
        if job.source not in known_sources:
            if report.sources.get(job.source, False) or board_backfill:
                return None
            return job.source
        if (job.board and job.board not in known_boards
                and not report.boards.get(job.board, False)):
            return job.board
        return None

    origins: dict[str, set[str]] = defaultdict(set)
    from_known: set[str] = set()
    for job in raw_jobs:
        if job.dedup_key in jobs:
            continue
        origin = fresh(job)
        if origin is None:
            from_known.add(job.dedup_key)
        else:
            origins[job.dedup_key].add(origin)
    return {k: sorted(v) for k, v in origins.items() if k not in from_known}


def mark_seeded(state: dict, keys: dict[str, list[str]],
                today: dt.date) -> None:
    """Tag each seeded key's (already touched) entry and log per origin."""
    iso = today.isoformat()
    per_origin: dict[str, int] = defaultdict(int)
    for key, origins in keys.items():
        state["jobs"].setdefault(key, {})["seeded"] = iso
        for origin in origins:
            per_origin[origin] += 1
    for origin, n in sorted(per_origin.items()):
        log.info("first sight of %s: seeded %d backlog job(s) without "
                 "evaluating (set backfill: true on its row to deliver)",
                 origin, n)
