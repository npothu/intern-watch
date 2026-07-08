"""Config + secret-wiring preflight validator.

Run before the pipeline (locally or in CI) to catch the mistakes that only
ever bite at runtime in Actions: a typo'd top-level key silently ignored, an
`llm.provider` the code doesn't speak, a `company_in_file` rule pointing at a
data file that doesn't exist, or -- the classic -- a `*_env` secret named in a
user yaml that nobody wired into `watch.yml`'s `env:` block (so the secret is
present in GitHub but never reaches the process).

`python -m src.config_check` validates every `users/*.yaml` against an explicit
schema and cross-checks secret wiring against `.github/workflows/watch.yml`,
prints a per-user PASS/FAIL report, and exits nonzero if anything fails. It is
deliberately self-contained (no imports from the rest of `src`) so it can run
as the very first CI step, before anything else can blow up.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml

# The is-this-a-watcher-config rule lives in filters (load_users must apply
# it too, else apply answer-books become phantom watcher users).
from .filters import is_watcher_config as _is_watcher_config

ROOT = Path(__file__).resolve().parent.parent

# Known top-level keys. Anything else is an unknown-key *warning* (typos are
# usually silent no-ops in the loaders, so surface them) -- not a hard error,
# since a future key shouldn't break the validator on an older checkout.
KNOWN_TOP_LEVEL = {
    "name", "notify", "dashboard", "eliminate", "role_filter",
    "terms_wanted", "unknown_term_policy", "rules", "llm", "resume_llm",
    "resume_build",
}

LLM_PROVIDERS = {"gemini", "anthropic"}
UNKNOWN_TERM_POLICIES = {"llm", "drop", "keep"}
RESUME_BUILD_MODES = {"commit", "email", "dashboard"}

# Valid POSIX shell identifier (what a GitHub Actions env var must be).
_ENV_NAME_RE = re.compile(r"^[A-Z_][A-Z0-9_]*$")

# Where every *_env reference lives in a user yaml. Each entry is the dotted
# path used only for human-readable messages.
_ENV_REF_PATHS = [
    ("notify", "email", "smtp_user_env"),
    ("notify", "email", "smtp_pass_env"),
    ("notify", "discord_webhook_env"),
    ("llm", "api_key_env"),
    ("resume_llm", "api_key_env"),
]


class Report:
    """Accumulates errors/warnings for one user yaml and renders PASS/FAIL."""

    def __init__(self, label: str):
        self.label = label
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def error(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)

    @property
    def ok(self) -> bool:
        return not self.errors

    def render(self) -> str:
        status = "PASS" if self.ok else "FAIL"
        lines = [f"[{status}] {self.label}"]
        for w in self.warnings:
            lines.append(f"  warning: {w}")
        for e in self.errors:
            lines.append(f"  error:   {e}")
        return "\n".join(lines)


def _dig(data: dict, path: tuple[str, ...]):
    """Walk a dotted path through nested dicts; return (found, value)."""
    cur = data
    for key in path:
        if not isinstance(cur, dict) or key not in cur:
            return False, None
        cur = cur[key]
    return True, cur


def collect_env_refs(user: dict) -> list[tuple[str, str]]:
    """Return [(dotted_path, env_name), ...] for every *_env value set in the
    user config (skipping ones that are absent or not strings)."""
    refs: list[tuple[str, str]] = []
    for path in _ENV_REF_PATHS:
        found, value = _dig(user, path)
        if found and isinstance(value, str) and value:
            refs.append((".".join(path), value))
    return refs


def watch_env_names(watch_yml: Path) -> set[str]:
    """Parse the `env:` block under the run step in watch.yml and return the
    set of declared env var names. Falls back to an empty set if the file or
    block is missing (the caller reports the resulting wiring failures)."""
    if not watch_yml.exists():
        return set()
    doc = yaml.safe_load(watch_yml.read_text(encoding="utf-8")) or {}
    names: set[str] = set()
    jobs = doc.get("jobs") or {}
    for job in jobs.values():
        if not isinstance(job, dict):
            continue
        for step in job.get("steps") or []:
            if isinstance(step, dict) and isinstance(step.get("env"), dict):
                names.update(step["env"].keys())
    # Also honor a job-level or top-level env: block, if present.
    for job in jobs.values():
        if isinstance(job, dict) and isinstance(job.get("env"), dict):
            names.update(job["env"].keys())
    if isinstance(doc.get("env"), dict):
        names.update(doc["env"].keys())
    return names


def validate_user(user: dict, label: str, *, root: Path,
                  wired_env: set[str]) -> Report:
    """Validate one parsed user config against the schema and secret wiring."""
    rep = Report(label)

    if not isinstance(user, dict):
        rep.error("top-level YAML is not a mapping")
        return rep

    if not user.get("name"):
        rep.error("missing required key: name")

    # 1a. Unknown top-level keys (warn -- silent no-ops are easy to miss).
    for key in user:
        if key not in KNOWN_TOP_LEVEL:
            rep.warn(f"unknown top-level key: {key!r}")

    # 1b. Enum checks.
    found, provider = _dig(user, ("llm", "provider"))
    if found and provider not in LLM_PROVIDERS:
        rep.error(f"llm.provider {provider!r} not in "
                  f"{sorted(LLM_PROVIDERS)}")
    found, rprovider = _dig(user, ("resume_llm", "provider"))
    if found and rprovider not in LLM_PROVIDERS:
        rep.error(f"resume_llm.provider {rprovider!r} not in "
                  f"{sorted(LLM_PROVIDERS)}")

    policy = user.get("unknown_term_policy")
    if policy is not None and policy not in UNKNOWN_TERM_POLICIES:
        rep.error(f"unknown_term_policy {policy!r} not in "
                  f"{sorted(UNKNOWN_TERM_POLICIES)}")

    found, modes = _dig(user, ("resume_build", "modes"))
    if found and modes is not None:
        if not isinstance(modes, list):
            rep.error("resume_build.modes must be a list")
        else:
            bad = [m for m in modes if m not in RESUME_BUILD_MODES]
            if bad:
                rep.error(f"resume_build.modes has unknown entries {bad} "
                          f"(allowed: {sorted(RESUME_BUILD_MODES)})")

    # 1c. company_in_file paths under data/ must exist.
    for cif in _iter_company_in_file(user.get("rules")):
        if not str(cif).replace("\\", "/").startswith("data/"):
            rep.warn(f"company_in_file {cif!r} is not under data/")
        if not (root / cif).exists():
            rep.error(f"company_in_file {cif!r} does not exist "
                      f"(looked in {root / cif})")

    # 1d. env-var names must be valid shell identifiers.
    refs = collect_env_refs(user)
    for dotted, name in refs:
        if not _ENV_NAME_RE.match(name):
            rep.error(f"{dotted} = {name!r} is not a valid env var name "
                      f"(must match [A-Z_][A-Z0-9_]*)")

    # 2. Secret wiring: each *_env must be declared in watch.yml's env: block.
    for dotted, name in refs:
        if not _ENV_NAME_RE.match(name):
            continue  # already reported; skip wiring check for garbage names
        if name not in wired_env:
            rep.error(
                f"{dotted} = {name!r} is not wired into watch.yml -- add this "
                f"line under the run step's env::\n"
                f"             {name}: ${{{{ secrets.{name} }}}}")

    return rep


def _iter_company_in_file(rules) -> list[str]:
    """Pull every `company_in_file:` value out of the rules block."""
    out: list[str] = []
    if not isinstance(rules, list):
        return out
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        for clause in rule.get("accept_if_any") or []:
            if isinstance(clause, dict) and "company_in_file" in clause:
                out.append(clause["company_in_file"])
    return out


def check_configs(users_dir: Path, watch_yml: Path, *,
                  root: Path) -> tuple[list[Report], bool]:
    """Validate every watcher users/*.yaml. Returns (reports, all_passed)."""
    wired = watch_env_names(watch_yml)
    reports: list[Report] = []
    paths = [p for p in
             sorted(users_dir.glob("*.yaml")) + sorted(users_dir.glob("*.yml"))
             if _is_watcher_config(p)]
    if not paths:
        rep = Report(str(users_dir))
        rep.error(f"no user yaml files found in {users_dir}")
        return [rep], False
    for path in paths:
        try:
            user = yaml.safe_load(path.read_text(encoding="utf-8"))
        except yaml.YAMLError as exc:  # malformed yaml is a hard fail
            rep = Report(path.name)
            rep.error(f"YAML parse error: {exc}")
            reports.append(rep)
            continue
        # A yaml with no `name:` is not a user config (e.g. a stray file);
        # validate_user reports the missing name so it can't pass silently.
        reports.append(validate_user(user, path.name, root=root,
                                     wired_env=wired))
    all_passed = all(r.ok for r in reports)
    return reports, all_passed


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    root = Path(argv[0]).resolve() if argv else ROOT
    users_dir = root / "users"
    watch_yml = root / ".github" / "workflows" / "watch.yml"

    reports, ok = check_configs(users_dir, watch_yml, root=root)
    for rep in reports:
        print(rep.render())
    print()
    if ok:
        print(f"config-check: PASS ({len(reports)} user(s))")
        return 0
    n_fail = sum(1 for r in reports if not r.ok)
    print(f"config-check: FAIL ({n_fail}/{len(reports)} user(s) failed)")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
