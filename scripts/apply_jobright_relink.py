"""Apply retroactive jobright -> employer apply-url results to state/seen.json.

Merge the per-slice maps produced by resolve_jobright_ids.py and rewrite the
already-saved matches in state/seen.json so that any match whose url is still a
jobright.ai /jobs/info/ link gets its url updated to the real employer apply
url (the same resolution the cron performs at match time, applied backwards).

Preserves null / missing / unchanged resolutions: the match keeps its jobright url
(fails open, exactly like the cron). Also records the resolved url as
apply_url on the job entry (matching st.apply_url_put used by the cron), and
preserves jobright_url for provenance.

Usage:
    python scripts/apply_jobright_relink.py <seen.json> <map1.json> [map2.json ...]
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

_JR_INFO_RE = re.compile(r"^https://jobright\.ai/jobs/info/[0-9a-f]{24}$")

OUTPUT_VERSION = "relink-2026-08-05"


def load_map(path: Path) -> dict[str, str | None]:
    return json.loads(path.read_text())


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    seen_path = Path(argv[0])
    map_paths = [Path(p) for p in argv[1:]]

    merged: dict[str, str | None] = {}
    for p in map_paths:
        merged.update(load_map(p))

    seen = json.loads(seen_path.read_text())
    seen.setdefault("_meta", {})[OUTPUT_VERSION] = len(merged)

    updated = 0
    still_jobright = 0
    for user, matches in seen.get("matches", {}).items():
        for m in matches:
            jid = None
            key = m.get("key") or ""
            if key.startswith("jr:"):
                jid = key[3:]
            if jid is None or jid not in merged:
                continue
            resolved = merged.get(jid)
            if not resolved:
                # fails open: keep jobright link
                if (m.get("url") or "").startswith("https://jobright.ai/"):
                    still_jobright += 1
                continue
            if resolved.startswith("https://jobright.ai/"):
                continue  # guard: never point back at jobright
            old = m.get("url") or ""
            if old != resolved:
                if "jobright_url" not in m and old:
                    m["jobright_url"] = old  # provenance
                m["url"] = resolved
                updated += 1
    # also write apply_url onto job entries so future cron runs reuse the cache
    for key, entry in seen.get("jobs", {}).items():
        if key.startswith("jr:"):
            jid = key[3:]
            if jid in merged and merged.get(jid):
                if entry.get("apply_url") != merged[jid]:
                    entry["apply_url"] = merged[jid]

    # match src/state.py:save_state serialization exactly (indent=1, sort_keys)
    seen_path.write_text(json.dumps(seen, indent=1, sort_keys=True) + "\n",
                         newline="\n")
    print(f"merged {len(merged)} resolutions; updated {updated} match urls; "
          f"{still_jobright} matches keep jobright link (unresolved)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
