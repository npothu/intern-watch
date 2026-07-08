"""AgentFiller tests: answer-book + LLM field mapping (mostly no browser)."""

from __future__ import annotations

import json

import pytest

from src.apply.fillers.agent import AgentFiller, _apply_mapping, _llm_cfg, map_fields
from src.apply.profile import ApplyProfile
from src.apply.base import ATSFamily


def test_llm_cfg_resolves_example_when_user_yaml_absent():
    # apply is '<name>'-keyed (e.g. "example"), but post-anonymization only
    # users/example.yaml exists. The agent must still find the LLM block instead
    # of silently disabling LLM mapping (the bug that left jobs under-filled).
    cfg = _llm_cfg("example")
    assert cfg.get("provider") == "gemini"
    assert cfg.get("api_key_env") == "GEMINI_API_KEY"


def _profile() -> ApplyProfile:
    return ApplyProfile.model_validate({
        "name": "Ada Lovelace",
        "email": "ada@example.com",
        "phone": "555-0100",
        "city": "Atlanta",
        "state": "Georgia",
        "links": {"linkedin": "https://linkedin.com/in/ada",
                  "github": "https://github.com/ada"},
        "education": {"school": "Georgia Tech", "major": "CS",
                      "grad_year": "2027"},
        "questions": {"How did you hear about us?": "Company website"},
    })


SYNTHETIC_FORM = [
    {"ref": "#first", "label": "First name", "type": "text", "is_select": False},
    {"ref": "#last", "label": "Last name", "type": "text", "is_select": False},
    {"ref": "#email", "label": "Email", "type": "email", "is_select": False},
    {"ref": "#phone", "label": "Phone", "type": "tel", "is_select": False},
    {"ref": "#li", "label": "LinkedIn URL", "type": "url", "is_select": False},
    {"ref": "#auth", "label": "Authorized to work in the US?", "type": "select",
     "is_select": True, "options": ["Yes", "No"]},
]


def test_registry_returns_agent_for_unknown():
    from src.apply.fillers import get_filler
    f = get_filler(ATSFamily.unknown)
    assert isinstance(f, AgentFiller)
    assert f.family == ATSFamily.unknown


def test_agent_is_default_for_lever_ashby():
    from src.apply.fillers import get_filler
    for fam in (ATSFamily.lever, ATSFamily.ashby):
        assert isinstance(get_filler(fam), AgentFiller)


def test_map_fields_with_fake_llm():
    canned = [
        {"ref": "#first", "value": "Ada"},
        {"ref": "#last", "value": "Lovelace"},
        {"ref": "#email", "value": "ada@example.com"},
        {"ref": "#auth", "value": "Yes"},
        {"ref": "#bogus", "value": "ignored"},
        {"ref": "#phone", "value": ""},
        "not-a-dict",
    ]
    calls = {}

    def fake_call(model, system, user_msg, api_key):
        calls["system"] = system
        calls["user_msg"] = user_msg
        return json.dumps(canned)

    cfg = {"provider": "anthropic", "model": "x", "api_key_env": "FAKE_KEY"}
    import os
    os.environ["FAKE_KEY"] = "sk-test"
    try:
        mapping, notes = map_fields(SYNTHETIC_FORM, _profile(), cfg, call=fake_call)
    finally:
        del os.environ["FAKE_KEY"]

    assert mapping["#first"] == "Ada"
    assert mapping["#last"] == "Lovelace"
    assert mapping["#email"] == "ada@example.com"
    assert mapping["#phone"] == "555-0100"
    assert mapping["#li"] == "https://linkedin.com/in/ada"
    assert mapping["#auth"] == "Yes"
    assert any("answer book" in n for n in notes)
    assert "JSON array" in calls["system"]
    assert "ada@example.com" in calls["user_msg"]
    assert "#auth" in calls["user_msg"]


def test_map_fields_no_provider_deterministic():
    mapping, notes = map_fields(SYNTHETIC_FORM, _profile(), {})
    assert mapping["#email"] == "ada@example.com"
    assert mapping["#phone"] == "555-0100"
    assert mapping["#first"] == "Ada"
    assert mapping["#last"] == "Lovelace"
    assert mapping["#li"] == "https://linkedin.com/in/ada"
    assert mapping["#auth"] == "Yes"
    assert notes and "answer-book" in notes[0]


def test_map_fields_missing_api_key_falls_back(monkeypatch):
    monkeypatch.delenv("NO_SUCH_KEY", raising=False)
    cfg = {"provider": "anthropic", "api_key_env": "NO_SUCH_KEY"}
    mapping, notes = map_fields(SYNTHETIC_FORM, _profile(), cfg, call=None)
    assert mapping["#email"] == "ada@example.com"
    assert any("API key" in n for n in notes)


def test_map_fields_llm_error_falls_back():
    cfg = {"provider": "anthropic", "api_key_env": "FAKE_KEY2"}
    import os
    os.environ["FAKE_KEY2"] = "sk-test"

    def boom(*a):
        raise RuntimeError("network down")
    try:
        mapping, notes = map_fields(SYNTHETIC_FORM, _profile(), cfg, call=boom)
    finally:
        del os.environ["FAKE_KEY2"]
    assert mapping["#email"] == "ada@example.com"
    assert any("error" in n.lower() for n in notes)


def test_map_fields_empty_llm_result_falls_back():
    cfg = {"provider": "anthropic", "api_key_env": "FAKE_KEY3"}
    import os
    os.environ["FAKE_KEY3"] = "sk-test"
    try:
        mapping, notes = map_fields(SYNTHETIC_FORM, _profile(), cfg,
                                    call=lambda *a: "[]")
    finally:
        del os.environ["FAKE_KEY3"]
    assert mapping["#email"] == "ada@example.com"
    assert any("answer book" in n for n in notes)


def test_llm_never_overrides_answer_book_value():
    """The bank resolves an exact answer (a full-precision graduation date); the
    LLM's coarser echo ("May 2027", day dropped in the payload) must NOT clobber
    it — an override committed the wrong day on a real Ashby form. The LLM may
    still FILL refs the answer book left blank."""
    profile = ApplyProfile.model_validate({
        "name": "Ada Lovelace",
        "email": "ada@example.com",
        "education": {"grad_year": "2027"},
        "questions": {"Graduation Date": "2027-05-10"},
    })
    form = [
        {"ref": "#grad", "label": "Graduation Date", "type": "text",
         "is_select": False},
        {"ref": "#free", "label": "Why do you want this role?", "type": "text",
         "is_select": False},
    ]
    # Answer book resolves #grad via the bank; #free is left to the LLM.
    base, _ = map_fields(form, profile, {})
    assert base["#grad"] == "2027-05-10"

    def fake_call(model, system, user_msg, api_key):
        return json.dumps([
            {"ref": "#grad", "value": "May 2027"},        # coarse -> must lose
            {"ref": "#free", "value": "I love the mission"},
        ])

    cfg = {"provider": "anthropic", "model": "x", "api_key_env": "FAKE_OVR"}
    import os
    os.environ["FAKE_OVR"] = "sk-test"
    try:
        mapping, notes = map_fields(form, profile, cfg, call=fake_call)
    finally:
        del os.environ["FAKE_OVR"]
    assert mapping["#grad"] == "2027-05-10"               # bank kept, not clobbered
    assert mapping["#free"] == "I love the mission"       # LLM still fills gaps
    assert any("LLM added 1" in n for n in notes)


