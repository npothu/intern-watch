"""Answer-book tests: resolving the long tail of portal questions (pure)."""

from __future__ import annotations

import pytest

from src.apply.answers import answer_for, canonical_answers, match_option
from src.apply.profile import ApplyProfile


def _p() -> ApplyProfile:
    return ApplyProfile.model_validate({
        "name": "Alex J. Example",
        "email": "alex@example.com",
        "phone": "(555) 010-4477",
        "city": "Atlanta",
        "state": "Georgia",
        "address": {"street": "123 Tech Walk", "postal_code": "30332"},
        "links": {"linkedin": "https://linkedin.com/in/alex-example",
                  "github": "https://github.com/example"},
        "work_authorization": {"authorized_us": True, "requires_sponsorship": False,
                               "citizenship": "US Citizen"},
        "eeo": {"gender": "Decline to self-identify",
                "veteran_status": "Decline to self-identify"},
        "education": {"school": "Georgia Tech", "degree": "Bachelor's",
                      "major": "Computer Science", "gpa": "3.7",
                      "grad_month": "May", "grad_year": "2027"},
        "compensation": {"desired_salary": "Open"},
        "logistics": {"start_date": "Available immediately"},
        "questions": {"Why do you want to work here?":
                      "I admire the team's impact and want to learn."},
    })


def _text(label):
    return {"ref": "#x", "label": label, "type": "text", "is_select": False}


def _select(label, options):
    return {"ref": "#x", "label": label, "type": "select", "is_select": True,
            "options": options}


def _opt(label, type="radio"):
    return {"ref": "#x", "label": label, "type": type}


# ---- deterministic radio/checkbox handling ----------------------------------

def test_acknowledge_checkbox_is_checked():
    f = _opt("Please review and acknowledge the Privacy Policy "
             "— Acknowledge/Confirm", "checkbox")
    assert answer_for(f, _p()) == "Acknowledge/Confirm"


def test_degree_checkbox_group_matches_bachelor_only():
    yes = _opt("Degree Type — Undergraduate/Bachelors", "checkbox")
    no = _opt("Degree Type — Master's", "checkbox")
    assert answer_for(yes, _p()) == "Undergraduate/Bachelors"
    assert answer_for(no, _p()) is None


def test_work_auth_radio_picks_yes_not_no():
    q = "Are you authorized to work lawfully in the United States?"
    assert answer_for(_opt(f"{q} — Yes"), _p()) == "Yes"
    assert answer_for(_opt(f"{q} — No"), _p()) is None


def test_availability_day_checkboxes_select_all():
    for day in ("Monday", "Tuesday", "Thursday"):
        f = _opt(f"Which days can you work in-office? — {day}", "checkbox")
        assert answer_for(f, _p()) == day


def test_negative_screen_and_sponsorship_radios_are_deferred():
    assert answer_for(
        _opt("Have you ever been convicted of a felony? — Yes"), _p()) is None
    assert answer_for(
        _opt("Do you now or will you require sponsorship? — Yes"), _p()) is None


def test_how_heard_select_falls_back_to_a_choice():
    p = _p()
    p.referral.how_heard = "Company website"
    assert answer_for(_select(
        "How did you hear about this job?",
        ["Select...", "LinkedIn", "Company website", "Referral"]), p
    ) == "Company website"
    # no company-website option -> prefer "Other"
    assert answer_for(_select(
        "How did you hear about this role?",
        ["Select...", "Indeed", "Glassdoor", "Other"]), p) == "Other"
    # nothing preferred -> first real option (a required select must not be blank)
    assert answer_for(_select(
        "How did you hear about this role?",
        ["Select...", "Friend", "Newspaper"]), p) == "Friend"


def test_canonical_answers_renders_booleans_and_grad():
    a = canonical_answers(_p())
    assert a["authorized_us"] == "Yes"
    assert a["requires_sponsorship"] == "No"
    assert a["grad_date"] == "May 2027"
    assert a["preferred_name"] == "Alex"
    assert "current_salary" not in a


@pytest.mark.parametrize("label,expected", [
    ("Email Address", "alex@example.com"),
    ("Mobile phone", "(555) 010-4477"),
    ("LinkedIn Profile URL", "https://linkedin.com/in/alex-example"),
    ("First Name", "Alex"),
    ("Last Name", "Example"),
    ("City", "Atlanta"),
    ("Zip/Postal Code", "30332"),
    ("Street Address", "123 Tech Walk"),
    ("School / University", "Georgia Tech"),
    ("Major / Field of Study", "Computer Science"),
    ("GPA", "3.7"),
    ("Expected Graduation Date", "May 2027"),
    ("Desired Salary", "Open"),
    ("When can you start?", "Available immediately"),
])
def test_answer_for_text_fields(label, expected):
    assert answer_for(_text(label), _p()) == expected


