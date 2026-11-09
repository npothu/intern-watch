"""Discover which companies from data/*.txt have public ATS job boards.

    python scripts/discover_ats_boards.py

Probes the official public JSON APIs of Greenhouse, Lever, and Ashby with
slug candidates derived from each company's name and aliases, then writes
data/ats_boards.yaml (sorted, stable). Re-run any time the company lists
change; review the diff before committing -- a short alias can occasionally
match an unrelated company's board.

Rows this script cannot probe survive a re-run: any row marked
`manual: true` (a hand-added slug discovery misses) and any row for an ATS
outside PROBED_ATS (Oracle, Eightfold, ... -- their boards are a pod/tenant
plus site, not a name-derived slug, so they are always hand-added).

Workday career sites cannot be guessed from a name (tenant, wdN host and site
name are all arbitrary), so --workday seeds candidates from Workday URLs the
instance has already seen: the applications ledger (every employer applied to)
plus delivered/outboxed matches whose employer is in data/top_companies.txt.
It reads state/*.json from the data repo's origin/main (INTERN_BADDIE_DATA_DIR)
and verifies each candidate by listing its intern postings.

Those candidates come from one instance's history, so they must not all land
in the public template: a board whose employer is in data/top_companies.txt or
data/atlanta_companies.txt is added to data/ats_boards.yaml; every other one is
written to the instance overlay DATA_ROOT/data/ats_boards.local.yaml (merged
after the template at run time, gitignored here). Existing template rows are
kept either way, and the default mode keeps workday rows.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

import httpx
import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
COMPANY_FILES = ["data/top_companies.txt", "data/atlanta_companies.txt"]
OUT_PATH = ROOT / "data" / "ats_boards.yaml"

PROBED_ATS = ("greenhouse", "lever", "ashby", "smartrecruiters")
CONCURRENCY = 12
MIN_SLUG_LEN = 3   # 1-2 char slugs ("ea") collide too easily


def load_companies() -> list[tuple[str, list[str]]]:
    """[(canonical, [name variants...])]"""
    out = []
    for rel in COMPANY_FILES:
        for line in (ROOT / rel).read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if not line:
                continue
            names = [n.strip() for n in line.split("|") if n.strip()]
            if names:
                out.append((names[0], names))
    return out


def slug_candidates(names: list[str]) -> list[str]:
    cands: list[str] = []
    for name in names:
        clean = re.sub(r"[^a-z0-9 ]", "", name.lower().replace("&", " and "))
        clean = re.sub(r"\s+", " ", clean).strip()
        if not clean:
            continue
        joined = clean.replace(" ", "")
        hyphen = clean.replace(" ", "-")
        for c in (joined, hyphen):
            if len(c) >= MIN_SLUG_LEN and c not in cands:
                cands.append(c)
    return cands


def sr_slug_candidates(names: list[str]) -> list[str]:
    """SmartRecruiters company-ids are PascalCase with no separators
    ("Visa", "McDonalds"), so add those on top of the lower-case forms."""
    cands = list(slug_candidates(names))
    for name in names:
        cleaned = name.replace("&", " and ").replace("'", "").replace("’", "")
        words = re.findall(r"[A-Za-z0-9]+", cleaned)
        pascal = "".join(w[:1].upper() + w[1:] for w in words)
        if len(pascal) >= MIN_SLUG_LEN and pascal not in cands:
            cands.append(pascal)
    return cands


async def probe(client: httpx.Client, ats: str, slug: str) -> bool:
    urls = {
        "greenhouse": f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs",
        "lever": f"https://api.lever.co/v0/postings/{slug}?limit=1&mode=json",
        "ashby": f"https://api.ashbyhq.com/posting-api/job-board/{slug}",
        "smartrecruiters": ("https://api.smartrecruiters.com/v1/companies/"
                            f"{slug}/postings?limit=1"),
    }
    try:
        resp = await client.get(urls[ats])
        if resp.status_code != 200:
            return False
        data = resp.json()
        # Require at least one posting: Ashby answers 200 + empty jobs for ANY
        # slug (phantom boards), and an empty Greenhouse/Lever board is stale.
        if ats == "lever":
            return isinstance(data, list) and len(data) > 0
        if ats == "smartrecruiters":
            # SmartRecruiters answers 200 with totalFound 0 for unknown slugs.
            return bool(data.get("content"))
        jobs = data.get("jobs")
        return isinstance(jobs, list) and len(jobs) > 0
    except Exception:  # noqa: BLE001
        return False


async def discover() -> list[dict]:
    companies = load_companies()
    sem = asyncio.Semaphore(CONCURRENCY)
    found: list[dict] = []

    async with httpx.AsyncClient(timeout=15.0, headers={
            "User-Agent": "intern-baddie board discovery"}) as client:

        async def check_company(canonical: str, names: list[str]) -> None:
            for ats in PROBED_ATS:
                cands = (sr_slug_candidates(names) if ats == "smartrecruiters"
                         else slug_candidates(names))
                for slug in cands:
                    async with sem:
                        ok = await probe(client, ats, slug)
                    if ok:
                        found.append({"company": canonical, "ats": ats,
                                      "slug": slug})
                        print(f"  {canonical}: {ats}/{slug}")
                        break   # one slug per ATS is enough

        await asyncio.gather(*(check_company(c, ns) for c, ns in companies))
    return found


def preserved_rows(existing: list[dict]) -> list[dict]:
    """Rows a re-run must keep: hand-added (`manual: true`) or for an ATS
    this script does not probe."""
    return [b for b in existing
            if b.get("manual") or b.get("ats") not in PROBED_ATS]


def merge_boards(found: list[dict], existing: list[dict]) -> list[dict]:
    """Discovered rows plus preserved ones, deduped on (ats, slug), sorted."""
    out: dict[tuple[str, str], dict] = {}
    for b in preserved_rows(existing) + found:
        out.setdefault((b["ats"], str(b["slug"]).lower()), b)
    return sorted(out.values(),
                  key=lambda b: (b["company"].lower(), b["ats"], str(b["slug"])))


# ------------------------------------------------------------------ workday

_WD_URL_RE = re.compile(
    r"https?://([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com/"
    r"(?:[a-z]{2}-[a-z]{2}/)?([A-Za-z0-9_-]+)/", re.I)
# Sites that are not a public career site (internal-only postings, talent
# communities) -- they 404 or list nothing for an anonymous visitor.
_WD_SKIP_SITE_RE = re.compile(r"private|internal|confidential|talent_?community", re.I)


def _read_state(name: str) -> dict:
    """state/<name> from the data repo's origin/main (the local checkout is
    usually stale), falling back to the working tree."""
    from src.paths import DATA_ROOT
    try:
        raw = subprocess.run(
            ["git", "-C", str(DATA_ROOT), "show", f"origin/main:state/{name}"],
            check=True, capture_output=True, text=True).stdout
    except (OSError, subprocess.CalledProcessError):
        path = DATA_ROOT / "state" / name
        if not path.exists():
            return {}
        raw = path.read_text(encoding="utf-8")
    return json.loads(raw)


def workday_candidates() -> dict[str, dict]:
    """{tenant: {"host": wdN, "sites": Counter, "companies": Counter,
    "wanted": bool}} from every Workday URL in state. A tenant is wanted when
    the ledger holds an application there or a top-company match links it."""
    from src.filters import TOP_COMPANIES, CompanyList
    from src.paths import ROOT as CODE_ROOT
    top = CompanyList(CODE_ROOT / TOP_COMPANIES)
    seen = _read_state("seen.json")
    ledger = _read_state("applications.json")
    tenants: dict[str, dict] = {}

    def note(url: str, company: str | None = None, wanted: bool = False) -> None:
        m = _WD_URL_RE.match(url or "")
        if not m:
            return
        tenant, host, site = m.group(1).lower(), m.group(2).lower(), m.group(3)
        t = tenants.setdefault(tenant, {"host": host, "sites": Counter(),
                                        "companies": Counter(), "wanted": False})
        if not _WD_SKIP_SITE_RE.search(site):
            t["sites"][site] += 1
        if company:
            t["companies"][company] += 1
        t["wanted"] = t["wanted"] or wanted

    for key in seen.get("url_index", {}).values():
        if key.startswith("url:"):
            note(key[4:])
    for key in seen.get("jobs", {}):
        if key.startswith("url:"):
            note(key[4:])
    for bucket in ("matches", "outbox"):
        for items in seen.get(bucket, {}).values():
            for item in items:
                company = item.get("company") or ""
                note(item.get("url") or "", company,
                     wanted=bool(company) and top.match(company))
    for entries in ledger.values():
        for entry in (entries.values() if isinstance(entries, dict) else entries):
            note(entry.get("url") or "", entry.get("company"), wanted=True)
            note(entry.get("key", "").removeprefix("url:"), entry.get("company"),
                 wanted=True)
    return {t: v for t, v in tenants.items() if v["wanted"] and v["sites"]}


def _site_votes(sites: Counter) -> list[str]:
    """Distinct sites, most-linked first; case variants of one site merge
    and keep their most common spelling."""
    merged: dict[str, Counter] = {}
    for site, n in sites.items():
        merged.setdefault(site.lower(), Counter())[site] += n
    ranked = sorted(merged.values(), key=lambda c: -sum(c.values()))
    return [c.most_common(1)[0][0] for c in ranked]


def _wd_reqs(slug: str) -> set[str] | None:
    """Intern/co-op postings a career site lists now, by externalPath (the
    part after the site segment, so the same posting on two sites of one
    tenant counts once; a trailing repost counter "-1" is dropped because
    sites of one tenant suffix the same posting differently), or None if the
    site doesn't answer."""
    from src.adapters import workday_api as wd
    try:
        rows = json.loads(wd.fetch_listing(slug))["jobPostings"]
    except Exception:  # noqa: BLE001
        return None
    return {re.sub(r"-\d+$", "", r["externalPath"].lower()) for r in rows
            if wd._INTERN_RE.search(r.get("title") or "")}