def test_extract_and_fill_against_set_content():
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _extract_fields
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(
                "<label for='email'>Email</label><input id='email'>"
                "<label for='name'>First name</label><input id='name'>"
                "<input type='hidden' name='csrf' value='x'>")
            fields = _extract_fields(page)
            refs = {f["ref"] for f in fields}
            assert "#email" in refs and "#name" in refs
            assert all("csrf" not in (f.get("label") or "") for f in fields)
            mapping, _ = map_fields(fields, _profile(), {})
            filled, _ = _apply_mapping(page, fields, mapping)
            assert "#email" in filled
            assert page.input_value("#email") == "ada@example.com"
            browser.close()
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


def test_extract_unlabeled_combobox_gets_question_text():
    """A custom combobox whose question is a sibling <label> with no for/aria
    link (Ashby's "How did you hear about this role?") must be extracted with
    the question as its label, not the placeholder ("Start typing...")."""
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _extract_fields
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(
                "<div><label>How did you hear about this role?*</label>"
                "<div><input role='combobox' placeholder='Start typing...'>"
                "</div></div>"
                # No question text anywhere: placeholder stays the fallback.
                "<section><input id='lonely' placeholder='Type here...'>"
                "</section>")
            fields = _extract_fields(page)
            combo = next(f for f in fields if f["type"] == "combobox")
            assert "How did you hear about this role?" in combo["label"]
            # The synthetic ref (no id/name) must actually resolve in
            # Playwright to exactly that element (:nth-match, page-wide).
            assert combo["ref"].startswith(":nth-match(")
            loc = page.locator(combo["ref"])
            assert loc.count() == 1
            assert loc.get_attribute("role") == "combobox"
            lonely = next(f for f in fields if f["ref"] == "#lonely")
            assert lonely["label"] == "Type here..."
            browser.close()
    except StopIteration:
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


_COMBO_HTML = """
<label>How did you hear about this role?</label>
<input id='c' role='combobox'>
<div id='menu'></div>
<div id='out'></div>
<script>
  const OPTS = ['LinkedIn', 'Company Website', 'Referral'];
  const inp = document.getElementById('c');
  const menu = document.getElementById('menu');
  inp.addEventListener('input', () => {
    menu.innerHTML = '';
    for (const o of OPTS) {
      if (o.toLowerCase().includes(inp.value.toLowerCase())) {
        const d = document.createElement('div');
        d.setAttribute('role', 'option');
        d.textContent = o;
        // A real combobox reflects the chosen label into the control (so the
        // read-back verification can confirm it landed); mirror that here.
        d.onclick = () => {
          document.getElementById('out').textContent = o;
          inp.value = o;
        };
        menu.appendChild(d);
      }
    }
  });
</script>"""


def test_set_combobox_clicks_matching_option_and_fails_honestly():
    """The combobox helper must CLICK a really-matching option (verifiable
    selection), and return False when the option set has no match — the old
    blind-Enter path reported success while selecting nothing."""
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _set_combobox
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(_COMBO_HTML)
            assert _set_combobox(page, page.locator("#c"), "Company website")
            assert page.inner_text("#out") == "Company Website"

            page.set_content(_COMBO_HTML)
            assert not _set_combobox(page, page.locator("#c"), "Google Search")
            assert page.inner_text("#out") == ""
            browser.close()
    except AssertionError:
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


def test_set_combobox_arrowdown_only_menu():
    """Widgets that ignore typing and only open their menu on ArrowDown
    (keyboard-driven autocomplete) must still get a real selection."""
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _set_combobox
    html = """
    <input id='c' role='combobox'>
    <div id='menu'></div>
    <div id='out'></div>
    <script>
      const inp = document.getElementById('c');
      inp.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowDown') return;
        const menu = document.getElementById('menu');
        menu.innerHTML = '';
        for (const o of ['LinkedIn', 'Company Website', 'Referral']) {
          const d = document.createElement('div');
          d.setAttribute('role', 'option');
          d.textContent = o;
          d.onclick = () => {
            document.getElementById('out').textContent = o;
            inp.value = o;                       // control reflects the choice
          };
          menu.appendChild(d);
        }
      });
    </script>"""
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(html)
            assert _set_combobox(page, page.locator("#c"), "Company website")
            assert page.inner_text("#out") == "Company Website"
            browser.close()
    except AssertionError:
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


def test_pick_combobox_options_llm_validates_options():
    from src.apply.fillers.agent import _pick_combobox_options_llm
    pending = [{"ref": "#c", "label": "How did you hear about this role?",
                "value": "Company website",
                "options": ["Cohere Careers", "LinkedIn", "Other"]}]
    canned = json.dumps([{"ref": "#c", "option": "Cohere Careers"},
                         {"ref": "#c2", "option": "LinkedIn"},        # unknown ref
                         {"ref": "#c", "option": "Made Up Option"}])  # ignored
    cfg = {"provider": "anthropic", "model": "x", "api_key_env": "FAKE_KEY4"}
    import os
    os.environ["FAKE_KEY4"] = "sk-test"
    try:
        picks = _pick_combobox_options_llm(pending, cfg, call=lambda *a: canned)
    finally:
        del os.environ["FAKE_KEY4"]
    assert picks == {"#c": "Cohere Careers"}


def test_visible_combobox_options_skips_hidden_decoys():
    """FIX 1: a Greenhouse-style page hides ~hundreds of [role=option] country
    nodes early in the DOM; the real open menu's visible options sit far past
    MAX_OPTIONS. Visibility must be established BEFORE the cap so they're seen."""
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _visible_combobox_options
    hidden = "".join(
        f"<div role='option' style='display:none'>Country{i}</div>"
        for i in range(240))
    visible = "".join(
        f"<div role='option'>Real{i}</div>" for i in range(9))
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(f"<div>{hidden}</div><div>{visible}</div>")
            opts = _visible_combobox_options(page)
            # All 9 visible options are reached despite 240 hidden decoys first.
            assert set(opts) == {f"Real{i}" for i in range(9)}
            browser.close()
    except AssertionError:
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


def test_boolean_button_pair_extracted_and_clicked():
    """FIX 5: an Ashby-style Yes/No button pair (no input/role/name) must be
    extracted as a boolean field and the correct button clicked for the mapped
    value, and left untouched when unmapped."""
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _extract_fields, _apply_mapping
    html = ("<div id='q'>"
            "<label>Are you legally eligible to work in Canada?</label>"
            "<div><button>Yes</button><button>No</button></div>"
            "<div id='out'></div></div>"
            "<script>document.querySelectorAll('#q button').forEach("
            "b => b.onclick = () => "
            "document.getElementById('out').textContent = b.textContent);"
            "</script>")
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)

            def run(value):
                page = browser.new_page()
                page.set_content(html)
                fields = _extract_fields(page)
                b = next(f for f in fields if f["type"] == "boolean")
                assert b["options"] == ["Yes", "No"]
                assert "Canada" in b["label"]
                filled, unfilled = _apply_mapping(page, fields, {b["ref"]: value})
                out = page.inner_text("#out")
                page.close()
                return b["ref"] in filled, out

            ok_no, out_no = run("No")
            assert ok_no and out_no == "No"
            ok_yes, out_yes = run("Yes")
            assert ok_yes and out_yes == "Yes"
            # Unmappable value -> not clicked, field left blank.
            ok_x, out_x = run("Maybe")
            assert not ok_x and out_x == ""
            browser.close()
    except (AssertionError, StopIteration):
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


