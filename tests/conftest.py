import datetime as dt
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"
TODAY = dt.date(2026, 6, 11)  # the date the committed fixtures were snapshotted


@pytest.fixture
def fixtures() -> Path:
    return FIXTURES


@pytest.fixture
def today() -> dt.date:
    return TODAY