def discover_workday() -> list[dict]:
    """Per wanted tenant, the career sites worth polling: every answering
    site (up to the 4 most linked) that lists intern requisitions no site
    already chosen lists -- a tenant's main site often has none while its
    early-careers site has them all. A tenant with no intern postings right
    now keeps its most-linked answering site. Sequential and polite."""
    cands = workday_candidates()
    print(f"{len(cands)} candidate workday tenants")
    found: list[dict] = []
    for tenant, info in sorted(cands.items()):
        company = info["companies"].most_common(1)[0][0]
        probed = []
        for site in _site_votes(info["sites"])[:4]:
            slug = f"{tenant}.{info['host']}/{site}"
            reqs = _wd_reqs(slug)
            if reqs is not None:
                probed.append((slug, reqs))
        if not probed:
            print(f"  {tenant}: no answering site in {list(info['sites'])}")
            continue
        covered: set[str] = set()
        chosen = []
        for slug, reqs in sorted(probed, key=lambda p: -len(p[1])):
            if reqs - covered or not chosen:
                chosen.append(slug)
                covered |= reqs
                print(f"  {company}: workday/{slug} ({len(reqs)} intern postings)")
        found += [{"company": company, "ats": "workday", "slug": s} for s in chosen]
    return found


def write_boards(boards: list[dict], path: Path = OUT_PATH,
                 header: str = "") -> None:
    boards = sorted(boards, key=lambda b: (b["company"].lower(), b["ats"], b["slug"]))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        (header or
         "# Generated by scripts/discover_ats_boards.py -- review before committing.\n"
         "# A company may legitimately appear on multiple ATS (migrations);\n"
         "# delete rows that look stale or wrong.\n")
        + yaml.safe_dump({"boards": boards}, sort_keys=False),
        encoding="utf-8")
    companies = {b["company"] for b in boards}
    print(f"\n{len(boards)} boards across {len(companies)} companies -> {path}")


