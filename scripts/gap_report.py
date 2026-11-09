"""Coverage-gap report: hand-added postings -> missing ats_boards.yaml rows.

    python scripts/gap_report.py                  # markdown (the issue body)
    python scripts/gap_report.py --format yaml    # just the paste-ready rows
    INTERN_BADDIE_DATA_DIR=<data repo> python scripts/gap_report.py

Reads state/applications.json from the data dir (plus Convex matches and
ledger when STORE=convex), never writes state. Logic lives in src/coverage.py.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.coverage import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
