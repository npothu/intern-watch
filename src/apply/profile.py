"""The applicant profile: fixed answers used to fill any application form.

Loaded from `users/<name>_apply.yaml`. This is pure data — the same values an
ATS form asks for over and over (contact, links, work authorization, EEO
self-ID, education) plus a freeform `questions` map the answer book consults for
long-tail questions. No secrets live here: cloud-browser and LLM credentials
are read from environment variables named by the `cloud:` / `inbox:` blocks.
"""

from __future__ import annotations

import os
from pathlib import Path

import yaml
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[2]


def load_dotenv(path: Path | None = None) -> None:
    """Minimal .env loader (no dependency): set KEY=VALUE lines into os.environ
    for keys not already present. Lets `python -m src.apply` pick up secrets
    (BROWSERBASE_API_KEY, ...) without exporting them by hand. .env is gitignored."""
    path = path or (ROOT / ".env")
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip().strip('"').strip("'")
        os.environ.setdefault(key, val)


# EEO questions are optional everywhere; default to the legally-safe non-answer.
DECLINE = "Decline to self-identify"


class Links(BaseModel):
    linkedin: str = ""
    github: str = ""
    portfolio: str = ""
    website: str = ""


class WorkAuthorization(BaseModel):
    # The two questions virtually every US ATS asks, phrased as booleans.
    authorized_us: bool = True          # "Are you authorized to work in the US?"
    requires_sponsorship: bool = False  # "Will you now/in future need sponsorship?"
    authorized_canada: bool = False
    citizenship: str = ""               # e.g. "US Citizen" — asked free-text sometimes


class Address(BaseModel):
    street: str = ""
    line2: str = ""                     # apt / suite / unit
    postal_code: str = ""               # city/state live on the profile root


class Personal(BaseModel):
    preferred_name: str = ""            # defaults to first name when blank
    pronouns: str = ""


class Compensation(BaseModel):
    desired_salary: str = ""            # e.g. "Open" / "$30/hr" / "Negotiable"
    current_salary: str = ""
    currency: str = "USD"


class Experience(BaseModel):
    years_experience: str = ""          # e.g. "0" / "1"
    current_title: str = ""             # e.g. "Student"
    current_employer: str = ""


class Logistics(BaseModel):
    start_date: str = ""                # e.g. "Available immediately" / "May 2026"
    notice_period: str = ""             # e.g. "None" / "2 weeks"
    work_preference: str = ""           # "Remote" | "Hybrid" | "On-site" | "No preference"
    willing_to_travel: bool = True
    preferred_locations: list[str] = Field(default_factory=list)


class Screening(BaseModel):
    """Boolean yes/no screeners common on portals (rendered Yes/No, or matched
    against a select's options)."""

    over_18: bool = True
    legally_authorized: bool = True     # "legally eligible / authorized to work"
    felony_conviction: bool = False
    background_check_consent: bool = True
    drug_test_consent: bool = True
    driver_license: bool = False
    security_clearance: str = ""        # e.g. "" / "Secret (active)" / "None"


class Referral(BaseModel):
    how_heard: str = "Company website"  # "How did you hear about us?"
    referred_by: str = ""               # name of referrer, if any


class EEO(BaseModel):
    gender: str = DECLINE
    race: str = DECLINE
    hispanic_latino: str = DECLINE
    veteran_status: str = DECLINE
    disability_status: str = DECLINE


class Education(BaseModel):
    school: str = ""
    degree: str = ""                    # e.g. "Bachelor's"
    major: str = ""                     # e.g. "Computer Science"
    gpa: str = ""
    grad_month: str = ""                # e.g. "May"
    grad_year: str = ""                 # e.g. "2027"


class CloudConfig(BaseModel):
    """Cloud-browser backend. provider 'browserbase' connects Playwright over
    CDP; 'local' launches a local Chromium (the CLI default for hands-on use)."""

    provider: str = "browserbase"       # "browserbase" | "local"
    api_key_env: str = "BROWSERBASE_API_KEY"
    project_id_env: str = "BROWSERBASE_PROJECT_ID"
    # Persisted Playwright storage_state per ATS family lives under here, so a
    # one-time interactive login is reused across runs (the "persistent
    # session" approach). Relative paths resolve against ROOT.
    session_dir: str = "state/apply_sessions"
    headless: bool = True               # local provider only; cloud is remote
    solve_captcha: bool = False         # opt-in; ToS-hostile, off by default
    # Browserbase auto-end timeout (seconds) for a single apply run. Generous by
    # default: a real Greenhouse/Workday fill runs several minutes, and the
    # session must outlive the final screenshot + storage_state persist (live
    # runs died with TargetClosedError at ~5-7 min under the project default).
    session_timeout_s: int = 1200       # 20 min; clamped to browserbase's max