LOCAL_HEADER = (
    "# Instance-only ATS boards, merged after the template's data/ats_boards.yaml.\n"
    "# Discovered from this instance's own applications by\n"
    "# scripts/discover_ats_boards.py --workday; keep it in the private data repo.\n")


def _existing(keep, path: Path = OUT_PATH) -> list[dict]:
    if not path.exists():
        return []
    rows = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return [b for b in rows.get("boards") or [] if keep(b)]


def split_workday(found: list[dict], template: list[dict]) -> tuple[list[dict], list[dict]]:
    """(rows to add to the template, rows for the instance overlay). Only
    employers on the checked-in company lists may enter the public template;
    rows the template already has are dropped from both."""
    from src.filters import CompanyList
    from src.paths import ROOT as CODE_ROOT
    lists = [CompanyList(CODE_ROOT / rel) for rel in COMPANY_FILES]
    have = {(b["ats"], b["slug"]) for b in template}
    public, local = [], []
    for row in found:
        if (row["ats"], row["slug"]) in have:
            continue
        (public if any(cl.match(row["company"]) for cl in lists)
         else local).append(row)
    return public, local


def main_workday() -> int:
    """--workday: template rows + list-employer boards; the rest to the overlay."""
    from src.adapters.ats_boards import local_boards_path
    local_path = local_boards_path(str(OUT_PATH.relative_to(ROOT)))
    template = _existing(lambda b: True)
    public, local = split_workday(discover_workday(), template)
    write_boards(template + public)
    write_boards(_existing(lambda b: b["ats"] != "workday", local_path) + local,
                 local_path, LOCAL_HEADER)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--workday", action="store_true",
                    help="probe Workday sites seeded from the instance's state")
    if ap.parse_args().workday:
        return main_workday()
    existing = []
    if OUT_PATH.exists():
        existing = (yaml.safe_load(OUT_PATH.read_text(encoding="utf-8"))
                    or {}).get("boards") or []
    boards = merge_boards(discover_sync(), existing)
    OUT_PATH.write_text(
        "# Generated by scripts/discover_ats_boards.py -- review before committing.\n"
        "# A company may legitimately appear on multiple ATS (migrations);\n"
        "# delete rows that look stale or wrong.\n"
        + yaml.safe_dump({"boards": boards}, sort_keys=False),
        encoding="utf-8")
    companies = {b["company"] for b in boards}
    print(f"\n{len(boards)} boards across {len(companies)} companies "
          f"-> {OUT_PATH.relative_to(ROOT)}")
    return 0


def discover_sync() -> list[dict]:
    return asyncio.run(discover())


if __name__ == "__main__":
    sys.exit(main())
