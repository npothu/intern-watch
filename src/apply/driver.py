"""Apply-side adapter over the shared browser-session helper (`src.browser`).

The generic session machinery (Browserbase/local backends, storage_state
persistence, artifact screenshots) lives in `src.browser.session`. This module
only maps the apply subsystem's domain types onto it: an `ApplyProfile`'s
`CloudConfig` becomes a `BrowserConfig`, and the persisted Playwright
storage_state is keyed per ATS family via `profile.session_path(family)` so a
one-time interactive login (Workday, Google) is reused across runs.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import TYPE_CHECKING

from src.browser import BrowserConfig, connect_url, save_artifact_screenshot  # noqa: F401
from src.browser import browser_session as _shared_session

from .base import ATSFamily

if TYPE_CHECKING:
    from playwright.sync_api import Page

    from .profile import ApplyProfile


@contextmanager
def browser_session(profile: ApplyProfile,
                    family: ATSFamily) -> Iterator[Page]:
    """Yield a Playwright Page for `family`, persisting storage_state on exit."""
    config = BrowserConfig(provider=profile.cloud.provider,
                           headless=profile.cloud.headless,
                           api_key_env=profile.cloud.api_key_env,
                           project_id_env=profile.cloud.project_id_env,
                           session_timeout_s=profile.cloud.session_timeout_s)
    with _shared_session(config,
                         storage_path=profile.session_path(family.value),
                         ) as page:
        yield page
