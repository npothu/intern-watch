import { describe, expect, test } from "vitest";
import vectors from "../shared/term-inference-cases.json";
import { inferTerm, inferTermDetailed } from "./ingest_extract";

// The same vectors drive tests/test_normalize.py: the watcher (Python) and
// the hosted ingest (this file's subject) must infer identical terms.
type Case = {
  name: string; title: string; url?: string; jd?: string; today: string;
  terms: string[]; confidence: string; source: string | null;
};

describe("inferTermDetailed: shared vectors", () => {
  test.each((vectors.cases as Case[]).map((c) => [c.name, c] as const))("%s", (_, c) => {
    const got = inferTermDetailed({ title: c.title, url: c.url, jd: c.jd, today: c.today });
    expect(got.terms).toEqual(c.terms);
    expect(got.confidence).toBe(c.confidence);
    expect(got.source).toBe(c.source);
    expect(got.term).toBe(c.terms[0] ?? "");
  });
});

describe("inferTerm", () => {
  test("returns the earliest term, or empty", () => {
    expect(inferTerm("Intern (Spring 2027 & Fall 2026)")).toBe("Fall 2026");
    expect(inferTerm("Software Engineer Intern", undefined, "Dates: May-August 2027.", "2026-11-08")).toBe("Summer 2027");
    expect(inferTerm("Software Engineer Intern")).toBe("");
  });
});
