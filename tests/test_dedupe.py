from src.dedupe import dedup_key, dedupe
from src.models import Job


def _job(**kw):
    base = {"company": "Acme", "title": "SWE Intern", "url": "https://acme.com/j/1",
            "source": "jobright-swe"}
    base.update(kw)
    return Job(**base)


def test_jobright_id_beats_url():
    a = _job(jobright_id="6a0b2c8c538d03366dc8273a",
             url="https://jobright.ai/jobs/info/6a0b2c8c538d03366dc8273a")
    b = _job(jobright_id="6a0b2c8c538d03366dc8273a",
             url="https://acme.com/careers/1?jr_id=6a0b2c8c538d03366dc8273a",
             source="vanshb03-2027", terms=["Summer 2027"], term_confidence="explicit")
    merged = dedupe([a, b])
    assert len(merged) == 1
    m = merged[0]
    assert m.dedup_key == "jr:6a0b2c8c538d03366dc8273a"
    assert m.sources == ["jobright-swe", "vanshb03-2027"]
    assert m.terms == ["Summer 2027"]          # explicit-term record preferred


def test_url_key_ignores_tracking():
    a = _job(url="https://acme.com/j/1?utm_source=git")
    b = _job(url="https://acme.com/j/1/", source="speedyapply", salary="$50/hr")
    merged = dedupe([a, b])
    assert len(merged) == 1
    assert merged[0].salary == "$50/hr"        # merged fields union


def test_distinct_jobs_stay_distinct():
    a = _job(url="https://acme.com/j/1")
    b = _job(url="https://acme.com/j/2")
    assert len(dedupe([a, b])) == 2


def test_hash_fallback_when_no_url():
    a = _job(url="", terms=["Fall 2026"])
    b = _job(url="", terms=["Fall 2026"], source="speedyapply")
    k1, k2 = dedup_key(a), dedup_key(b)
    assert k1 == k2 and k1.startswith("hash:")


def test_locations_union():
    a = _job(locations=["Atlanta, GA"])
    b = _job(locations=["atlanta, ga", "NYC"], source="speedyapply")
    merged = dedupe([a, b])[0]
    assert merged.locations == ["Atlanta, GA", "NYC"]