def test_groupquestion_climb_is_bounded():
    """FIX 4: a lone acknowledge checkbox must not scrape the whole page as its
    label — the group-question climb is bounded, so a huge page-text blob does
    not become the checkbox's label (which could auto-check arbitrary boxes)."""
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _extract_fields
    big = "Back to jobs. " + ("Job description paragraph. " * 60)  # >300 chars
    html = (f"<body><header>{big}</header>"
            "<form><div><label for='ack'>I acknowledge the Candidate "
            "Privacy Policy</label>"
            "<input id='ack' type='checkbox'></div></form></body>")
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(html)
            fields = _extract_fields(page)
            ack = next(f for f in fields if f["ref"] == "#ack")
            # The label is the real acknowledge text, NOT the page-text blob.
            assert "acknowledge" in ack["label"].lower()
            assert "Job description paragraph" not in ack["label"]
            assert len(ack["label"]) < 200
            browser.close()
    except (AssertionError, StopIteration):
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


def test_pick_combobox_options_llm_no_cfg_returns_empty():
    from src.apply.fillers.agent import _pick_combobox_options_llm
    assert _pick_combobox_options_llm([{"ref": "#c", "options": ["A"]}], {}) == {}


def test_apply_mapping_combobox_llm_second_chance(monkeypatch):
    """End-to-end over a real page: the desired answer matches no option
    lexically, so the LLM pass must pick the semantic equivalent and the
    mechanical click must land it."""
    pw = pytest.importorskip("playwright.sync_api")
    import src.apply.fillers.agent as agent_mod
    html = """
    <label>How did you hear about this role?</label>
    <input id='c' role='combobox'>
    <div id='menu'></div>
    <div id='out'></div>
    <script>
      const OPTS = ['Cohere Careers', 'LinkedIn', 'Other'];
      const inp = document.getElementById('c');
      const render = (filter) => {
        const menu = document.getElementById('menu');
        menu.innerHTML = '';
        for (const o of OPTS) {
          if (!filter || o.toLowerCase().includes(filter.toLowerCase())) {
            const d = document.createElement('div');
            d.setAttribute('role', 'option');
            d.textContent = o;
            d.onclick = () => {
              document.getElementById('out').textContent = o;
              inp.value = o;                     // control reflects the choice
            };
            menu.appendChild(d);
          }
        }
      };
      inp.addEventListener('input', () => render(inp.value));
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') render('');
      });
    </script>"""
    monkeypatch.setattr(
        agent_mod, "_pick_combobox_options_llm",
        lambda pending, cfg, call=None: {p["ref"]: "Cohere Careers"
                                         for p in pending
                                         if "Cohere Careers" in p["options"]})
    fields = [{"ref": "#c", "label": "How did you hear about this role?",
               "type": "combobox", "is_select": False}]
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(html)
            filled, unfilled = agent_mod._apply_mapping(
                page, fields, {"#c": "Company website"}, llm_cfg={"x": 1})
            assert filled == ["#c"] and unfilled == []
            assert page.inner_text("#out") == "Cohere Careers"
            browser.close()
    except AssertionError:
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


def test_parse_and_format_date():
    """Date answers we actually store must parse; a vague answer must not."""
    from src.apply.fillers.agent import _parse_date, _format_date
    assert _parse_date("2027-05-10") == (2027, 5, 10)
    assert _parse_date("05/10/2027") == (2027, 5, 10)
    assert _parse_date("May 10, 2027") == (2027, 5, 10)
    assert _parse_date("May 2027") == (2027, 5, 1)       # day defaults to 1
    assert _parse_date("Flexible") is None               # no year -> honest fail
    assert _parse_date("2027") is None                   # bare year is ambiguous
    ymd = (2027, 5, 10)
    assert _format_date(ymd, "MM/DD/YYYY") == "05/10/2027"
    assert _format_date(ymd, "DD/MM/YYYY") == "10/05/2027"
    assert _format_date(ymd, "YYYY-MM-DD") == "2027-05-10"
    assert _format_date(ymd, "") == "05/10/2027"         # default US format


def test_date_picker_extracted_and_typed():
    """A date-picker INPUT (text with an MM/DD/YYYY placeholder, or a native
    <input type=date>) is routed to the date filler, which types the value in
    the placeholder's format; a readonly/calendar-only input that rejects typing
    is Escape'd and left unfilled; an unresolvable answer stays unfilled."""
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _extract_fields, _set_date
    html = """
    <label for='g'>Expected graduation date</label>
    <input id='g' type='text' placeholder='MM/DD/YYYY'>
    <label for='n'>Availability date</label>
    <input id='n' type='date'>
    <label for='ro'>Start date</label>
    <input id='ro' type='text' placeholder='MM/DD/YYYY' readonly>
    <div id='cal' style='display:none'>CALENDAR</div>
    <script>
      document.getElementById('ro').addEventListener('click',
        () => document.getElementById('cal').style.display = 'block');
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') document.getElementById('cal').style.display = 'none';
      });
    </script>"""
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(html)
            fields = _extract_fields(page)
            by_ref = {f["ref"]: f for f in fields}
            # All three are routed as date fields, carrying the format hints.
            assert by_ref["#g"]["type"] == "date"
            assert by_ref["#g"]["placeholder"] == "MM/DD/YYYY"
            assert by_ref["#n"]["type"] == "date"
            assert by_ref["#ro"]["type"] == "date" and by_ref["#ro"]["readonly"]

            # Text input with MM/DD/YYYY placeholder -> formatted keystrokes.
            assert _set_date(page, "#g", by_ref["#g"], "2027-05-10")
            assert page.input_value("#g") == "05/10/2027"
            # Native date input -> ISO fill.
            assert _set_date(page, "#n", by_ref["#n"], "2027-05-10")
            assert page.input_value("#n") == "2027-05-10"

            # Readonly / calendar-only: typing fails -> unfilled, overlay Escape'd.
            page.set_content(html)
            assert not _set_date(page, "#ro", by_ref["#ro"], "2027-05-10")
            assert page.input_value("#ro") == ""
            assert page.eval_on_selector("#cal", "el => el.style.display") == "none"

            # Unresolvable answer -> left unfilled (no guessing).
            page.set_content(html)
            assert not _set_date(page, "#g", by_ref["#g"], "Flexible")
            assert page.input_value("#g") == ""
            browser.close()
    except (AssertionError, KeyError):
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


def test_ashby_datepicker_routed_by_placeholder_and_label():
    """Ashby's calendar input has NO format mask — its placeholder is just
    "Pick date..." — so date routing must also fire on a datepicker-ish
    placeholder OR a date-ish question label. A plain text field whose label
    merely CONTAINS "candidate"/"update" (no \\bdate\\b) stays text."""
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _extract_fields
    html = """
    <label for='pick'>Anticipated graduation</label>
    <input id='pick' type='text' placeholder='Pick date...'>
    <label for='grad'>Graduation Date</label>
    <input id='grad' type='text' placeholder='Enter here'>
    <label for='cand'>Candidate ID</label>
    <input id='cand' type='text' placeholder='e.g. 12345'>"""
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(html)
            by_ref = {f["ref"]: f for f in _extract_fields(page)}
            # "Pick date..." placeholder -> date (no format mask present).
            assert by_ref["#pick"]["type"] == "date"
            # "Graduation Date" label -> date even with a plain placeholder.
            assert by_ref["#grad"]["type"] == "date"
            # "Candidate ID" -> stays text (\bdate\b must not match "candidate").
            assert by_ref["#cand"]["type"] == "text"
            browser.close()
    except (AssertionError, KeyError):
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


