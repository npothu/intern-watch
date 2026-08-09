"""Web UI core logic: issue write-through, match shaping, artifact index,
file-serving safety, and the resume-bank fallback it depends on."""

import datetime as dt

from src import dashboard
from src.resume.build import bank_path
from src.webui import core


def _item(key, company="Acme", applied=False, **kw):
    base = {"key": key, "company": company, "title": "SWE Intern",
            "url": "https://example.com/j/1", "location": "Atlanta, GA",
            "term": "Fall 2026", "added": "2026-06-20", "applied": applied}
    base.update(kw)
    return base


def _body(items):
    now = dt.datetime(2026, 7, 1, tzinfo=dt.UTC)
    return dashboard.build_body(items, ["Fall 2026"], now)


# -- flip_applied: writes must round-trip through the real issue renderer --

def test_flip_applied_round_trips_through_parse():
    items = [_item("url:a"), _item("url:b", applied=True)]
    body = _body(items)
    a, b = dashboard.short_key("url:a"), dashboard.short_key("url:b")

    ticked = core.flip_applied(body, a, True)
    checked, present = dashboard.parse_checkboxes(ticked)
    assert checked == {a, b} and present == {a, b}

    unticked = core.flip_applied(ticked, b, False)
    checked, _ = dashboard.parse_checkboxes(unticked)
    assert checked == {a}


def test_flip_applied_never_touches_build_checkboxes():
    body = _body([_item("url:a", resume="resumes/x/y.docx")])
    short = dashboard.short_key("url:a")
    flipped = core.flip_applied(body, short, True)
    # the iwb: build box (ticked, resume exists) and the iw:build trigger
    # must survive an applied write byte-for-byte
    assert dashboard.parse_build_selections(flipped) == \
        dashboard.parse_build_selections(body) == {short}
    assert dashboard.build_trigger_checked(flipped) == \
        dashboard.build_trigger_checked(body)


def test_flip_applied_unknown_or_malformed_short_is_none():
    body = _body([_item("url:a")])
    assert core.flip_applied(body, "0" * 12, True) is None
    assert core.flip_applied(body, "not-a-short", True) is None
    assert core.flip_applied(body, r"a.{0,99}bcd", True) is None  # no regex smuggling


def test_flip_applied_is_idempotent():
    body = _body([_item("url:a")])
    short = dashboard.short_key("url:a")
    once = core.flip_applied(body, short, True)
    assert core.flip_applied(once, short, True) == once


# -- shape_matches: issue state overlays only rendered rows ---------------

def test_shape_matches_overlays_only_rendered_rows():
    items = [_item("url:a"), _item("url:b", applied=True), _item("url:c")]
    a, b = dashboard.short_key("url:a"), dashboard.short_key("url:b")
    shaped = core.shape_matches(items, checked={a}, present={a, b})
    by = {m["short"]: m for m in shaped}
    assert by[a]["applied"] is True            # ticked on the issue
    assert by[b]["applied"] is False           # unticked on the issue
    # url:c not rendered (truncated dashboard): state value survives
    assert by[dashboard.short_key("url:c")]["applied"] is False
    assert items[0].get("applied") is False    # inputs never mutated


def test_shape_matches_without_issue_keeps_state_values():
    shaped = core.shape_matches([_item("url:b", applied=True)])
    assert shaped[0]["applied"] is True and "short" in shaped[0]


# -- artifacts -------------------------------------------------------------

def test_artifact_index_newest_run_first_images_only(tmp_path):
    (tmp_path / "2026-06-18" / "cerebras").mkdir(parents=True)
    (tmp_path / "2026-06-18" / "cerebras" / "01_nav.png").write_bytes(b"x")
    (tmp_path / "2026-06-18" / "cerebras" / "notes.txt").write_bytes(b"x")
    (tmp_path / "2026-06-25" / "abb").mkdir(parents=True)
    (tmp_path / "2026-06-25" / "abb" / "02_loaded.PNG").write_bytes(b"x")
    (tmp_path / "2026-06-25" / "empty").mkdir()

    idx = core.artifact_index(tmp_path)
    assert [(g["run"], g["slug"]) for g in idx] == \
        [("2026-06-25", "abb"), ("2026-06-18", "cerebras")]
    assert idx[1]["files"] == ["01_nav.png"]


def test_artifact_index_missing_root(tmp_path):
    assert core.artifact_index(tmp_path / "nope") == []


def test_slug_company_match():
    assert core.slug_company_match("1password-ashby", "1Password")
    assert core.slug_company_match("cerebras", "Cerebras Systems Inc.")
    assert not core.slug_company_match("gts-workday", "Cloudflare")
    assert not core.slug_company_match("", "Cloudflare")


def test_attach_artifacts_annotates_matching_rows():
    index = [{"run": "2026-06-18", "slug": "cerebras", "files": ["a.png"]}]
    ms = [_item("url:a", company="Cerebras Systems"),
          _item("url:b", company="Cloudflare")]
    core.attach_artifacts(ms, index)
    assert ms[0]["artifacts"] == index and "artifacts" not in ms[1]


# -- file serving safety ----------------------------------------------------

def test_safe_join_allows_nested_blocks_escape(tmp_path):
    (tmp_path / "run" / "slug").mkdir(parents=True)
    f = tmp_path / "run" / "slug" / "shot.png"
    f.write_bytes(b"x")
    (tmp_path.parent / "secret.txt").write_text("no", encoding="utf-8")

    assert core.safe_join(tmp_path, "run/slug/shot.png") == f
    assert core.safe_join(tmp_path, "../secret.txt") is None
    assert core.safe_join(tmp_path, "run/../../secret.txt") is None
    assert core.safe_join(tmp_path, str(f)) is None  # absolute smuggling
    assert core.safe_join(tmp_path, "run/slug") is None  # dir, not file
    assert core.safe_join(tmp_path, "") is None


# -- resume bank fallback (used by webui + ondemand builds) -----------------

def test_bank_path_prefers_exact_then_sole_fallback(tmp_path):
    users = tmp_path / "users"
    users.mkdir()
    sample = users / "sample_resume.json"
    sample.write_text("{}", encoding="utf-8")

    # exact miss, one bank on disk -> fall back to it.
    assert bank_path("example", tmp_path) == sample
    # exact hit wins
    example = users / "example_resume.json"
    example.write_text("{}", encoding="utf-8")
    assert bank_path("example", tmp_path) == example
    # ambiguous (two banks, neither matching) -> honest FileNotFoundError path
    assert bank_path("ghost", tmp_path) == users / "ghost_resume.json"
