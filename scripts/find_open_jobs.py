"""Pull currently-open intern postings from the ats-boards adapter (live
Greenhouse/Lever/Ashby APIs), filter to Canadian/Fall on DIRECT ATS hosts
(no bot-blocking redirects), write [slug,url] picks to state/open_jobs.json."""
from __future__ import annotations

import datetime as dt
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import httpx

from src.adapters.ats_boards import AtsBoardsAdapter
from src.models import SourceConfig

CA = ("canada", "toronto", "vancouver", "montreal", "ottawa", "waterloo",
      "ontario", "quebec", "british columbia", ", on", ", bc", ", qc", "alberta")
DIRECT = ("jobs.ashbyhq.com", "job-boards.greenhouse.io", "boards.greenhouse.io")

ad = AtsBoardsAdapter(SourceConfig(name="ats-boards", adapter="ats_boards",
                                   boards_file="data/ats_boards.yaml"))
with httpx.Client(timeout=30, follow_redirects=True,
                  headers={"User-Agent": "Mozilla/5.0"}) as c:
    jobs = ad.fetch(c, dt.date(2026, 6, 18))

def is_ca(j): return any(any(k in loc.lower() for k in CA) for loc in j.locations)
def is_fall(j): return any("Fall" in t for t in j.terms)
def direct(j): return any(h in j.url for h in DIRECT)

cand = [j for j in jobs if direct(j) and (is_ca(j) or is_fall(j))]
cand.sort(key=lambda j: (not (is_ca(j) and is_fall(j)), not is_ca(j)))
seen, picks = set(), []
for j in cand:
    if j.company in seen:
        continue
    seen.add(j.company)
    slug = re.sub(r"[^a-z0-9]+", "-", j.company.lower()).strip("-")
    picks.append((slug, j.url, j.company, j.title, j.terms, j.locations[:2]))
    if len(picks) >= 7:
        break

out = ROOT / "state" / "open_jobs.json"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps([[s, u] for s, u, *_ in picks], indent=1))
print(f"wrote {len(picks)} open direct-ATS jobs -> {out}\n")
for s, _u, comp, title, terms, locs in picks:
    print(f"{s:14} {comp} | {title[:45]} | {terms} | {locs}")