def test_answer_for_unknown_label_returns_none():
    assert answer_for(_text("Favorite color"), _p()) is None


def test_work_auth_select_yes():
    f = _select("Are you legally authorized to work in the United States?", ["Yes", "No"])
    assert answer_for(f, _p()) == "Yes"


def test_sponsorship_select_no():
    f = _select("Will you now or in the future require visa sponsorship?", ["Yes", "No"])
    assert answer_for(f, _p()) == "No"


def test_gender_select_decline():
    f = _select("Gender", ["Male", "Female", "Decline To Self Identify"])
    assert answer_for(f, _p()) == "Decline To Self Identify"


def test_veteran_select_decline_phrasing():
    f = _select("Protected Veteran Status",
                ["I am a protected veteran", "I am not a protected veteran",
                 "I don't wish to answer"])
    assert answer_for(f, _p()) == "I don't wish to answer"


def test_how_heard_select():
    f = _select("How did you hear about us?",
                ["LinkedIn", "Company Website", "Job Board", "Referral"])
    assert answer_for(f, _p()) == "Company Website"


def test_relocate_select_yes():
    assert answer_for(_select("Are you willing to relocate?", ["Yes", "No"]), _p()) == "Yes"


def test_eighteen_select_yes():
    assert answer_for(_select("Are you at least 18 years of age?", ["Yes", "No"]), _p()) == "Yes"


def test_felony_select_no():
    q = _select("Have you ever been convicted of a felony?", ["Yes", "No"])
    assert answer_for(q, _p()) == "No"


def test_degree_select_token_overlap():
    f = _select("Highest level of education",
                ["High School", "Bachelor's Degree", "Master's Degree", "PhD"])
    assert answer_for(f, _p()) == "Bachelor's Degree"


def test_custom_question_from_bank():
    assert "admire" in answer_for(_text("Why do you want to work here?"), _p())


def test_match_option_boolean_and_decline():
    assert match_option("Yes", ["No", "Yes"]) == "Yes"
    assert match_option("No", ["Yes", "No"]) == "No"
    assert match_option("Decline to self-identify",
                        ["Male", "Prefer not to say"]) == "Prefer not to say"


def test_match_option_no_match_returns_none():
    assert match_option("Purple", ["Red", "Green"]) is None


def test_disability_select_i_do_not_want_to_answer():
    # Greenhouse's Disability Status phrases the non-answer as "I do not want to
    # answer" (no "decline"/"prefer not"). A canonical "Decline to self-identify"
    # must still land it instead of leaving the required select blank.
    opts = ["Yes, I have a disability, or have had one in the past",
            "No, I do not have a disability and have not had one in the past",
            "I do not want to answer"]
    assert match_option("Decline to self-identify", opts) == "I do not want to answer"
    f = _select("Disability Status", opts)
    assert answer_for(f, _p()) == "I do not want to answer"


def test_race_select_asian_matches_greenhouse_option():
    # The race select's "Asian ..." option must resolve from canonical "Asian" —
    # the reported "labels didn't match Asian lexically" was a misdiagnosis.
    opts = ["Hispanic or Latino", "White (Not Hispanic or Latino)",
            "Asian (Not Hispanic or Latino)", "Two or More Races",
            "Decline To Self Identify"]
    p = _p()
    p.eeo.race = "Asian"
    assert answer_for(_select("Please identify your race", opts), p) == \
        "Asian (Not Hispanic or Latino)"


# ---- FIX 2: rule order must not fill school name into non-school questions ----

def test_graduation_question_is_not_school_name():
    # A question sentence containing "graduate" must map to the grad date, not
    # the school name (the school rule used to win because it ran first).
    f = _text("When do you expect to graduate from your program?")
    assert answer_for(f, _p()) == "May 2027"


def test_degree_question_is_not_school_name():
    f = _text("What degree are you currently pursuing?")
    assert answer_for(f, _p()) == "Bachelor's"


def test_enrollment_boolean_is_not_school_name():
    # "...enrolled in a university, and will you return to studies..." contains
    # "university" but is a Yes/No enrollment question, not a school-name field.
    # The bank entry resolves it to "Yes"; the point of the fix is that the
    # school rule must NOT hijack it and return the school name.
    p = _p()
    p.questions["will you return to studies after the internship"] = "Yes"
    f = {"ref": "#x", "type": "boolean", "is_select": False,
         "options": ["Yes", "No"],
         "label": "Are you currently enrolled in a university, and will you "
                  "return to studies after the internship?"}
    assert answer_for(f, p) == "Yes"


