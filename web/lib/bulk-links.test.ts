import { describe, expect, test } from "vitest";
import { boardYamlRow, gapMessage, MAX_BULK_LINKS, parseLinks } from "./bulk-links";

describe("parseLinks", () => {
  test("splits on newlines and spaces, trims punctuation, dedupes", () => {
    const text = `apply here: https://jobs.lever.co/acme/1, and
https://jobs.lever.co/acme/1/ (same)
https://job-boards.greenhouse.io/beta/jobs/2.
https://job-boards.greenhouse.io/beta/jobs/2#apply  ftp://nope.example/x`;
    expect(parseLinks(text)).toEqual([
      "https://jobs.lever.co/acme/1",
      "https://job-boards.greenhouse.io/beta/jobs/2",
    ]);
  });
  test("keeps query-distinct links apart", () => {
    expect(parseLinks("https://a.example/j?id=1 https://a.example/j?id=2")).toHaveLength(2);
  });
  test("cap is a sane number", () => {
    expect(MAX_BULK_LINKS).toBeGreaterThan(1);
  });
});

describe("gap hints", () => {
  test("only an explicitly unwatched board yields a message", () => {
    const gh = { ats: "greenhouse", atsBoard: "acme", atsSupported: true };
    expect(gapMessage({ ...gh, boardWatched: false })).toBe("Greenhouse board “acme” isn’t watched.");
    expect(gapMessage({ ...gh, boardWatched: true })).toBeNull();
    expect(gapMessage(gh)).toBeNull();
  });
  test("an ATS without an adapter gets no yaml row", () => {
    const wd = { ats: "workday", atsBoard: "acme/wd5/Ext", boardWatched: false, atsSupported: false };
    expect(gapMessage(wd)).toBe("Workday has no adapter yet. It’s counted in the weekly coverage-gaps issue.");
    expect(boardYamlRow(wd)).toBeNull();
    expect(boardYamlRow({ ...wd, atsSupported: undefined })).toBeNull();
  });
  test("yaml row", () => {
    expect(boardYamlRow({ ats: "ashby", atsBoard: "acme", atsSupported: true }, "Acme")).toBe(
      '- company: "Acme"\n  ats: ashby\n  slug: "acme"\n');
    expect(boardYamlRow({ ats: "ashby", atsSupported: true })).toBeNull();
  });
});
