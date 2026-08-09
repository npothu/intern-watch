"""Shared browser automation helpers (Browserbase / local Playwright)."""

from .session import BrowserConfig, browser_session, connect_url, save_artifact_screenshot

__all__ = [
    "BrowserConfig",
    "browser_session",
    "connect_url",
    "save_artifact_screenshot",
]
