"""Pure logic for the local web UI: issue checkbox write-through, match
shaping, artifact indexing. Nothing here touches git, the network, or a
server, so it is all plainly unit-testable.

Applied/hidden state has ONE source of truth: seen.json on main, written
only by Actions. For rows rendered on the dashboard issue the UI edits the
issue body (exactly the PATCH a human tick performs; the cron reads it
back). Rows outside the issue's byte-budgeted window have no checkbox, so
the UI instead dispatches the `dashboard-write` workflow, which commits the
toggle directly -- `overlay_pending` keeps the UI truthful while that
commit is in flight.
"""

from __future__ import annotations

import re
from pathlib import Path

from .. import dashboard
from ..normalize import norm_company

_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}


def _flip(body: str, marker: str, short: str, on: bool) -> str | None:
    """Issue body with the `marker` box of the row `short` set, or None when
    that row is not rendered (truncated dashboard / stale key). Markers are
    mutually exclusive by construction (`iw:` never matches `iwd:`/`iwb:`),
    so a write can't touch a sibling checkbox."""
    if not re.fullmatch(r"[0-9a-f]{12}", short):
        return None
    pat = re.compile(rf"^(\s*[-*]\s*\[)[ xX](\].*?<!--{marker}:{short}-->)",
                     re.MULTILINE)
    mark = "x" if on else " "
    new, n = pat.subn(lambda m: f"{m.group(1)}{mark}{m.group(2)}", body)
    return new if n else None


def flip_applied(body: str, short: str, applied: bool) -> str | None:
    return _flip(body, "iw", short, applied)


def flip_dismissed(body: str, short: str, dismissed: bool) -> str | None:
    return _flip(body, "iwd", short, dismissed)


def flip_saved(body: str, short: str, saved: bool) -> str | None:
    return _flip(body, "iws", short, saved)


def shape_matches(matches: list[dict], checked: set[str] | None = None,
                  present: set[str] | None = None,
                  hidden: set[str] | None = None,
                  h_present: set[str] | None = None,
                  saved: set[str] | None = None,
                  s_present: set[str] | None = None) -> list[dict]:
    """Copies of match items with the 12-hex `short` key added and, for rows
    currently rendered on the issue (`present`/`h_present`/`s_present`), the
    issue-side applied/dismissed/saved state overlaid -- the issue is fresher
    than seen.json between cron runs. Same rendered-only rule as
    `state.matches_set_applied`, so a truncated dashboard can't un-apply,
    un-hide, or un-save older matches here either."""
    out = []
    for item in matches:
        it = dict(item)
        short = dashboard.short_key(it["key"])
        it["short"] = short
        if present is not None and short in present:
            it["applied"] = short in (checked or set())
        if h_present is not None and short in h_present:
            it["dismissed"] = short in (hidden or set())
        if s_present is not None and short in s_present:
            it["saved"] = short in (saved or set())
        out.append(it)
    return out


def overlay_pending(matches: list[dict],
                    pending: dict[str, dict]) -> dict:
    """Apply queued-but-uncommitted workflow writes ({short: {field: val}})
    on top of shaped matches, in place. Returns the still-pending subset:
    entries the state now reflects are dropped (the commit landed), entries
    for vanished matches are dropped (pruned meanwhile)."""
    by_short = {m["short"]: m for m in matches}
    still: dict[str, dict] = {}
    for short, fields in pending.items():
        m = by_short.get(short)
        if m is None:
            continue
        keep = {}
        for field, val in fields.items():
            # bool toggles compare loosely (absent == False); string fields
            # (tracker status) compare exactly
            current = bool(m.get(field)) if isinstance(val, bool) \
                else m.get(field)
            if current != val:
                m[field] = val
                m["pending"] = True
                keep[field] = val
        if keep:
            still[short] = keep
    return still


def artifact_index(art_root: Path) -> list[dict]:
    """Apply-run screenshots as [{run, slug, files}], newest run first.
    Layout on disk is state/apply_artifacts/<run-date>/<company-slug>/*.png."""
    if not art_root.is_dir():
        return []
    out = []
    for run in sorted((d for d in art_root.iterdir() if d.is_dir()),
                      key=lambda d: d.name, reverse=True):
        for slug in sorted((d for d in run.iterdir() if d.is_dir()),
                           key=lambda d: d.name):
            files = sorted(f.name for f in slug.iterdir()
                           if f.is_file() and f.suffix.lower() in _IMAGE_EXTS)
            if files:
                out.append({"run": run.name, "slug": slug.name,
                            "files": files})
    return out


def _squash(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", s.casefold())


def slug_company_match(slug: str, company: str) -> bool:
    """Best-effort link between an artifact dir name and a match's employer:
    compare alnum-squashed forms, either being a prefix of the other (dirs
    carry suffixes like `1password-ashby`; norm_company drops Inc/LLC)."""
    a, b = _squash(slug), _squash(norm_company(company))
    return bool(a) and bool(b) and (a.startswith(b) or b.startswith(a))


def attach_artifacts(matches: list[dict], index: list[dict]) -> None:
    """Annotate each match (in place) with the artifact groups whose slug
    looks like its employer, so the UI can show 'the agent touched this one'."""
    for item in matches:
        groups = [g for g in index
                  if slug_company_match(g["slug"], item.get("company", ""))]
        if groups:
            item["artifacts"] = groups


def safe_join(base: Path, rel: str) -> Path | None:
    """`base/rel` resolved, or None unless it is an existing file strictly
    inside `base` (blocks traversal and absolute-path smuggling)."""
    if not rel or "\x00" in rel or Path(rel).anchor:
        return None
    p = (base / rel).resolve()
    base = base.resolve()
    if base not in p.parents:
        return None
    return p if p.is_file() else None
