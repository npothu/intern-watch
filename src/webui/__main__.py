"""Run the local application-manager UI.

    python -m src.webui [--user NAME] [--port 8765] [--no-fetch] [--no-browser]

Serves a single-page dashboard on localhost: matches from origin/main's
state/seen.json, applied toggles written through the GitHub dashboard issue
(token from GITHUB_TOKEN or `gh auth token`), tailored resume builds via the
local src.resume pipeline into out/. Local-only tooling -- never part of the
watcher cron.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import webbrowser
from pathlib import Path

from ..filters import load_users
from .server import Hub, make_server

ROOT = Path(__file__).resolve().parents[2]


def _load_dotenv(path: Path) -> None:
    """Minimal KEY=VALUE loader (no dependency): the resume LLM rewrite wants
    GEMINI_API_KEY, which lives in .env locally. Existing env vars win."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip().strip("'\""))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m src.webui",
                                 description=__doc__)
    ap.add_argument("--user", default="",
                    help="watcher user (default: the sole users/*.yaml)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-fetch", action="store_true",
                    help="skip `git fetch` (use last-known origin/main)")
    ap.add_argument("--no-browser", action="store_true",
                    help="don't open the page automatically")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO,
                        format="%(levelname)s %(name)s: %(message)s")
    _load_dotenv(ROOT / ".env")

    users = {u["name"]: u for u in load_users(ROOT / "users")}
    if not users:
        print("no watcher configs in users/*.yaml", file=sys.stderr)
        return 1
    user = args.user or (next(iter(users)) if len(users) == 1 else "")
    if not user:
        print(f"several users configured ({', '.join(sorted(users))}) — "
              "pick one with --user", file=sys.stderr)
        return 1
    if user not in users:
        print(f"unknown user {user!r} (have: {', '.join(sorted(users))})",
              file=sys.stderr)
        return 1

    hub = Hub(ROOT, user, list(users[user].get("terms_wanted", [])),
              fetch=not args.no_fetch)
    hub.refresh()
    for warning in hub.warnings:
        print(f"warning: {warning}", file=sys.stderr)

    server = make_server(hub, args.host, args.port)
    url = f"http://{args.host}:{args.port}/"
    print(f"intern-watch webui for {user!r}: {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
