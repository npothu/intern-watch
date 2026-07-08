"""Re-download test fixtures from the live sources.

    python scripts/refresh_fixtures.py

Pulls every file referenced in sources.yaml, saves markdown snapshots under
tests/fixtures/, and regenerates the trimmed simplify sample (the full
listings.json is ~12 MB and is NOT committed). After refreshing, update
tests/conftest.py TODAY to today's date and fix any spot-check assertions in
test_adapters.py that referenced rows that have since rotated out.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import httpx
import yaml

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "tests" / "fixtures"

FIXTURE_NAMES = {
    ("simplify", ".github/scripts/listings.json"): "_full_simplify_listings.json",
    ("jobright-swe", "README.md"): "jobright_swe_README.md",
    ("jobright-eng", "README.md"): "jobright_eng_README.md",
    ("jobright-pm", "README.md"): "jobright_pm_README.md",
    ("vanshb03-2027", "README.md"): "vanshb03_README.md",
    ("vanshb03-2027", "OFFSEASON_README.md"): "vanshb03_OFFSEASON_README.md",
    ("speedyapply", "README.md"): "speedyapply_README.md",
}

SAMPLE_TERMS = {"Fall 2026", "Spring 2027", "Summer 2027", "Summer 2026", "N/A"}


def trim_simplify_sample(full_path: Path, out_path: Path) -> int:
    full = json.loads(full_path.read_text(encoding="utf-8"))
    sample, counts = [], {}
    inactive = 0
    for entry in full:
        if not (entry.get("active") and entry.get("is_visible")):
            if inactive < 3:
                inactive += 1
                sample.append(entry)
            continue
        terms = set(entry.get("terms") or [])
        if terms & SAMPLE_TERMS or len(terms) > 1:
            key = tuple(sorted(terms))
            counts[key] = counts.get(key, 0) + 1
            if counts[key] <= 5:
                sample.append(entry)
    out_path.write_text(json.dumps(sample, indent=1) + "\n", encoding="utf-8")
    return len(sample)


def main() -> int:
    sources = {s["name"]: s for s in yaml.safe_load(
        (ROOT / "sources.yaml").read_text(encoding="utf-8"))["sources"]}
    with httpx.Client(follow_redirects=True, timeout=60.0) as client:
        for (source_name, file_path), fixture_name in FIXTURE_NAMES.items():
            src = sources.get(source_name)
            if src is None:
                print(f"SKIP {fixture_name}: source '{source_name}' not in sources.yaml")
                continue
            url = (f"https://raw.githubusercontent.com/{src['repo']}/"
                   f"{src['branch']}/{file_path}")
            resp = client.get(url)
            resp.raise_for_status()
            (FIXTURES / fixture_name).write_text(resp.text, encoding="utf-8")
            print(f"OK   {fixture_name}  ({len(resp.text):,} bytes)")
    n = trim_simplify_sample(FIXTURES / "_full_simplify_listings.json",
                             FIXTURES / "simplify_listings.sample.json")
    print(f"OK   simplify_listings.sample.json  ({n} entries)")
    print("\nNow update tests/conftest.py TODAY and re-run pytest.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
