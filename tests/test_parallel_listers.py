"""Paged listers run LISTER_WORKERS hosts at a time (ats_boards.
prefetch_listers): same output as sequential, failures isolated, one host
never hit concurrently, per-host pacing kept. No live network."""

import random
import threading
import time
from collections import defaultdict

import httpx
import pytest

from src.adapters import ats_boards, jibe, listing_http
from src.adapters.ats_boards import AtsBoardsAdapter
from src.models import SourceConfig

from .conftest import TODAY

BOARDS = [
    ("Acme", "oracle", "pod1.fa.us2.oraclecloud.com/CX_1"),
    ("Bolt", "smartrecruiters", "Bolt"),
    ("Cobalt", "oracle", "pod2.fa.us2.oraclecloud.com/CX"),
    ("Dyna", "eightfold", "dyna.eightfold.ai/dyna.com"),
    ("Echo", "smartrecruiters", "Echo"),
    ("Flux", "jibe", "careers.flux.example"),
    ("Gamma", "oracle", "pod3.fa.us2.oraclecloud.com/CX_1"),
    ("Helix", "eightfold", "helix.eightfold.ai/helix.com"),
]


def _write(tmp_path, monkeypatch, boards=BOARDS):
    lines = ["boards:"] + [f"- {{company: {c}, ats: {a}, slug: '{s}'}}"
                           for c, a, s in boards]
    path = tmp_path / "boards.yaml"
    path.write_text("\n".join(lines) + "\n")
    monkeypatch.setattr(ats_boards, "ROOT", tmp_path)
    monkeypatch.setattr(ats_boards, "DATA_ROOT", tmp_path)
    return AtsBoardsAdapter(SourceConfig(
        name="ats-boards", adapter="ats_boards", boards_file="boards.yaml"))


def _page(req, n_rows=3):
    """A complete one-page answer in each lister's shape (2 interns + 1
    non-intern), ids unique per host, with a small random service delay."""
    time.sleep(random.uniform(0.001, 0.01))
    host = req.url.host
    tag = abs(hash(host)) % 10_000
    if "oraclecloud" in host:
        return {"items": [{"TotalJobsCount": n_rows, "requisitionList": [
            {"Id": f"{tag}{i}", "Title": "Software Intern" if i < 2 else
             "Manager", "PrimaryLocation": "Austin, TX, United States",
             "PostedDate": "2026-06-01"} for i in range(n_rows)]}]}
    if "eightfold" in host:
        return {"data": {"count": n_rows, "positions": [
            {"id": tag * 10 + i, "name": "Software Intern" if i < 2 else
             "Manager", "locations": ["Austin, TX, US"]}
            for i in range(n_rows)]}}
    if "smartrecruiters" in host:
        company = req.url.path.split("/")[3]
        return {"totalFound": n_rows, "content": [
            {"id": f"{abs(hash(company)) % 10_000}{i}",
             "name": "Software Intern" if i < 2 else "Manager",
             "location": {"city": "Austin", "region": "TX", "country": "us"}}
            for i in range(n_rows)]}
    return {"totalCount": n_rows, "jobs": [
        {"data": {"req_id": f"{tag}{i}", "title": "Software Intern" if i < 2
                  else "Manager", "full_location": "Austin, Texas"}}
        for i in range(n_rows)]}


@pytest.fixture(autouse=True)
def fast(monkeypatch):
    monkeypatch.setattr(listing_http, "sleep", lambda s: None)


def _fetch(adapter, handler, workers, monkeypatch):
    monkeypatch.setattr(ats_boards, "LISTER_WORKERS", workers)
    with httpx.Client(transport=httpx.MockTransport(handler)) as c:
        jobs = adapter.fetch(c, TODAY)
    return ([(j.board, j.url, j.title) for j in jobs],
            dict(adapter.fetched_boards))


