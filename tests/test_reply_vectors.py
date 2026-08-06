"""Cross-language parity sweep of classify_reply against the shared JSON fixture.

``tests/data/reply_vectors.json`` is the single source of truth that keeps the
Python reference implementation (src/apply/inbox.py) and the TypeScript port
(convex/classify.ts) provably in lockstep. Each vector feeds the same
classify_reply (with strip_html applied first when ``html`` is set) and must
yield exactly its ``expect`` signal (None for null). vitest runs the identical
sweep through the TS port."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from src.apply.inbox import classify_reply
from src.normalize import strip_html

_VECTORS = json.loads(
    (Path(__file__).parent / "data" / "reply_vectors.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("vector", _VECTORS, ids=lambda v: v["subject"] or "(empty)")
def test_classify_reply_matches_shared_fixture(vector):
    body = strip_html(vector["body"]) if vector.get("html") else vector["body"]
    result = classify_reply(vector["subject"], body)
    got = result[0] if result else None
    assert got == vector["expect"], (
        f"subject={vector['subject']!r} body={body[:80]!r} "
        f"expected={vector['expect']!r} got={got!r}"
    )
