"""CLI for the auto-apply subsystem.

    # see what would be applied to, with resolved ATS + eligibility (no browser):
    python -m src.apply list --user alex
    python -m src.apply plan --user alex --mode submit

    # fill one job and PAUSE for review (default mode):
    python -m src.apply apply --user alex --key jr:abc... --provider local

    # approve a job for gated submit, then submit it:
    python -m src.apply approve --user alex --key jr:abc...
    python -m src.apply apply --user alex --key jr:abc... --mode submit

    # work the whole queue (autofill everything not yet applied):
    python -m src.apply drain --user alex --limit 5

    # dress rehearsal: which questions does the answer book cover? Read-only,
    # ALWAYS the free local browser unless --provider browserbase is explicit:
    python -m src.apply coverage --user alex --key jr:abc...

`--provider` overrides the profile's cloud backend (local | browserbase) for the
run — handy to drive a visible local Chromium even when the profile defaults to
the hosted cloud browser. `--dry-run` resolves URLs and prints the plan without
opening a browser or writing state.
"""

from __future__ import annotations

import argparse
import datetime as dt
import sys
from pathlib import Path

from .. import ledger as ledger_mod
from ..paths import DATA_ROOT as DATA_ROOT
from .auth import load_logins
from .base import ApplyMode
from .coverage import format_table, run_coverage
from .profile import load_dotenv, load_profile
from .queue import DEFAULT_STATE, build_plan, load_matches, run_item, save
from .queue import approve as approve_match
from .resolve import resolve


def _today() -> dt.date:
    return dt.datetime.now(dt.UTC).date()


def _print_plan(plan, mode: ApplyMode) -> None:
    if not plan:
        print("(no matches)")
        return
    print(f"{'STATUS':<10} {'FAMILY':<11} {'ELIGIBLE':<9} COMPANY / KEY")
    for it in plan:
        st = it.match.get("apply_status", "-")
        elig = "yes" if it.eligible else f"no:{it.skip_reason}"
        print(f"{st:<10} {it.family.value:<11} {elig:<9} "
              f"{it.company} [{it.key}]")
    print(f"\n{sum(1 for it in plan if it.eligible)}/{len(plan)} eligible "
          f"for mode={mode.value}")


def coverage_provider(cli_provider: str) -> str:
    """The browser provider for a coverage run. The cost guarantee: coverage
    NEVER defaults to the metered cloud browser, whatever the profile says -
    only an explicit --provider browserbase opts in."""
    return cli_provider or "local"


