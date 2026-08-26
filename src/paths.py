"""Where things live: the code checkout vs the instance data directory."""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def data_root() -> Path:
    """The instance data directory: INTERN_WATCH_DATA_DIR, else the code checkout."""
    raw = os.environ.get("INTERN_WATCH_DATA_DIR", "").strip()
    return Path(raw).expanduser().resolve() if raw else ROOT


DATA_ROOT = data_root()