def test_text_fill_verification_catches_blur_reparse():
    """The plain-text path must read the value back AFTER blur: a widget that
    accepts fill() but clears/reparses on blur (OpenAI's Ashby date field cleared
    "Flexible" on blur) must be counted UNFILLED, not filled off the pre-blur
    read. Verified without a browser via a fake locator."""
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _set_field
    # A text input whose blur handler wipes anything that isn't all-digits
    # (mimics a masked/parsing widget rejecting free text on commit).
    html = """
    <label for='d'>Availability</label>
    <input id='d' type='text'>
    <script>
      document.getElementById('d').addEventListener('blur', (e) => {
        if (!/^\\d+$/.test(e.target.value)) e.target.value = '';
      });
    </script>"""
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(html)
            field = {"ref": "#d", "label": "Availability", "type": "text"}
            # "Flexible" is wiped on blur -> not filled (blind pre-blur read
            # would have wrongly passed).
            assert not _set_field(page, "#d", field, "Flexible")
            assert page.input_value("#d") == ""
            # A value the widget keeps on blur still counts as filled.
            page.set_content(html)
            assert _set_field(page, "#d", field, "12345")
            assert page.input_value("#d") == "12345"
            browser.close()
    except (AssertionError, KeyError):
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


def test_conditional_field_revealed_after_answer_gets_filled():
    """A field injected only AFTER an earlier answer (Greenhouse's EEO "race"
    select appears once "Hispanic/Latino?" is set) must be filled by the reveal
    pass, not left blank because the first extract never saw it."""
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _extract_fields, _fill_revealed_fields
    html = """
    <label for='eth'>Are you Hispanic/Latino?</label>
    <select id='eth' onchange="if(this.value==='No')
        document.getElementById('slot').innerHTML=
          '<label for=race>Please identify your race</label>'+
          '<select id=race><option></option><option>Asian</option>'+
          '<option>White</option></select>';">
      <option></option><option>Yes</option><option>No</option>
    </select>
    <div id='slot'></div>"""
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(html)
            first = _extract_fields(page)
            # The race select does NOT exist yet.
            assert not any(f["ref"] == "#race" for f in first)
            # Answering Hispanic/Latino reveals it.
            page.select_option("#eth", "No")
            profile = _profile()
            profile.eeo.race = "Asian"
            filled, unfilled, revealed = _fill_revealed_fields(
                page, first, profile, {})
            assert "#race" in filled
            assert any(f["ref"] == "#race" for f in revealed)
            assert page.input_value("#race") == "Asian"
            browser.close()
    except AssertionError:
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


def test_boolean_no_clicks_its_own_groups_button():
    """Forms with SEVERAL Yes/No button pairs (work-auth + sponsorship, as on
    Snowflake/Notion boards): answering "No" to the second question must click
    THAT group's No — never the page's first No button."""
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _extract_fields, _set_boolean
    html = """
    <fieldset><label>Are you authorized to work in the US?</label>
      <div><button onclick="out1.textContent='Yes'">Yes</button></div>
      <div><button onclick="out1.textContent='No'">No</button></div>
    </fieldset>
    <fieldset><label>Do you require sponsorship?</label>
      <div><button onclick="out2.textContent='Yes'">Yes</button></div>
      <div><button onclick="out2.textContent='No'">No</button></div>
    </fieldset>
    <div id='out1'></div><div id='out2'></div>"""
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(html)
            bools = [f for f in _extract_fields(page) if f["type"] == "boolean"]
            assert len(bools) == 2
            sponsor = next(b for b in bools if "sponsorship" in b["label"].lower())
            assert _set_boolean(page, sponsor["ref"], "No")
            assert page.inner_text("#out2") == "No"     # its own group...
            assert page.inner_text("#out1") == ""       # ...not the first No
            browser.close()
    except AssertionError:
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


# ---------------------------------------------- read-back verification (pure)

def test_labels_equivalent_tolerates_reflow_and_substring():
    from src.apply.fillers.agent import _labels_equivalent
    assert _labels_equivalent("Company Website", "company website")
    assert _labels_equivalent("Yes", "  Yes  ✓")          # widget echo suffix
    assert _labels_equivalent("United States", "United  States")
    assert not _labels_equivalent("Yes", "No")
    assert not _labels_equivalent("", "Yes")              # empty never matches


def test_selection_verified_direct_and_mapped():
    from src.apply.fillers.agent import _selection_verified
    opts = ["I am authorized to work", "I am not authorized"]
    # Direct label echo.
    assert _selection_verified("I am authorized to work", "I am authorized to work", opts)
    # Canonical "Yes" maps onto the authorized option (match_option semantics).
    assert _selection_verified("I am authorized to work", "Yes", opts)
    # The wrong option landed -> not verified.
    assert not _selection_verified("I am not authorized", "Yes", opts)
    # Nothing selected (empty chosen) -> not verified.
    assert not _selection_verified("", "Yes", opts)


def test_combobox_verified_requires_displayed_choice():
    from src.apply.fillers.agent import _combobox_verified
    assert _combobox_verified("Cohere Careers", "Cohere Careers")
    assert not _combobox_verified("", "Cohere Careers")   # blind-click, nothing shown


def test_button_pressed_reads_aria_and_data_state():
    from src.apply.fillers.agent import _button_pressed

    class FakeLoc:
        def __init__(self, attrs):
            self._attrs = attrs
        def evaluate(self, _js):
            return {"pressed": self._attrs.get("aria-pressed"),
                    "checked": self._attrs.get("aria-checked"),
                    "selected": self._attrs.get("aria-selected"),
                    "data": self._attrs.get("data-state")}

    assert _button_pressed(FakeLoc({"aria-pressed": "true"})) is True
    assert _button_pressed(FakeLoc({"data-state": "checked"})) is True
    assert _button_pressed(FakeLoc({"aria-pressed": "false"})) is False
    # No selection signal at all -> unverifiable (None); caller treats as "not
    # a negative", so a plain <button> pair still counts on a successful click.
    assert _button_pressed(FakeLoc({})) is None


def test_select_verification_rejects_unselected(monkeypatch):
    """A <select> whose select_option silently selects nothing must NOT be
    reported filled (browser-free: fake the locator)."""
    import src.apply.fillers.agent as agent_mod

    class FakeLoc:
        def __init__(self, landed):
            self.landed = landed          # what the select ends up showing
        first = property(lambda self: self)
        def scroll_into_view_if_needed(self, **k):
            pass
        def select_option(self, **k):
            pass                          # pretend it did nothing useful

    class FakePage:
        def __init__(self, landed):
            self._loc = FakeLoc(landed)
        def locator(self, ref):
            return self._loc

    field = {"ref": "#s", "label": "Country", "type": "select",
             "is_select": True, "options": ["United States", "Canada"]}
    monkeypatch.setattr(agent_mod, "_select_label",
                        lambda loc: loc.landed)
    # Landed on the intended option -> filled.
    assert agent_mod._set_field(FakePage("United States"), "#s", field,
                                "United States")
    # Selection didn't stick (empty) -> not filled.
    assert not agent_mod._set_field(FakePage(""), "#s", field, "United States")


# --------------------------------------------- required extraction + threading

def test_extract_required_flag():
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _extract_fields
    html = """
    <label for='e'>Email</label><input id='e' required>
    <label for='n'>Name</label><input id='n'>
    <label for='p'>Phone</label><input id='p' aria-required='true'>
    <div><label>Sponsorship?*</label>
      <div><button>Yes</button><button>No</button></div></div>"""
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(html)
            by_ref = {f["ref"]: f for f in _extract_fields(page)}
            assert by_ref["#e"]["required"] is True          # native required
            assert by_ref["#p"]["required"] is True          # aria-required
            assert by_ref["#n"]["required"] is False
            # The button-pair group's asterisk marks it required.
            b = next(f for f in _extract_fields(page) if f["type"] == "boolean")
            assert b["required"] is True
            browser.close()
    except (AssertionError, StopIteration, KeyError):
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