class InboxConfig(BaseModel):
    """IMAP inbox for resolving account-verification links and emailed OTP codes.
    Reuses the watcher's Gmail app-password secrets by default — a Gmail app
    password works for IMAP read just as it does for SMTP send."""

    enabled: bool = True
    user_env: str = "GMAIL_ADDRESS"
    password_env: str = "GMAIL_APP_PASSWORD"
    imap_host: str = "imap.gmail.com"
    imap_port: int = 993


class ApplyProfile(BaseModel):
    """One applicant. `questions` answers long-tail freeform questions for the
    answer book / LLM fallback (question text -> the answer to type/select)."""

    name: str
    email: str
    phone: str = ""
    city: str = ""
    state: str = ""
    country: str = "United States"
    links: Links = Field(default_factory=Links)
    address: Address = Field(default_factory=Address)
    personal: Personal = Field(default_factory=Personal)
    work_authorization: WorkAuthorization = Field(default_factory=WorkAuthorization)
    eeo: EEO = Field(default_factory=EEO)
    education: Education = Field(default_factory=Education)
    compensation: Compensation = Field(default_factory=Compensation)
    experience: Experience = Field(default_factory=Experience)
    logistics: Logistics = Field(default_factory=Logistics)
    screening: Screening = Field(default_factory=Screening)
    referral: Referral = Field(default_factory=Referral)
    willing_to_relocate: bool = True
    # Generic fallback .docx (repo-relative) attached when no tailored
    # per-company resume exists — used by scripts/apply_batch.py.
    base_resume: str = ""
    # Fail-closed submit gate (default ON): in submit mode, refuse to click
    # submit when a REQUIRED field was left unfilled. A CLI flag overrides this
    # per-run; set false here to disable it by default for this user.
    submit_gate: bool = True
    # Field labels we must NEVER fill (substring match, case-insensitive) — e.g.
    # free-text "Additional information" boxes the user wants left blank.
    do_not_fill: list[str] = Field(default_factory=lambda: ["additional information"])
    # Directory holding tailored resumes (output of `src/resume`). The queue
    # resolves the per-company .docx within this dir.
    resume_dir: str = "resumes"
    cloud: CloudConfig = Field(default_factory=CloudConfig)
    inbox: InboxConfig = Field(default_factory=InboxConfig)
    # Freeform question -> answer bank for the long tail (essays, screeners a
    # rule can't infer). `extra` is the legacy name; both are merged.
    questions: dict[str, str] = Field(default_factory=dict)
    extra: dict[str, str] = Field(default_factory=dict)

    @property
    def first_name(self) -> str:
        return self.name.split()[0] if self.name else ""

    @property
    def last_name(self) -> str:
        return self.name.split()[-1] if self.name else ""

    @property
    def answer_bank(self) -> dict[str, str]:
        """Merged freeform Q->A (questions wins over the legacy `extra`)."""
        return {**self.extra, **self.questions}

    def session_path(self, family: str) -> Path:
        d = Path(self.cloud.session_dir)
        if not d.is_absolute():
            d = ROOT / d
        return d / f"{family}.json"


def detect_user() -> str:
    """The sole users/<name>_apply.yaml -> <name>. The shipped template
    (users/apply.example.yaml) deliberately doesn't match the pattern, so it
    can never be picked up as a real profile. Zero or several profiles ->
    a clear error demanding --user."""
    profiles = sorted((ROOT / "users").glob("*_apply.yaml"))
    if len(profiles) == 1:
        return profiles[0].name[:-len("_apply.yaml")]
    if not profiles:
        raise FileNotFoundError(
            "no apply profile found — copy users/apply.example.yaml to "
            "users/<you>_apply.yaml and fill it in")
    names = ", ".join(p.name for p in profiles)
    raise FileNotFoundError(
        f"several apply profiles ({names}) — pick one with --user")


def load_profile(user: str = "", path: Path | None = None) -> ApplyProfile:
    """Load users/<user>_apply.yaml; empty user -> the sole profile in users/.
    An explicit `path` (tests, tooling) bypasses user resolution entirely."""
    if path is None:
        user = user or detect_user()
        path = ROOT / "users" / f"{user}_apply.yaml"
    if not path.exists():
        raise FileNotFoundError(
            f"no apply profile at {path} — create users/{user}_apply.yaml")
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return ApplyProfile.model_validate(data)