def test_school_name_label_still_resolves():
    # The genuine school-name label (a short noun-phrase head) must still work.
    assert answer_for(_text("School / University"), _p()) == "Georgia Tech"
    assert answer_for(_text("University"), _p()) == "Georgia Tech"
    assert answer_for(_text("Name of your college"), _p()) == "Georgia Tech"


# ---- FIX 3: fuzzy bank matching must not fire on stopwords -------------------

def _p_with_bank() -> ApplyProfile:
    p = _p()
    p.questions.update({
        "What are your research interests?": "Systems and networking.",
        "Preferred internship duration": "Flexible (4-16 months)",
        "How long are you available to join?": "Flexible (4-16 months)",
    })
    return p


def test_fuzzy_does_not_match_on_filler_words():
    from src.apply.answers import _bank_fuzzy
    bank = _p_with_bank().answer_bank
    # {what, your} are stopwords -> no content overlap with research interests.
    assert _bank_fuzzy(
        "what is your top location preference?", bank) is None
    # {internship, duration} -> "internship" is domain-ubiquitous (stopword),
    # leaving only {duration} = 1 content token < 2 threshold.
    assert _bank_fuzzy(
        "do you live in greater austin metro area for the duration of this "
        "internship?", bank) is None


def test_fuzzy_still_matches_genuine_duration_question():
    # The strong (substring) path covers the canonical phrasing "How long are
    # you available to join?" inside a slightly longer live label.
    p = _p_with_bank()
    assert "Flexible" in answer_for(
        _text("How long are you available to join us?"), p)


# ---- FIX 5: Ashby boolean (Yes/No button pair) resolves via the answer book --

def _boolean(label):
    return {"ref": "#x", "type": "boolean", "is_select": False,
            "options": ["Yes", "No"], "label": label}


def test_boolean_canada_eligibility_maps_to_no():
    # authorized_canada is False for this profile -> MUST be "No".
    p = _p()
    p.work_authorization.authorized_canada = False
    assert answer_for(
        _boolean("Are you legally eligible to work in Canada?"), p) == "No"


def test_boolean_us_authorization_maps_to_yes():
    assert answer_for(
        _boolean("Are you authorized to work in the United States?"),
        _p()) == "Yes"


# ---- FIX 6: F-1 / split end-date education fields ----------------------------

def test_f1_student_question_is_no():
    p = _p()
    p.questions["Are you an F-1 student?"] = "No"
    assert answer_for(
        _select("Are you an F-1 student?", ["Yes", "No"]), p) == "No"


def test_split_end_date_month_and_year():
    months = ["January", "February", "March", "April", "May", "June"]
    years = ["2025", "2026", "2027", "2028"]
    assert answer_for(_select("End date month", months), _p()) == "May"
    assert answer_for(_select("End date year", years), _p()) == "2027"


# ---- S1: education START-date month/year must NOT inherit employment start ----

def test_education_start_date_month_year_left_blank():
    # Greenhouse education blocks carry a school-attendance START date ("Start
    # date month" / "Start date year") the profile has no data for. These must
    # resolve to nothing (blank) — NOT fall through to the generic start-date
    # rule and get the employment start_date ("Available immediately"), which in
    # the live sweep landed nowhere only because month/year widgets reject text.
    for lbl in ("Start date month", "Start date year",
                "Start date month *", "Start date year *"):
        assert answer_for(_text(lbl), _p()) is None
    months = ["January", "February", "March", "April", "May", "June"]
    years = ["2023", "2024", "2025", "2026"]
    assert answer_for(_select("Start date month", months), _p()) is None
    assert answer_for(_select("Start date year", years), _p()) is None


def test_education_start_date_noop_does_not_fall_to_fuzzy_bank():
    # A matched no-op key must short-circuit — never leak into fuzzy bank
    # matching and pick up an unrelated custom answer.
    p = _p()
    p.questions["What month did you start?"] = "September"
    assert answer_for(_text("Start date month"), p) is None


def test_employment_start_date_and_availability_still_answered():
    # The generic start-date / availability questions must keep resolving to the
    # employment start_date — the new education rule must not swallow them.
    for lbl in ("When can you start?", "Start date", "Availability",
                "Earliest start date", "What is your availability to start?",
                "Date available"):
        assert answer_for(_text(lbl), _p()) == "Available immediately"