_GATE_FORM = [
    {"ref": "#email", "label": "Email", "type": "email", "required": True},
    {"ref": "#name", "label": "Full name", "type": "text", "required": True},
    {"ref": "#notes", "label": "Notes", "type": "text", "required": False},
    {"ref": "#nolabel", "label": "", "type": "text", "required": True},
]


def test_split_unfilled_required_vs_optional():
    from src.apply.fillers.agent import split_unfilled
    req, opt = split_unfilled(_GATE_FORM, ["#email", "#notes", "#name", "#notes"])
    assert req == ["Email", "Full name"]                 # deduped, order-stable
    assert opt == ["Notes"]
    # A required field with no label falls back to its ref.
    req2, _ = split_unfilled(_GATE_FORM, ["#nolabel"])
    assert req2 == ["#nolabel"]
    # Unknown ref (not in the form) is treated as optional, never gated.
    _, opt2 = split_unfilled(_GATE_FORM, ["#ghost"])
    assert opt2 == ["#ghost"]


def test_gate_block_labels_on_and_off():
    from src.apply.fillers.agent import gate_block_labels
    # Gate ON: required blanks block, listing their labels.
    assert gate_block_labels(_GATE_FORM, ["#email", "#notes"]) == ["Email"]
    # Only an optional blank -> nothing blocks (submit may proceed).
    assert gate_block_labels(_GATE_FORM, ["#notes"]) == []
    # Gate OFF -> never blocks, even with a required blank.
    assert gate_block_labels(_GATE_FORM, ["#email"], enabled=False) == []


# --------------------------------------------------- submit-gate in _apply()

def _gate_ctx(mode, submit_gate=True):
    from src.apply.base import ApplyContext, ATSFamily
    return ApplyContext(job={"key": "jr:x"}, profile=_profile(),
                        resume_path=__import__("pathlib").Path("nope.docx"),
                        mode=mode, final_url="https://x", family=ATSFamily.unknown,
                        submit_gate=submit_gate)


def _stub_apply(monkeypatch, *, unfilled_fields, required_fields):
    """Make AgentFiller._apply run browser-free: one required field is unfilled
    so the gate can act. `required_fields` are refs flagged required."""
    import src.apply.fillers.agent as agent_mod
    fields = [{"ref": r, "label": r.lstrip("#").title(), "type": "text",
               "required": r in required_fields} for r in unfilled_fields]
    monkeypatch.setattr(agent_mod, "_extract_fields", lambda page: list(fields))
    monkeypatch.setattr(agent_mod, "map_fields",
                        lambda ff, prof, cfg: ({}, ["ok"]))
    monkeypatch.setattr(agent_mod, "_apply_mapping",
                        lambda page, ff, m, llm_cfg=None: ([], []))
    monkeypatch.setattr(agent_mod, "_fill_revealed_fields",
                        lambda page, sf, prof, cfg: ([], [], []))
    monkeypatch.setattr(agent_mod, "_attach_resume", lambda page, rp: False)
    monkeypatch.setattr(agent_mod, "has_visible_captcha", lambda page: False)
    monkeypatch.setattr(agent_mod, "_llm_cfg", lambda user: {})
    clicked = {"submit": False}
    def fake_submit(page):
        clicked["submit"] = True
        return True
    monkeypatch.setattr(agent_mod, "_click_submit", fake_submit)
    monkeypatch.setattr(agent_mod, "_confirmation_present", lambda page: True)
    return agent_mod, clicked


def test_submit_gate_blocks_before_click(monkeypatch):
    from src.apply.base import ApplyMode, ApplyStatus
    agent_mod, clicked = _stub_apply(
        monkeypatch, unfilled_fields=["#email", "#notes"],
        required_fields={"#email"})
    res = agent_mod.AgentFiller()._apply(object(), _gate_ctx(ApplyMode.submit))
    assert res.status is ApplyStatus.blocked_incomplete
    assert clicked["submit"] is False                    # NEVER clicked
    assert res.unfilled_fields == ["Email"]              # blocking label
    assert "Email" in res.message


def test_submit_gate_off_submits(monkeypatch):
    from src.apply.base import ApplyMode, ApplyStatus
    agent_mod, clicked = _stub_apply(
        monkeypatch, unfilled_fields=["#email"], required_fields={"#email"})
    res = agent_mod.AgentFiller()._apply(
        object(), _gate_ctx(ApplyMode.submit, submit_gate=False))
    assert clicked["submit"] is True                     # gate off -> proceeds
    assert res.status is ApplyStatus.submitted


def test_submit_gate_passes_when_only_optional_unfilled(monkeypatch):
    from src.apply.base import ApplyMode, ApplyStatus
    agent_mod, clicked = _stub_apply(
        monkeypatch, unfilled_fields=["#notes"], required_fields=set())
    res = agent_mod.AgentFiller()._apply(object(), _gate_ctx(ApplyMode.submit))
    assert clicked["submit"] is True
    assert res.status is ApplyStatus.submitted


def test_autofill_splits_required_vs_optional(monkeypatch):
    from src.apply.base import ApplyMode, ApplyStatus
    agent_mod, _ = _stub_apply(
        monkeypatch, unfilled_fields=["#email", "#notes"],
        required_fields={"#email"})
    monkeypatch.setattr(agent_mod, "_screenshot", lambda page, ctx: None)
    res = agent_mod.AgentFiller()._apply(object(), _gate_ctx(ApplyMode.autofill))
    assert res.status is ApplyStatus.filled_paused
    # Report calls out the required gap explicitly.
    assert "required unfilled: Email" in res.message
    assert set(res.unfilled_fields) == {"Email", "Notes"}


# ------------------------------------------- post-submit verification (pure)

def test_path_of_strips_host_query_fragment():
    from src.apply.fillers.agent import _path_of
    assert _path_of("https://boards.greenhouse.io/acme/jobs/1/apply"
                    "?utm=x#top") == "/acme/jobs/1/apply"
    assert _path_of("https://job.example.com/") == "/"
    assert _path_of("HTTPS://Host.COM/Thanks") == "/thanks"


def test_url_moved_off_form_signal():
    from src.apply.fillers.agent import _url_moved_off_form
    apply_url = "https://x.io/acme/jobs/1/apply"
    # Landed on a confirmation fragment -> moved.
    assert _url_moved_off_form(apply_url, "https://x.io/acme/thanks")
    assert _url_moved_off_form(apply_url, "https://x.io/acme/jobs/1/confirmation")
    # Dropped the /apply segment entirely (back to the board) -> moved.
    assert _url_moved_off_form(apply_url, "https://x.io/acme/jobs")
    # Same path (only a query changed) -> NOT a move.
    assert not _url_moved_off_form(apply_url, apply_url + "?step=2")
    # Still under /application (SPA step swap) -> NOT a move.
    assert not _url_moved_off_form("https://x.io/application/1",
                                   "https://x.io/application/2")
    # Empty after-url -> NOT a move.
    assert not _url_moved_off_form(apply_url, "")


