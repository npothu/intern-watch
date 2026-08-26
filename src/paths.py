"""Where things live: the code checkout vs the instance data directory."""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

_ENV_KEY = "INTERN_WATCH_DATA_DIR"


def _from_dotenv() -> str:
    """`INTERN_WATCH_DATA_DIR=` from the code checkout's gitignored .env.
    Read here, not via envfile.load_dotenv, because DATA_ROOT is resolved at
    import time and envfile itself needs DATA_ROOT to pick a default."""
    try:
        lines = (ROOT / ".env").read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    for raw in lines:
        line = raw.strip()
        if line.startswith(f"{_ENV_KEY}="):
            return line.split("=", 1)[1].strip().strip("'\"")
    return ""


def data_root() -> Path:
    """The instance data directory: INTERN_WATCH_DATA_DIR from the environment,
    else from the code checkout's .env, else the code checkout itself."""
    raw = os.environ.get(_ENV_KEY, "").strip() or _from_dotenv()
    return Path(raw).expanduser().resolve() if raw else ROOT


DATA_ROOT = data_root()
