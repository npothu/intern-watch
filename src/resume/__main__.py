"""CLI: build a JD-tailored one-page resume.

    python -m src.resume --jd jd.txt --user alex --company Stripe
    python -m src.resume --jd jd.txt --user alex --no-llm

Pipeline: analyze JD -> select/score (deterministic) -> LLM bullet rewrite
(optional) -> page-fit (deterministic) -> render .docx -> report.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from ..paths import DATA_ROOT as DATA_ROOT
from . import select
from .bank import load_bank
from .build import bank_path, build_resume, resume_llm_cfg


def _llm_cfg(user_yaml: Path) -> dict:
    """Back-compat shim around build.resume_llm_cfg for the old by-path API
    (and the tests that exercise it). The real logic now lives in build.py so
    the watcher and CLI share one resume-LLM config resolver."""
    import yaml

    if not user_yaml.exists():
        return {}
    data = yaml.safe_load(user_yaml.read_text(encoding="utf-8")) or {}
    return data.get("resume_llm") or data.get("llm") or {}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m src.resume",
                                 description=__doc__)
    ap.add_argument("--jd", required=True, help="path to job description .txt")
    ap.add_argument("--user", default="",
                    help="resume bank owner (default: the sole "
                         "users/*_resume.json)")
    ap.add_argument("--company", default="",
                    help="used in the output filename")
    ap.add_argument("--out", default="", help="output .docx path or directory")
    ap.add_argument("--no-llm", action="store_true",
                    help="skip the LLM bullet rewrite")
    ap.add_argument("--max-projects", type=int, default=select.MAX_PROJECTS)
    ap.add_argument("--report", default="", help="also write report .md here")
    args = ap.parse_args(argv)

    jd_text = Path(args.jd).read_text(encoding="utf-8")
    bank = load_bank(bank_path(args.user, DATA_ROOT))

    llm_cfg = resume_llm_cfg(args.user, DATA_ROOT)

    surname = bank.header.name.split()[-1]
    first = bank.header.name.split()[0]
    company = re.sub(r"[^A-Za-z0-9]+", "", args.company) or "Tailored"
    default_name = f"{first}_{surname}_{company}.docx"
    out = Path(args.out) if args.out else DATA_ROOT / "resumes" / default_name
    if out.suffix.lower() != ".docx":          # treat as directory
        out = out / default_name

    result = build_resume(jd_text, bank, company=args.company, out_path=out,
                          llm_cfg=llm_cfg, use_llm=not args.no_llm,
                          max_projects=args.max_projects)

    print(result.report)
    print(f"wrote {out}")
    if args.report:
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text(result.report, encoding="utf-8")

    if result.pages > 1.0:
        print(f"ERROR: output estimated at {result.pages:.2f} pages",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
