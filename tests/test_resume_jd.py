"""JD keyword extraction: lexicon matching + requirements weighting."""

from src.resume import jd

ML_JD = "tests/fixtures/jd_ml_intern.txt"


def _read(fixtures, name):
    return (fixtures / name).read_text(encoding="utf-8")


def test_ml_jd_finds_core_skills(fixtures):
    prof = jd.analyze(_read(fixtures, "jd_ml_intern.txt"))
    for skill in ("python", "machine learning", "pytorch", "pandas", "sql",
                  "data pipelines", "docker"):
        assert skill in prof.weights, skill


def test_requirements_block_weighs_heavier(fixtures):
    prof = jd.analyze(_read(fixtures, "jd_ml_intern.txt"))
    # python appears in the minimum-qualifications block -> boosted above
    # data pipelines, which is only mentioned in the prose duties list
    assert prof.weights["python"] > prof.weights["data pipelines"]


def test_java_does_not_match_javascript():
    prof = jd.analyze("We use JavaScript everywhere.")
    assert "java" not in prof.weights
    assert "javascript" in prof.weights


def test_c_does_not_match_inside_words():
    prof = jd.analyze("Welcome to our company culture of customer care.")
    assert "c" not in prof.weights
    assert "c++" not in jd.analyze("plain text with no languages").weights


def test_c_and_cpp_match_when_present():
    prof = jd.analyze("Required: strong C and C++ skills, RTOS experience.")
    assert "c" in prof.weights
    assert "c++" in prof.weights
    assert "real-time" in prof.weights


def test_mentions_saturate():
    spam = "python " * 50
    prof = jd.analyze(spam)
    assert prof.weights["python"] <= jd.MENTION_CAP * (1 + jd.REQ_WEIGHT)


def test_ranked_is_deterministic(fixtures):
    text = _read(fixtures, "jd_backend_intern.txt")
    assert jd.analyze(text).ranked() == jd.analyze(text).ranked()