class _VerifyPage:
    """A minimal page whose text/DOM state drives verify_submission. `texts`
    are the visible phrases; `submit` toggles whether a submit control exists;
    `url` is the post-submit URL."""

    def __init__(self, texts=(), submit=True, url="https://x.io/apply"):
        self._texts = [t.lower() for t in texts]
        self._submit = submit
        self.url = url

    class _Count:
        def __init__(self, n):
            self._n = n
        def count(self):
            return self._n

    def get_by_text(self, pattern):
        hit = any(pattern.search(t) for t in self._texts)
        return self._Count(1 if hit else 0)

    def locator(self, sel):
        return self._Count(1 if self._submit else 0)

    def get_by_role(self, role, name=None):
        return self._Count(0)


def _verify_ctx(final_url="https://x.io/apply"):
    from src.apply.base import ApplyContext, ATSFamily
    import pathlib
    return ApplyContext(job={"key": "jr:x"}, profile=_profile(),
                        resume_path=pathlib.Path("nope.docx"),
                        mode=None, final_url=final_url, family=ATSFamily.unknown)


def test_verify_submission_confirmation_text_wins_first():
    from src.apply.fillers.agent import verify_submission
    page = _VerifyPage(texts=["Application submitted"], submit=True)
    confirmed, signal = verify_submission(page, _verify_ctx())
    assert confirmed and signal == "confirmation-text"


def test_verify_submission_url_moved():
    from src.apply.fillers.agent import verify_submission
    # No confirmation phrase, submit still there, but URL left the form.
    page = _VerifyPage(texts=[], submit=True, url="https://x.io/thanks")
    confirmed, signal = verify_submission(
        page, _verify_ctx(final_url="https://x.io/apply"))
    assert confirmed and signal == "url-moved"


def test_verify_submission_submit_gone_without_error():
    from src.apply.fillers.agent import verify_submission
    # Submit control disappeared and no validation error visible -> confirmed.
    page = _VerifyPage(texts=[], submit=False, url="https://x.io/apply")
    confirmed, signal = verify_submission(page, _verify_ctx())
    assert confirmed and signal == "submit-gone"


def test_verify_submission_submit_gone_but_validation_error_is_no_signal():
    from src.apply.fillers.agent import verify_submission
    # Submit vanished, but the form shows a validation error -> NOT confirmed.
    page = _VerifyPage(texts=["This field is required"], submit=False,
                       url="https://x.io/apply")
    confirmed, signal = verify_submission(page, _verify_ctx())
    assert not confirmed and signal == "no-signal"


def test_verify_submission_no_signal():
    from src.apply.fillers.agent import verify_submission
    # Same URL, submit still present, no phrases -> nothing fired.
    page = _VerifyPage(texts=[], submit=True, url="https://x.io/apply")
    confirmed, signal = verify_submission(page, _verify_ctx())
    assert not confirmed and signal == "no-signal"


def test_submit_records_attempt_and_screenshot(monkeypatch, tmp_path):
    """The submit path must always attach submit_attempt metadata (confirmed +
    signal + screenshot) once the click happened - even when confirmation
    fails - so the queue can persist a permanent ledger attempt."""
    from src.apply.base import ApplyMode, ApplyStatus
    agent_mod, clicked = _stub_apply(
        monkeypatch, unfilled_fields=["#notes"], required_fields=set())
    # Confirmed via a named signal; screenshot lands in the artifacts dir.
    monkeypatch.setattr(agent_mod, "verify_submission",
                        lambda page, ctx: (True, "confirmation-text"))
    monkeypatch.setattr(agent_mod, "_confirmation_screenshot",
                        lambda page, ctx: tmp_path / "confirmation.png")
    res = agent_mod.AgentFiller()._apply(object(), _gate_ctx(ApplyMode.submit))
    assert res.status is ApplyStatus.submitted
    assert res.submit_attempt is not None
    assert res.submit_attempt["confirmed"] is True
    assert res.submit_attempt["signal"] == "confirmation-text"
    assert res.submit_attempt["screenshot"].endswith("confirmation.png")
    assert "confirmed via confirmation-text" in res.message


def test_submit_unconfirmed_still_records_attempt(monkeypatch, tmp_path):
    from src.apply.base import ApplyMode, ApplyStatus
    agent_mod, clicked = _stub_apply(
        monkeypatch, unfilled_fields=["#notes"], required_fields=set())
    monkeypatch.setattr(agent_mod, "verify_submission",
                        lambda page, ctx: (False, "no-signal"))
    monkeypatch.setattr(agent_mod, "_confirmation_screenshot",
                        lambda page, ctx: None)
    res = agent_mod.AgentFiller()._apply(object(), _gate_ctx(ApplyMode.submit))
    # Confirmation failed -> error status, but the attempt is STILL recorded so
    # the queue guard blocks any re-submit.
    assert res.status is ApplyStatus.error
    assert res.submit_attempt is not None
    assert res.submit_attempt["confirmed"] is False
    assert res.submit_attempt["signal"] == "no-signal"


# ------------------------------- E1..E6 live-verified extraction/read-back fixes

# react-select markup as Greenhouse's new job-boards UI renders it: the <input>
# carries class select__input AND role=combobox; the CHOSEN label lives in a
# sibling .select__single-value, and react-select CLEARS the input's own value.
_REACT_SELECT_HTML = """
<div class='select__container'>
  <div class='select__control'>
    <div class='select__value-container'>
      <div class='select__single-value'>Bachelor's Degree</div>
      <div class='select__input-container'>
        <input id='degree--0' class='select__input' role='combobox' value=''>
      </div>
    </div>
  </div>
</div>"""


def test_combobox_display_reads_react_select_single_value():
    """E1: react-select clears the input and shows the choice in a sibling
    .select__single-value; the old closest() matched the input itself and read
    '' — every Greenhouse selection came back empty (false unfilled). The
    read-back must return the single-value text."""
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _combobox_display
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(_REACT_SELECT_HTML)
            loc = page.locator("#degree--0")
            assert _combobox_display(page, loc) == "Bachelor's Degree"
            browser.close()
    except AssertionError:
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


def test_combobox_display_prefers_ashby_input_value():
    """E1: Ashby echoes the chosen label into the input's OWN value — that first
    (cheapest) check must keep working, unaffected by the react-select path."""
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _combobox_display
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content("<input id='c' role='combobox' value='LinkedIn'>")
            assert _combobox_display(page, page.locator("#c")) == "LinkedIn"
            browser.close()
    except AssertionError:
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


def test_combobox_verify_option_lands_on_react_select():
    """E1 end-to-end: clicking an option whose selection is reflected only in
    .select__single-value (react-select style) must VERIFY as landed, not
    falsely read back empty."""
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _set_combobox
    html = """
    <div class='select__container'>
      <div class='select__control'>
        <div class='select__value-container' id='vc'>
          <div class='select__input-container'>
            <input id='c' class='select__input' role='combobox'>
          </div>
        </div>
      </div>
    </div>
    <div id='menu'></div>
    <script>
      const OPTS = ["Bachelor's Degree", "Master's Degree", "PhD"];
      const inp = document.getElementById('c');
      const vc = document.getElementById('vc');
      const render = (filter) => {
        const menu = document.getElementById('menu');
        menu.innerHTML = '';
        for (const o of OPTS) {
          if (!filter || o.toLowerCase().includes(filter.toLowerCase())) {
            const d = document.createElement('div');
            d.setAttribute('role', 'option');
            d.textContent = o;
            d.onclick = () => {
              // react-select behaviour: input value stays EMPTY; the label goes
              // into a single-value node in the value container.
              inp.value = '';
              let sv = vc.querySelector('.select__single-value');
              if (!sv) { sv = document.createElement('div');
                sv.className = 'select__single-value';
                vc.insertBefore(sv, vc.firstChild); }
              sv.textContent = o;
              menu.innerHTML = '';
            };
            menu.appendChild(d);
          }
        }
      };
      inp.addEventListener('input', () => render(inp.value));
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') render('');
      });
    </script>"""
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(html)
            assert _set_combobox(page, page.locator("#c"), "Bachelor's Degree")
            assert page.inner_text(".select__single-value") == "Bachelor's Degree"
            assert page.input_value("#c") == ""      # react-select cleared it
            browser.close()
    except AssertionError:
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


