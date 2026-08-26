"""Shared minimal .env loader for local runs.

The repo-roots `users/` and the locale of local tooling (webui, watcher, auto-
apply) read secrets like STORE, CONVEX_URL, CONVEX_SECRET and GEMINI_API_KEY
from the environment. On laptop runs those live in a gitignored `.env` that the
shell never exports, so the processes would otherwise silently miss them (e.g.
a local `python -m src.webui` falling back to the GitHub driver). In GitHub
Actions there is no `.env`, so loading is a silent no-op there.

`load_dotenv` is intentionally dependency-free (no python-dotenv): it only sets
keys that are NOT already in os.environ (setdefault semantics), so a genuinely
exported env var or an Actions-provided secret always wins over the file, and a
missing file is a no-op.
"""

from __future__ import annotations

import os
from pathlib import Path

from .paths import DATA_ROOT as DATA_ROOT
from .paths import ROOT as ROOT


def load_dotenv(path: Path | None = None) -> None:
    """Read KEY=VALUE lines from `path` into os.environ for keys not already
    present. Defaults to the data-root .env when present, then the code-root
    .env. Comments and blank lines are skipped; surrounding quotes on values
    are stripped. A missing file is a silent no-op."""
    if path is None:
        data_path = DATA_ROOT / ".env"
        path = data_path if data_path.exists() else ROOT / ".env"
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip().strip('"').strip("'")
        os.environ.setdefault(key, val)