def _cmd_coverage(args, profile, state_path: Path) -> int:
    """The `coverage` subcommand: answer-book dress rehearsal for one job.
    Read-only page visit (no filling, no submitting, no account creation);
    Workday exits cleanly with an unsupported report and NO browser session."""
    if not args.key:
        print("--key required for coverage", file=sys.stderr)
        return 2
    profile.cloud.provider = coverage_provider(args.provider)

    key = args.key
    # file:// lets the preflight itself be rehearsed against a local form.
    if key.startswith(("http://", "https://", "file://")):
        final_url, family = resolve(key)
    else:
        _state, matches = load_matches(state_path, args.user)
        match = next((m for m in matches if str(m.get("key", "")) == key), None)
        if match is None:
            print(f"no match with key {key} for user '{args.user}' "
                  f"in {state_path}", file=sys.stderr)
            return 1
        url = str(match.get("url", ""))
        if not url:
            print(f"match {key} has no URL", file=sys.stderr)
            return 1
        final_url, family = resolve(url)

    print(f"coverage preflight: {key}")
    print(f"  url:      {final_url}")
    print(f"  family:   {family.value}")
    print(f"  provider: {profile.cloud.provider}\n")
    report, path = run_coverage(key, final_url, family, profile)
    print(format_table(report))
    print(f"\nreport: {path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m src.apply", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command",
                    choices=["list", "plan", "apply", "drain", "approve",
                             "unapprove", "coverage"])
    ap.add_argument("--user", default="",
                    help="applicant (default: the sole users/*_apply.yaml)")
    ap.add_argument("--key", default="", help="dedup_key of a single match")
    ap.add_argument("--mode", choices=[m.value for m in ApplyMode],
                    default=ApplyMode.autofill.value)
    ap.add_argument("--provider", choices=["local", "browserbase"], default="",
                    help="override the profile's cloud backend for this run")
    ap.add_argument("--limit", type=int, default=0, help="max jobs for drain (0=all)")
    ap.add_argument("--state", default=str(DEFAULT_STATE))
    ap.add_argument("--no-require-resume", action="store_true",
                    help="proceed even if the tailored .docx is missing")
    # Fail-closed submit gate. Absent -> use the profile's `submit_gate` (default
    # on); --submit-gate / --no-submit-gate force it on/off for this run.
    ap.add_argument("--submit-gate", action=argparse.BooleanOptionalAction,
                    default=None,
                    help="require all detected-required fields filled before "
                         "submitting (default: profile setting, on)")
    ap.add_argument("--dry-run", action="store_true",
                    help="resolve + print the plan; no browser, no state writes")
    args = ap.parse_args(argv)

    load_dotenv()                       # pick up BROWSERBASE_* etc. from .env
    if not args.user:                   # resolve once: state keys + profile
        from .profile import detect_user
        args.user = detect_user()
    mode = ApplyMode(args.mode)
    state_path = Path(args.state)
    profile = load_profile(args.user)
    if args.provider:
        profile.cloud.provider = args.provider

    # Coverage is read-only and provider-forced (local unless explicitly
    # overridden), so it dispatches before any queue/eligibility machinery.
    if args.command == "coverage":
        return _cmd_coverage(args, profile, state_path)

    state, matches = load_matches(state_path, args.user)
    if not matches:
        print(f"no matches for user '{args.user}' in {state_path}", file=sys.stderr)
        return 1

    # approve / unapprove just toggle the gate and persist.
    if args.command in ("approve", "unapprove"):
        if not args.key:
            print("--key required", file=sys.stderr)
            return 2
        ok = approve_match(matches, args.key, approved=(args.command == "approve"))
        if not ok:
            print(f"no match with key {args.key}", file=sys.stderr)
            return 1
        save(state, state_path)
        print(f"{args.command}d {args.key}")
        return 0

    # The applications ledger is the authoritative no-double-apply guard: a job
    # with a recorded submit attempt (or a hand-ticked applied record) is never
    # re-submitted, regardless of what the match status says.
    ledger_path = ledger_mod.ledger_path(DATA_ROOT)
    ledger = ledger_mod.load_ledger(ledger_path)

    only = {args.key} if args.key else None
    plan = build_plan(matches, profile, mode, only_keys=only,
                      require_resume=not args.no_require_resume,
                      user=args.user, ledger=ledger)

    if args.command in ("list", "plan") or args.dry_run:
        _print_plan(plan, mode)
        return 0

    # apply / drain: run eligible items.
    runnable = [it for it in plan if it.eligible]
    if args.command == "apply":
        if not args.key:
            print("--key required for apply (use drain for the whole queue)",
                  file=sys.stderr)
            return 2
        if not runnable:
            ineligible = next((it for it in plan if it.key == args.key), None)
            why = ineligible.skip_reason if ineligible else "not found"
            print(f"{args.key} not eligible: {why}", file=sys.stderr)
            return 1
    if args.limit:
        runnable = runnable[:args.limit]
    if not runnable:
        print("nothing eligible to run")
        return 0

    artifacts_root = ROOT_ARTIFACTS / _today().isoformat()
    today = _today()
    logins = load_logins(args.user)
    rc = 0
    for it in runnable:
        print(f"-> {it.company} [{it.key}] {it.family.value} mode={mode.value}")
        res = run_item(it, profile, mode, args.user, today,
                       artifacts_root=artifacts_root, logins=logins,
                       submit_gate=args.submit_gate, ledger_path=ledger_path)
        flag = "OK" if res.ok else "!!"
        print(f"   {flag} {res.status.value}: {res.message}".rstrip())
        if res.screenshot_path:
            print(f"      screenshot: {res.screenshot_path}")
        if res.unfilled_fields:
            print(f"      unfilled: {', '.join(res.unfilled_fields)}")
        if not res.ok:
            rc = 1
    save(state, state_path)
    return rc


ROOT_ARTIFACTS = DATA_ROOT / "state" / "apply_artifacts"


if __name__ == "__main__":
    raise SystemExit(main())
