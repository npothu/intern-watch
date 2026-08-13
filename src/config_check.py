"""Config + secret-wiring preflight validator.

Run before the pipeline (locally or in CI) to catch the mistakes that only
ever bite at runtime in Actions: a typo'd top-level key silently ignored, an
`llm.provider` the code doesn't speak, a `company_in_file` rule pointing at a
data file that doesn't exist, or -- the classic -- a `*_env` secret named in a
user yaml that nobody wired into `watch.yml`'s `env:` block (so the secret is
present in GitHub but never reaches the process).

`python -m src.config_check` validates every `users/*.yaml` against an explicit
schema and cross-checks secret wiring against `.github/workflows/watch.yml`,
prints a per-user PASS/FAIL report, and exits nonzero if anything fails.
Alongside it prints a per-feature status report (see `check_features`): each
feature is REQUIRED or OPTIONAL, marked ENABLED or DISABLED in the current
environment, with exactly the env vars that would turn a disabled one back on.
The exit code is about config and secret WIRING only -- optional features off
never fail the preflight, and nothing about secret presence in the local env
fails it either (a fresh CI checkout has none, and GitHub secrets only exist
inside the watch job's env). The feature report's final line is what a
self-hoster reads to know what to put in `.env`.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import yaml

# For the feature status we need the same key-env resolution main.py uses:
# a user may omit llm.api_key_env and fall back to the provider default.
from .envfile import load_dotenv

# The is-this-a-watcher-config rule lives in filters (load_users must apply
# it too, else apply answer-books become phantom watcher users).
from .filters import is_watcher_config as _is_watcher_config
from .llm import api_key_env_for

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


# -- feature status report ----------------------------------------------------

# Required = the minimum for a working watcher: a store backend, an email
# sender, and the LLM classifier key. Everything else is optional and must
# never fail the preflight on its own.
REQUIRED = "REQUIRED"
OPTIONAL = "OPTIONAL"


class Feature:
    """One preflight row: name, tier, enabled, and (when disabled) the exact
    env vars to set. `missing` is the machine-readable list; `note` covers the
    cases where the blocker is a config choice rather than a secret."""

    def __init__(self, name: str, tier: str, enabled: bool, *,
                 missing: list[str] | None = None, note: str = ""):
        self.name = name
        self.tier = tier
        self.enabled = enabled
        self.missing = list(missing or [])
        self.note = note


def _watcher_users(users_dir: Path) -> list[tuple[str, dict | None]]:
    """Parse every watcher users/*.yaml as (filename, data). A file that
    fails to parse yields (filename, None) -- the schema check reports it."""
    parsed: list[tuple[str, dict | None]] = []
    for p in sorted(users_dir.glob("*.yaml")) + sorted(users_dir.glob("*.yml")):
        if not _is_watcher_config(p):
            continue
        try:
            data = yaml.safe_load(p.read_text(encoding="utf-8"))
        except yaml.YAMLError:
            parsed.append((p.name, None))
            continue
        parsed.append((p.name, data))
    return parsed


def check_features(users_dir: Path, watch_yml: Path, *,
                   root: Path) -> list[Feature]:
    """Status of every feature the repo can run, relative to the current
    environment (after load_dotenv -- no-op in CI). Required features come
    first. The caller prints this; a disabled OPTIONAL feature never makes
    `main` exit nonzero."""
    users = [data for _, data in _watcher_users(users_dir)
             if isinstance(data, dict)]

    def present(name: str) -> bool:
        return bool(os.environ.get(name))

    feats: list[Feature] = []

    # -- REQUIRED ----------------------------------------------------------
    store = os.environ.get("STORE", "github")
    if store == "convex":
        missing = [v for v in ("CONVEX_URL", "CONVEX_SECRET") if not present(v)]
        if missing:
            feats.append(Feature("store", REQUIRED, False, missing=missing))
        else:
            feats.append(Feature("store", REQUIRED, True,
                                 note="Convex driver "
                                      "(CONVEX_URL/CONVEX_SECRET set)"))
    else:
        feats.append(Feature("store", REQUIRED, True,
                             note="GitHub driver (STORE unset) - no vars needed"))

    email_users = []
    for u in users:
        found, email = _dig(u, ("notify", "email"))
        if found and isinstance(email, dict):
            email_users.append(email)
    if not email_users:
        feats.append(Feature(
            "email digest", REQUIRED, False,
            note="no watcher user enables notify.email - add it to "
                 "users/<you>.yaml"))
    else:
        # Bind each lookup once: narrowing an inline `email.get(k)` inside the
        # comprehension's guard does not carry to the value expression, which
        # is a separate call as far as the type checker is concerned.
        envs: set[str] = set()
        for email in email_users:
            for key in ("smtp_user_env", "smtp_pass_env"):
                name = email.get(key)
                if isinstance(name, str) and name:
                    envs.add(name)
        missing = [n for n in sorted(envs) if not present(n)]
        if missing:
            feats.append(Feature("email digest", REQUIRED, False,
                                 missing=missing))
        else:
            feats.append(Feature("email digest", REQUIRED, True,
                                 note=f"digest sender ready for "
                                      f"{len(email_users)} user(s)"))

    llm_users = [u for u in users if _dig(u, ("llm", "enabled"))[1]
                 and isinstance(u.get("llm"), dict)]
    if not llm_users:
        feats.append(Feature(
            "llm classifier", REQUIRED, False,
            note="no watcher user enables llm (llm.enabled: true) - the "
                 "watcher then runs deterministic-only"))
    else:
        keys = sorted({api_key_env_for(u["llm"]) for u in llm_users})
        missing = [k for k in keys if not present(k)]
        if missing:
            feats.append(Feature("llm classifier", REQUIRED, False,
                                 missing=missing))
        else:
            feats.append(Feature("llm classifier", REQUIRED, True,
                                 note=f"keys ready ({', '.join(keys)})"))

    # -- OPTIONAL ----------------------------------------------------------
    discord_envs = []
    for u in users:
        found, env_name = _dig(u, ("notify", "discord_webhook_env"))
        if found and isinstance(env_name, str) and env_name:
            discord_envs.append(env_name)
    if not discord_envs:
        feats.append(Feature(
            "discord", OPTIONAL, False,
            note="no watcher user enables a Discord channel "
                 "(notify.discord_webhook_env)"))
    else:
        missing = sorted({n for n in discord_envs if not present(n)})
        if missing:
            feats.append(Feature("discord", OPTIONAL, False, missing=missing))
        else:
            feats.append(Feature("discord", OPTIONAL, True,
                                 note=f"webhook(s) ready ({', '.join(sorted(set(discord_envs)))})"))

    jr_missing = [v for v in ("JOBRIGHT_EMAIL", "JOBRIGHT_PASSWORD")
                  if not present(v)]
    if jr_missing:
        feats.append(Feature("jobright resolution", OPTIONAL, False,
                             missing=jr_missing))
    else:
        feats.append(Feature("jobright resolution", OPTIONAL, True,
                             note="resolves jobright links to the real "
                                  "employer apply URL"))

    profiles = sorted(p.name for p in users_dir.glob("*_apply.yaml")
                      if p.name != "apply.example.yaml")
    if not profiles:
        feats.append(Feature(
            "auto-apply", OPTIONAL, False,
            note="copy users/apply.example.yaml to users/<you>_apply.yaml "
                 "(answer book; drives the python -m src.apply CLI)"))
    else:
        bb_missing = [v for v in ("BROWSERBASE_API_KEY",
                                  "BROWSERBASE_PROJECT_ID") if not present(v)]
        if bb_missing:
            feats.append(Feature("auto-apply", OPTIONAL, False,
                                 missing=bb_missing,
                                 note="profiles found - also check the "
                                      "profile's cloud.provider"))
        else:
            feats.append(Feature("auto-apply", OPTIONAL, True,
                                 note=f"profile(s) ready ({', '.join(profiles)})"))

    if store != "convex":
        feats.append(Feature(
            "mail-sync", OPTIONAL, False,
            note="needs STORE=convex (a Convex deployment); see "
                 "docs/mail-sync.md"))
    else:
        ms_missing = [v for v in ("GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET")
                      if not present(v)]
        if ms_missing:
            feats.append(Feature("mail-sync", OPTIONAL, False,
                                 missing=ms_missing))
        else:
            feats.append(Feature("mail-sync", OPTIONAL, True,
                                 note="recruiter emails update tracker "
                                      "statuses"))

    feats.append(Feature(
        "hosted web app", OPTIONAL, False,
        note="separate deployment (Vercel + Convex); its secrets live there, "
             "not in .env - see README \"Hosted web app\""))

    return feats


def render_features(feats: list[Feature]) -> str:
    """The human-facing feature table, plus the required-set summary line."""
    lines = ["features (REQUIRED = the minimum for a working watcher):"]
    width = max(len(f.name) for f in feats)
    for f in feats:
        status = "ENABLED " if f.enabled else "DISABLED"
        line = (f"  [{f.tier:<8}] {f.name:<{width}}  {status}")
        if f.enabled:
            if f.note:
                line += f"  {f.note}"
        elif f.missing:
            line += "  - set " + ", ".join(f.missing)
        elif f.note:
            line += f"  - {f.note}"
        lines.append(line)
    required = [f for f in feats if f.tier == REQUIRED]
    n_on = sum(1 for f in required if f.enabled)
    lines.append("")
    lines.append(f"  required features: {n_on}/{len(required)} ready in this "
                 f"environment")
    for f in required:
        if f.enabled:
            continue
        if f.missing:
            lines.append(f"    - {f.name}: add {', '.join(f.missing)} to .env "
                         "(or as Actions secrets of the same name)")
        else:
            lines.append(f"    - {f.name}: {f.note}")
    lines.append("  (A disabled OPTIONAL feature is fine on its own - the "
                 "watcher only needs the required set.)")
    return "\n".join(lines)


def env_store_report(watch_yml: Path) -> Report | None:
    """Exit-affecting store checks that depend on the current environment
    (after load_dotenv): an unknown STORE value, or STORE=convex with the
    Convex secrets unwired. CI sets neither STORE nor the Convex secrets, so
    this is a no-op in the preflight step there."""
    store = os.environ.get("STORE")
    if not store:
        return None
    if store not in ("github", "convex"):
        rep = Report("STORE env var")
        rep.error(f"unknown STORE={store!r} (have: github, convex)")
        return rep
    if store == "convex":
        wired = watch_env_names(watch_yml)
        missing = [n for n in ("CONVEX_URL", "CONVEX_SECRET") if n not in wired]
        if missing:
            rep = Report("STORE env var")
            rep.error(
                "STORE=convex but " + ", ".join(missing) +
                " is not wired into watch.yml's env: block -- add this line "
                "under the run step's env::\n             " +
                "\n             ".join(f"{n}: ${{{{ secrets.{n} }}}}"
                                       for n in missing))
            return rep
    return None


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

    # Local-only: pull STORE/CONVEX_* and GMAIL/GEMINI keys out of the
    # gitignored .env before the feature report. No-op in Actions (no .env).
    load_dotenv(root / ".env")

    reports, ok = check_configs(users_dir, watch_yml, root=root)
    store_rep = env_store_report(watch_yml)
    if store_rep is not None:
        ok = ok and store_rep.ok
    for rep in reports:
        print(rep.render())
    if store_rep is not None:
        print(store_rep.render())
    print()
    feats = check_features(users_dir, watch_yml, root=root)
    print(render_features(feats))
    print()
    if ok:
        print(f"config-check: PASS ({len(reports)} user(s))")
        return 0
    checked = reports + ([store_rep] if store_rep is not None else [])
    n_fail = sum(1 for r in checked if not r.ok)
    print(f"config-check: FAIL ({n_fail}/{len(checked)} check(s) failed)")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