def test_parallel_output_matches_sequential(tmp_path, monkeypatch):
    def handler(req):
        return httpx.Response(200, json=_page(req))

    seq = _fetch(_write(tmp_path, monkeypatch), handler, 1, monkeypatch)
    par = _fetch(_write(tmp_path, monkeypatch), handler, 4, monkeypatch)
    assert par == seq
    rows, known = par
    assert rows
    # board order preserved: rows come out grouped in yaml order
    order = list(dict.fromkeys(board for board, _u, _t in rows))
    assert order == [ats_boards.board_id({"ats": a, "slug": s})
                     for _c, a, s in BOARDS]
    assert set(known) == set(order)


def test_failing_board_fails_alone_in_the_pool(tmp_path, monkeypatch):
    def handler(req):
        if req.url.host == "pod2.fa.us2.oraclecloud.com":
            return httpx.Response(500)
        return httpx.Response(200, json=_page(req))

    rows, known = _fetch(_write(tmp_path, monkeypatch), handler, 4, monkeypatch)
    bad = "oracle:pod2.fa.us2.oraclecloud.com/cx"
    assert bad not in known
    assert all(board != bad for board, _u, _t in rows)
    assert len(known) == len(BOARDS) - 1


def test_malformed_lister_row_fails_alone(tmp_path, monkeypatch):
    boards = BOARDS[:2] + [("Bad", "oracle", "no-site-here")]
    rows, known = _fetch(_write(tmp_path, monkeypatch, boards),
                         lambda req: httpx.Response(200, json=_page(req)), 4,
                         monkeypatch)
    assert len(known) == 2 and "oracle:no-site-here" not in known


def test_same_host_requests_are_never_concurrent(tmp_path, monkeypatch):
    lock = threading.Lock()
    live: dict[str, int] = defaultdict(int)
    worst: dict[str, int] = defaultdict(int)
    overall = {"now": 0, "max": 0}

    def handler(req):
        host = req.url.host
        with lock:
            live[host] += 1
            overall["now"] += 1
            worst[host] = max(worst[host], live[host])
            overall["max"] = max(overall["max"], overall["now"])
        time.sleep(0.03)
        try:
            return httpx.Response(200, json=_page(req))
        finally:
            with lock:
                live[host] -= 1
                overall["now"] -= 1

    _fetch(_write(tmp_path, monkeypatch), handler, 4, monkeypatch)
    assert max(worst.values()) == 1                  # never 2 on one host
    assert overall["max"] > 1                        # but hosts overlapped
    # the two SmartRecruiters boards share api.smartrecruiters.com
    assert worst["api.smartrecruiters.com"] == 1


def test_per_host_pacing_holds_under_concurrency(tmp_path, monkeypatch):
    # Every request on a host after its first is preceded, in that host's
    # worker thread, by a pause of at least the host's delay.
    events: dict[int, list] = defaultdict(list)
    monkeypatch.setattr(listing_http, "sleep",
                        lambda s: events[threading.get_ident()].append(("sleep", s)))
    monkeypatch.setitem(jibe.CRAWL_DELAY, "careers.flux.example", 5.0)

    def handler(req):
        events[threading.get_ident()].append(("req", req.url.host))
        return httpx.Response(200, json=_page(req, n_rows=3))

    _fetch(_write(tmp_path, monkeypatch), handler, 4, monkeypatch)
    # A pool thread can run several host groups in turn: the requirement
    # holds between consecutive requests to the SAME host.
    for seq in events.values():
        last_host = None
        paused = 0.0
        for kind, val in seq:
            if kind == "sleep":
                paused = max(paused, val)
                continue
            if val == last_host:
                need = (5.0 if val == "careers.flux.example"
                        else listing_http.REQUEST_DELAY)
                assert paused >= need, (val, seq)
            last_host, paused = val, 0.0


def test_lister_requests_never_carry_the_github_token(tmp_path, monkeypatch):
    from src.adapters.base import GitHubTokenAuth
    auths = []

    def handler(req):
        auths.append(req.headers.get("Authorization"))
        return httpx.Response(200, json=_page(req))

    adapter = _write(tmp_path, monkeypatch)
    with httpx.Client(transport=httpx.MockTransport(handler),
                      auth=GitHubTokenAuth("tok")) as c:
        adapter.fetch(c, TODAY)
    assert auths and all(a is None for a in auths)
