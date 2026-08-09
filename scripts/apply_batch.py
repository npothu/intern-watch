"""Batch apply runner: fill (and optionally submit) applications across a list
of jobs, screenshotting every page for review.

    python scripts/apply_batch.py --mode autofill          # fill + screenshot, NO submit
    python scripts/apply_batch.py --mode submit            # REAL submit
    python scripts/apply_batch.py --only wealthsimple,cohere

Screenshots land in state/apply_artifacts/<date>/<slug>/NN_*.png. For Workday
(no pre-existing account assumed) a login is synthesized from the profile email
+ a generated password, persisted to state/apply_sessions/created_accounts.json
so the account can be reused/recovered. Google SSO is preferred when offered.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from src import ledger as ledger_mod  # noqa: E402
from src.apply.auth import LoginAccount  # noqa: E402
from src.apply.base import ApplyContext, ApplyMode, ATSFamily  # noqa: E402
from src.apply.driver import browser_session  # noqa: E402
from src.apply.fillers import get_filler  # noqa: E402
from src.apply.inbox import Inbox  # noqa: E402
from src.apply.profile import detect_user, load_dotenv, load_profile  # noqa: E402
from src.apply.queue import _already_done, _record_submit_attempt  # noqa: E402
from src.apply.resolve import resolve  # noqa: E402

JOBS: list[tuple[str, str]] = [
    # user-provided
    ("gts-workday", "https://gtsgbu.wd3.myworkdayjobs.com/Careers/job/Toronto/Software-Analyst-Intern--Fall-2026--8-months-_R1013034"),
    ("1password-ashby", "https://jobs.ashbyhq.com/1password/d9909a9a-d941-404d-a7f2-5021670ffd2c/application"),
    ("tesla", "https://www.tesla.com/careers/search/job/273723"),
    ("abb", "https://careers.abb/global/en/job/ABB1GLOBALJR00036225EXTERNALENGLOBAL/AI-Data-Scientist-AI-Intern-Fall-2026"),
    # sourced Canadian fall internships
    # Wealthsimple is Canada-based: its Ashby form carries the Yes/No button
    # boolean "eligible to work in Canada?" (keeps the B2 fix regression-live).
    ("wealthsimple", "https://jobs.ashbyhq.com/wealthsimple/264f50e8-1900-4d6d-8b46-cf9835e93282/application"),
    ("cohere", "https://jobs.ashbyhq.com/cohere/8c035d3d-081d-4c8a-914a-72f4efaad254/application"),
    ("cloudflare-net", "https://boards.greenhouse.io/cloudflare/jobs/7917883"),
    ("anduril-ee", "https://boards.greenhouse.io/andurilindustries/jobs/5148101007"),
    ("openai", "https://jobs.ashbyhq.com/openai/0da75470-7e1e-44c3-90df-6f93cf90b968/application"),
    ("mongodb", "https://job-boards.greenhouse.io/mdbgeneralreferrals/jobs/7245989"),
]


def _gen_password() -> str:
    # Workday-compliant: upper, lower, digit, symbol, length >= 12.
    return "Aa1!" + secrets.token_urlsafe(10)


def _synth_workday_account(profile, store: Path) -> LoginAccount:
    """Prefer Google SSO; fall back to a generated email/password account that we
    persist so it can be reused/recovered."""
    store.parent.mkdir(parents=True, exist_ok=True)
    data = json.loads(store.read_text()) if store.exists() else {}
    rec = data.get(profile.email)
    if not rec:
        rec = {"email": profile.email, "password": _gen_password(),
               "method": "google",
               "first_name": profile.first_name, "last_name": profile.last_name}
        data[profile.email] = rec
        store.write_text(json.dumps(data, indent=1))
    return LoginAccount(**rec)


def _snapper(page, art: Path):
    n = {"i": 0}

    def snap(tag: str = "") -> None:
        n["i"] += 1
        safe = re.sub(r"[^a-z0-9]+", "-", tag.lower())[:30]
        try:
            page.screenshot(path=str(art / f"{n['i']:02d}_{safe}.png"),
                            full_page=True)
        except Exception:
            pass
    return snap


def _resume(profile) -> Path:
    # Generic attachment when no tailored per-company resume exists.
    if not profile.base_resume:
        raise SystemExit("no base_resume in the apply profile — set it to a "
                         "repo-relative .docx path in users/<you>_apply.yaml")
    return ROOT / profile.base_resume


def run_one(profile, user: str, slug: str, url: str, mode: ApplyMode,
            art_root: Path, inbox, store: Path, ledger: dict | None = None,
            ledger_path: Path | None = None) -> dict:
    final, family = resolve(url)
    art = art_root / slug
    art.mkdir(parents=True, exist_ok=True)
    account = (_synth_workday_account(profile, store)
               if family is ATSFamily.workday else None)
    match = {"key": slug, "company": slug, "url": url}
    out = {"slug": slug, "url": url, "final_url": final, "family": family.value}

    # In submit mode consult the permanent ledger FIRST (same guard as
    # queue.run_item): a job with a recorded submit_attempt — or a hand-ticked
    # applied record — is never re-submitted, so a re-run cannot double-submit.
    if mode is ApplyMode.submit and ledger is not None:
        done = _already_done(match, user, ledger)
        if done:
            out.update(status="skipped", message=f"ledger guard: {done}")
            return out

    try:
        filler = get_filler(family)
        with browser_session(profile, family) as page:
            snap = _snapper(page, art)
            page.on("framenavigated",
                    lambda f: (f == page.main_frame) and snap("nav"))
            page.goto(final, wait_until="domcontentloaded", timeout=60000)
            try:
                page.wait_for_timeout(3500)
            except Exception:
                pass
            snap("loaded")
            ctx = ApplyContext(job=match,
                               profile=profile, resume_path=_resume(profile),
                               mode=mode, final_url=final, family=family,
                               user=user, artifacts_dir=art, account=account,
                               inbox=inbox)
            res = filler.apply(page, ctx)
            snap("final")
            out.update(status=res.status.value, message=res.message,
                       filled=res.filled_fields, unfilled=res.unfilled_fields,
                       artifacts=str(art))
            # Persist a submit attempt the moment a filler clicks submit — same
            # ledger write run_item does — so this slug is never re-submittable.
            if (mode is ApplyMode.submit and ledger_path is not None
                    and res.submit_attempt is not None):
                today = dt.datetime.now(dt.UTC).date()
                _record_submit_attempt(match, res, user, today, ledger_path)
    except Exception as exc:
        out.update(status="error", message=f"{type(exc).__name__}: {exc}")
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["autofill", "submit"], default="autofill")
    ap.add_argument("--only", default="", help="comma-separated slugs to run")
    ap.add_argument("--provider", default="browserbase")
    ap.add_argument("--jobs-file", default="", help="JSON list of [slug, url] to run")
    ap.add_argument("--user", default="",
                    help="applicant (default: the sole users/*_apply.yaml)")
    args = ap.parse_args(argv)

    global JOBS
    if args.jobs_file:
        JOBS = [tuple(x) for x in json.loads(Path(args.jobs_file).read_text())]

    load_dotenv()
    user = args.user or detect_user()
    profile = load_profile(user)
    profile.cloud.provider = args.provider
    inbox = Inbox.from_config(profile.inbox)
    mode = ApplyMode(args.mode)
    today = dt.datetime.now(dt.UTC).date().isoformat()
    art_root = ROOT / "state" / "apply_artifacts" / today
    store = ROOT / "state" / "apply_sessions" / "created_accounts.json"

    # Submit mode is the only path that can double-submit, so it loads the
    # permanent applications ledger and threads it through run_one: skip slugs
    # the ledger blocks, and record a submit_attempt on every click. Autofill
    # (the E2E harness) stays exactly as-is — no ledger, no gating.
    ledger = ledger_path = None
    if mode is ApplyMode.submit:
        ledger_path = ledger_mod.ledger_path(ROOT)
        ledger = ledger_mod.load_ledger(ledger_path)

    only = {s.strip() for s in args.only.split(",") if s.strip()}
    jobs = [(s, u) for s, u in JOBS if not only or s in only]
    print(f"inbox: {'on' if inbox else 'OFF'} | mode: {mode.value} | "
          f"{len(jobs)} job(s)\n")

    results = []
    for slug, url in jobs:
        print(f"=== {slug} ===")
        r = run_one(profile, user, slug, url, mode, art_root, inbox, store,
                    ledger=ledger, ledger_path=ledger_path)
        if r.get("status") == "skipped":
            print(f"  {r['family']:10} {'skipped':14} {r.get('message', '')[:90]}")
            results.append(r)
            continue
        results.append(r)
        print(f"  {r['family']:10} {r.get('status', '?'):14} "
              f"{r.get('message', '')[:90]}")
        print(f"  filled={len(r.get('filled', []))} "
              f"unfilled={len(r.get('unfilled', []))} shots->{r.get('artifacts', '')}")

    art_root.mkdir(parents=True, exist_ok=True)
    (art_root / "results.json").write_text(json.dumps(results, indent=1))
    ok = sum(1 for r in results if r.get("status") in ("submitted", "filled_paused"))
    print(f"\n{ok}/{len(results)} reached fill/submit. results -> "
          f"{art_root / 'results.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