def test_field_cap_counts_groups_not_options():
    """E2: a long radio/checkbox list must NOT exhaust the field budget and
    starve the required controls that follow it (Palantir Lever's 32-checkbox
    language list dropped work-auth/sponsorship/EEO past position 40). The cap
    counts GROUPS, so a big option list is ONE question."""
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _extract_fields
    # One checkbox GROUP with 60 options, then a required work-auth boolean.
    options = "".join(
        f"<div><label for='lang{i}'>Lang{i}</label>"
        f"<input id='lang{i}' type='checkbox'></div>" for i in range(60))
    html = (
        "<form>"
        "<fieldset><legend>Which languages do you speak?</legend>"
        f"{options}</fieldset>"
        "<fieldset><label>Are you authorized to work in the US?*</label>"
        "<div><button>Yes</button><button>No</button></div></fieldset>"
        "</form>")
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(html)
            fields = _extract_fields(page)
            # The required work-auth boolean survived past the 60-option list.
            b = next((f for f in fields if f["type"] == "boolean"), None)
            assert b is not None
            assert "authorized" in b["label"].lower()
            assert b["required"] is True
            browser.close()
    except (AssertionError, StopIteration):
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


def test_large_form_not_truncated_below_required_field():
    """E2: a 60+ text-field form (Notion has 61) must not silently drop later
    required fields off the end — the cap is now well above real form sizes."""
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _extract_fields
    inputs = "".join(
        f"<label for='f{i}'>Field {i}</label><input id='f{i}'>"
        for i in range(60))
    html = (f"<form>{inputs}"
            "<label for='auth'>Authorized to work lawfully?</label>"
            "<input id='auth' required></form>")
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(html)
            refs = {f["ref"] for f in _extract_fields(page)}
            # The 61st field (the required one) is present, not truncated away.
            assert "#auth" in refs
            browser.close()
    except AssertionError:
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


def test_aria_hidden_requiredinput_shim_skipped():
    """E3: react-select adds a ghost aria-hidden 'requiredInput' shim per
    required select (empty label, required=true) that still lays out with size,
    so rect/offsetParent checks don't catch it. It must be skipped, not emitted
    as a phantom required field that pollutes the gate."""
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _extract_fields
    html = """
    <div class='select__container'>
      <label for='degree--0'>Highest degree</label>
      <div class='select__control'>
        <input id='degree--0' class='select__input' role='combobox'>
      </div>
      <input class='remix-css-abc-requiredInput' aria-hidden='true'
             required tabindex='-1' style='width:1px;height:1px'>
    </div>
    <div aria-hidden='true'>
      <input id='ghost' required style='width:20px;height:20px'>
    </div>"""
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(html)
            fields = _extract_fields(page)
            refs = {f.get("ref") for f in fields}
            # The real combobox is kept...
            assert "#degree--0" in refs
            # ...but neither aria-hidden shim (self-hidden or ancestor-hidden).
            assert "#ghost" not in refs
            assert not any("requiredInput" in (f.get("ref") or "")
                           for f in fields)
            # No phantom empty-labelled required field slipped through.
            assert not any(f.get("required") and not (f.get("label") or "").strip()
                           and f.get("type") not in ("boolean",)
                           for f in fields if f.get("ref") not in ("#degree--0",))
            browser.close()
    except AssertionError:
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


def test_required_detected_from_css_after_asterisk():
    """E4: some ATSes (Cohere/Ashby) mark a required question with a CSS-injected
    "*" in label::after — invisible to innerText, so a text-only scan mis-read
    it as optional (fail-open). getComputedStyle(::after) must catch it."""
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _extract_fields
    html = """
    <style>label.req::after { content: '*'; color: red; }</style>
    <label class='req' for='avail'>Are you available to start?</label>
    <div><input id='avail' role='combobox'></div>
    <label for='plain'>Optional note</label>
    <input id='plain'>"""
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(html)
            by_ref = {f["ref"]: f for f in _extract_fields(page)}
            # The ::after asterisk marks the combobox required.
            assert by_ref["#avail"]["required"] is True
            # No asterisk anywhere -> stays optional.
            assert by_ref["#plain"]["required"] is False
            browser.close()
    except (AssertionError, KeyError):
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


def test_wait_for_form_stable_returns_when_count_settles():
    """E5: the first extract must wait for the candidate-field count to stop
    changing (SPA/remote render) rather than a fixed sleep — a form that grows
    from a handful of fields to its full set must be seen complete."""
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _wait_for_form_stable, _extract_fields
    # A page that injects the rest of its fields ~500ms after load.
    html = """
    <form id='f'><label for='a'>A</label><input id='a'></form>
    <script>
      setTimeout(() => {
        const f = document.getElementById('f');
        for (let i = 0; i < 20; i++) {
          const l = document.createElement('label'); l.textContent = 'F'+i;
          const inp = document.createElement('input'); inp.id = 'late'+i;
          f.appendChild(l); f.appendChild(inp);
        }
      }, 500);
    </script>"""
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(html)
            _wait_for_form_stable(page, settle_ms=400, max_ms=6000, poll_ms=150)
            refs = {f["ref"] for f in _extract_fields(page)}
            # The late-injected fields are present after the stability wait.
            assert "#late0" in refs and "#late19" in refs
            browser.close()
    except AssertionError:
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


def test_wait_for_form_stable_caps_out_on_churning_page():
    """E5: a page whose field count never settles must not hang — the wait is
    bounded by max_ms and returns anyway."""
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _wait_for_form_stable
    html = """
    <form id='f'></form>
    <script>
      let i = 0;
      setInterval(() => {
        const inp = document.createElement('input'); inp.id = 'c'+(i++);
        document.getElementById('f').appendChild(inp);
      }, 100);
    </script>"""
    import time
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(html)
            start = time.monotonic()
            _wait_for_form_stable(page, settle_ms=400, max_ms=1500, poll_ms=150)
            elapsed = time.monotonic() - start
            # Returned near the cap, not hung forever.
            assert elapsed < 4.0
            browser.close()
    except AssertionError:
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


_E6_FORM = [
    {"ref": "#r1", "label": "Race — White", "type": "checkbox", "required": False},
    {"ref": "#r2", "label": "Race — Asian", "type": "checkbox", "required": False},
    {"ref": "#r3", "label": "Race — Black", "type": "checkbox", "required": False},
    {"ref": "#g1", "label": "Gender — Male", "type": "radio", "required": True},
    {"ref": "#g2", "label": "Gender — Female", "type": "radio", "required": True},
    {"ref": "#notes", "label": "Notes", "type": "text", "required": False},
]


def test_unfilled_reported_at_question_level_for_groups():
    """E6: an unfilled radio/checkbox group must be reported ONCE at the QUESTION
    level ("Race"), not once per unselected option ("Race — White", "Race —
    Asian", ...) — a fully-answered form otherwise listed 13 phantom unfilled
    lines. Non-group fields keep their own label."""
    from src.apply.fillers.agent import split_unfilled
    req, opt = split_unfilled(
        _E6_FORM, ["#r1", "#r2", "#r3", "#g1", "#g2", "#notes"])
    # The three race options collapse to one "Race"; the two gender radios to
    # one "Gender"; the text field keeps its label.
    assert opt == ["Race", "Notes"]
    assert req == ["Gender"]


def test_group_collapse_keeps_gate_block_decision():
    """E6: collapsing options to question level must NOT change the gate's
    blocking decision — a required group still blocks (non-empty), an
    all-optional set still doesn't."""
    from src.apply.fillers.agent import gate_block_labels
    # Required gender group unfilled -> still blocks, now as one "Gender" label.
    assert gate_block_labels(_E6_FORM, ["#g1", "#g2"]) == ["Gender"]
    # Only optional race options unfilled -> nothing blocks.
    assert gate_block_labels(_E6_FORM, ["#r1", "#r2", "#r3"]) == []


# ------------------------- verification residuals (2026-07-03 live run) -----

def test_v1_required_from_descendant_span_pseudo_asterisk():
    """V1: the required "*" is a ::after on a DESCENDANT span of the question
    label (Notion's Ashby form), not on the label/container itself. The
    ancestor-only pseudo scan missed it and read the boolean as optional
    (fail-open, ungated). asteriskNear must scan descendants too."""
    pw = pytest.importorskip("playwright.sync_api")
    from src.apply.fillers.agent import _extract_fields
    # The "*" lives on an inner <span>, whose ::after injects it — the label
    # container and the buttons carry no asterisk of their own.
    html = """
    <style>span.mark::after { content: '*'; color: red; }</style>
    <div id='q'>
      <div class='qlabel'>Are you authorized to work lawfully in the United
        States?<span class='mark'></span></div>
      <div><button>Yes</button><button>No</button></div>
    </div>
    <div id='q2'>
      <div class='qlabel'>Do you have any comments?</div>
      <div><button>Yes</button><button>No</button></div>
    </div>"""
    try:
        with pw.sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_content(html)
            bools = [f for f in _extract_fields(page) if f["type"] == "boolean"]
            work = next(b for b in bools if "authorized" in b["label"].lower())
            other = next(b for b in bools if "comments" in b["label"].lower())
            # The descendant-span asterisk marks the work-auth boolean required.
            assert work["required"] is True
            # The comments boolean has no asterisk anywhere -> stays optional.
            assert other["required"] is False
            browser.close()
    except (AssertionError, StopIteration):
        raise
    except Exception as exc:
        pytest.skip(f"playwright browser unavailable: {exc}")


def test_v2_reveal_round_skips_reindexed_boolean_pairs(monkeypatch):
    """V2: after a DOM shift bumps page-wide :nth-match(button, N) indices, the
    reveal round re-extracts the SAME already-filled Yes/No pairs under new refs.
    Keying the diff on (question, type) — not the synthetic ref — must skip them,
    so they are neither re-filled nor re-clicked."""
    import src.apply.fillers.agent as agent_mod
    # First extract saw two boolean questions at button indices 1 and 3.
    seen = [
        {"ref": ":nth-match(button, 1)", "label": "Authorized to work?",
         "type": "boolean", "options": ["Yes", "No"], "required": True},
        {"ref": ":nth-match(button, 3)", "label": "Require sponsorship?",
         "type": "boolean", "options": ["Yes", "No"], "required": True},
    ]
    # After a resume upload the indices shift +1: SAME questions, new refs, plus
    # one genuinely-new revealed text field.
    shifted = [
        {"ref": ":nth-match(button, 2)", "label": "Authorized to work?",
         "type": "boolean", "options": ["Yes", "No"], "required": True},
        {"ref": ":nth-match(button, 4)", "label": "Require sponsorship?",
         "type": "boolean", "options": ["Yes", "No"], "required": True},
        {"ref": "#race", "label": "Please identify your race", "type": "select",
         "is_select": True, "options": ["Asian"], "required": False},
    ]
    extracts = iter([shifted, []])          # round 1 then nothing new
    monkeypatch.setattr(agent_mod, "_extract_fields",
                        lambda page: next(extracts))
    monkeypatch.setattr(agent_mod, "map_fields",
                        lambda ff, prof, cfg: ({f["ref"]: "x" for f in ff}, []))
    applied: list[str] = []

    def fake_apply(page, ff, mapping, llm_cfg=None):
        # Record which refs the reveal round tried to (re-)fill.
        applied.extend(mapping.keys())
        return list(mapping.keys()), []

    monkeypatch.setattr(agent_mod, "_apply_mapping", fake_apply)

    class _Page:
        def wait_for_timeout(self, _ms):
            pass

    filled, unfilled, revealed = agent_mod._fill_revealed_fields(
        _Page(), seen, _profile(), {})
    # The two re-indexed boolean pairs are recognised as already-seen questions
    # and skipped; only the genuinely-new race select is filled.
    assert ":nth-match(button, 2)" not in applied
    assert ":nth-match(button, 4)" not in applied
    assert applied == ["#race"]
    assert [f["ref"] for f in revealed] == ["#race"]


_V3_FORM = [
    {"ref": "#g1", "label": "Gender — Male", "type": "radio", "required": True},
    {"ref": "#g2", "label": "Gender — Female", "type": "radio", "required": True},
    {"ref": "#r1", "label": "Race — White", "type": "checkbox", "required": False},
    {"ref": "#r2", "label": "Race — Asian", "type": "checkbox", "required": False},
    {"ref": "#s1", "label": "Sponsorship? — Yes", "type": "radio", "required": True},
    {"ref": "#s2", "label": "Sponsorship? — No", "type": "radio", "required": True},
    {"ref": "#notes", "label": "Notes", "type": "text", "required": False},
]


def test_v3_answered_group_omitted_from_unfilled():
    """V3: a radio/checkbox group with ONE option already selected is answered —
    its remaining unpicked options must not list the whole question as unfilled.
    The live run reported Gender/Race/Sponsorship as unfilled while the screenshot
    showed them answered."""
    from src.apply.fillers.agent import split_unfilled
    # Every option ref is "unfilled" (the unpicked ones), but one option per group
    # was actually selected -> those groups are answered.
    unfilled = ["#g1", "#g2", "#r1", "#r2", "#s1", "#s2", "#notes"]
    filled = ["#g2", "#r2", "#s2"]          # one option chosen per group
    req, opt = split_unfilled(_V3_FORM, unfilled, filled)
    # Answered groups drop out entirely; only the never-touched text field stays.
    assert req == []
    assert opt == ["Notes"]
    # Without the filled info (old behaviour) the groups DO still appear — proving
    # the filled_refs argument is what removes them.
    req2, opt2 = split_unfilled(_V3_FORM, unfilled)
    assert "Gender" in req2 and "Sponsorship?" in req2
    assert "Race" in opt2


def test_v3_unanswered_required_group_still_blocks():
    """V3: gate semantics unchanged for a genuinely-unanswered required group —
    with NO option selected it must still block the submit."""
    from src.apply.fillers.agent import gate_block_labels
    unfilled = ["#g1", "#g2", "#s1", "#s2"]
    # Only the sponsorship group got an answer; gender is still untouched.
    blocking = gate_block_labels(_V3_FORM, unfilled, filled_refs=["#s2"])
    assert blocking == ["Gender"]
    # Nothing selected anywhere -> both required groups block.
    assert gate_block_labels(_V3_FORM, unfilled) == ["Gender", "Sponsorship?"]