import { describe, expect, test } from "vitest";
import {
  atsApiUrl,
  stripJdHtml,
  jdFromAtsPayload,
  embeddedDescription,
  looksLikeJd,
  acquireJdFromUrl,
  JD_MIN_CHARS,
} from "./jd_acquire";

// Pure tests for the shared JD-acquisition chain. Mirror of the Python
// tests in tests/test_jd_source_ats.py - keep in lockstep.

const FILLER = "Responsibilities: build things and own outcomes. ".repeat(10);

describe("atsApiUrl resolution", () => {
  const cases: [string, string | null][] = [
    ["https://boards.greenhouse.io/stripe/jobs/123456", "greenhouse"],
    ["https://job-boards.greenhouse.io/datadog/jobs/98765?gh_src=x", "greenhouse"],
    ["https://jobs.lever.co/palantir/11111111-2222-3333-4444-555555555555", "lever"],
    ["https://jobs.ashbyhq.com/ramp/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "ashby:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
    ["https://jobs.smartrecruiters.com/Visa/744000012345-software-intern", "smartrecruiters"],
    ["https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA/Intern_JR123", "workday"],
    ["https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA/Intern_JR123", "workday"],
    ["https://apply.workable.com/acme/j/AB12CD34EF", "workable"],
    ["https://example.com/careers/123", null],
    ["not a url", null],
  ];
  for (const [url, kind] of cases) {
    test(`${url.slice(0, 60)} -> ${kind}`, () => {
      const got = atsApiUrl(url);
      if (kind === null) expect(got).toBeNull();
      else expect(got?.kind).toBe(kind);
    });
  }

  test("workday CXS endpoint drops the locale segment", () => {
    const got = atsApiUrl(
      "https://nvidia.wd5.myworkdayjobs.com/en-US/Site/job/US-CA/Intern_JR123",
    );
    expect(got?.api).toBe(
      "https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/Site/job/US-CA/Intern_JR123",
    );
  });
});

describe("jdFromAtsPayload extraction", () => {
  test("greenhouse content html", () => {
    expect(
      jdFromAtsPayload("greenhouse", { content: `<p>${FILLER}</p>` }),
    ).toContain("Responsibilities");
  });
  test("lever description + lists", () => {
    const got = jdFromAtsPayload("lever", {
      descriptionPlain: FILLER,
      lists: [{ text: "Requirements", content: "<li>Python</li><li>SQL</li>" }],
    });
    expect(got).toContain("Requirements");
    expect(got).toContain("Python");
  });
  test("ashby board keyed by posting id", () => {
    const got = jdFromAtsPayload("ashby:abc", {
      jobs: [
        { id: "zzz", descriptionHtml: "<p>wrong</p>" },
        { id: "ABC", descriptionHtml: `<p>${FILLER}</p>` },
      ],
    });
    expect(got).toContain("Responsibilities");
  });
  test("smartrecruiters jobAd sections", () => {
    const got = jdFromAtsPayload("smartrecruiters", {
      jobAd: { sections: { jobDescription: { title: "About", text: `<p>${FILLER}</p>` } } },
    });
    expect(got).toContain("About");
  });
  test("workday jobPostingInfo", () => {
    expect(
      jdFromAtsPayload("workday", { jobPostingInfo: { jobDescription: `<p>${FILLER}</p>` } }),
    ).toContain("Responsibilities");
  });
  test("workable description + requirements", () => {
    const got = jdFromAtsPayload("workable", {
      description: `<p>${FILLER}</p>`,
      requirements: "<li>Go</li>",
    });
    expect(got).toContain("Go");
  });
  test("too-short content is a miss", () => {
    expect(jdFromAtsPayload("greenhouse", { content: "<p>short</p>" })).toBeNull();
  });
});

describe("acquireJdFromUrl chain", () => {
  test("ATS API wins without fetching the page", async () => {
    const calls: string[] = [];
    const got = await acquireJdFromUrl(
      "https://boards.greenhouse.io/acme/jobs/42",
      async (u) => {
        calls.push(u);
        return JSON.stringify({ content: `<p>${FILLER}</p>` });
      },
    );
    expect(got.source).toBe("ats:greenhouse");
    expect(calls).toEqual(["https://boards-api.greenhouse.io/v1/boards/acme/jobs/42"]);
  });

  test("falls back to embedded description, then exposes html on miss", async () => {
    const page = `<html><script type="application/ld+json">{"description":"${FILLER}"}</script></html>`;
    const hit = await acquireJdFromUrl("https://example.com/j/1", async () => page);
    expect(hit.source).toBe("embedded");

    const shell = `<html><body>${'{"a":1} => function ( var x const y window.self '.repeat(12)}</body></html>`;
    const miss = await acquireJdFromUrl("https://example.com/j/2", async () => shell);
    expect(miss.text).toBeNull();
    expect(miss.html).toBe(shell);
  });
});

describe("looksLikeJd guard", () => {
  test("JD markers pass, JS debris fails", () => {
    expect(looksLikeJd("Minimum qualifications: a degree in CS")).toBe(true);
    expect(looksLikeJd('var a = {"b":1}; function (x) => window.self const '.repeat(20))).toBe(false);
  });
});

describe("stripJdHtml fidelity", () => {
  test("entity-escaped Greenhouse content decodes before tag stripping", () => {
    const escaped = "&lt;p&gt;Minimum qualifications: a degree in CS and Go experience.&lt;/p&gt;";
    const got = stripJdHtml(escaped);
    expect(got).not.toContain("<p>");
    expect(got).toContain("Minimum qualifications");
  });
  test("double-escaped payloads decode fully", () => {
    expect(stripJdHtml("&amp;lt;li&amp;gt;Python&amp;lt;/li&amp;gt;")).toBe("- Python");
  });
  test("svg content is dropped, not stripped into coordinate soup", () => {
    const html = "<p>Real JD text here.</p><svg viewBox=\"0 0 32 32\"><path d=\"M2 21.3 5.1 21.4 9.46 21.78\"/></svg>";
    const got = stripJdHtml(html);
    expect(got).toContain("Real JD text");
    expect(got).not.toContain("21.78");
  });
});

describe("stripJdHtml on truncated pages", () => {
  test("unclosed svg and dangling tags do not leak attribute soup", () => {
    const truncated =
      '<p>Real JD text here.</p><svg viewBox="0 0 32 32"><path d="M2 21.3056C5.24982 21.4185 7.138';
    const got = stripJdHtml(truncated);
    expect(got).toContain("Real JD text");
    expect(got).not.toContain("21.3056");
  });
});

describe("stripJdHtml on script-truncated pages", () => {
  test("an unclosed script's payload does not leak", () => {
    const truncated =
      '<p>Real JD text here.</p><script>self.__next_f.push([1,"M28 4C29.1046 4 30 4.89542 30 5.99999V21.3056C30 22.28';
    const got = stripJdHtml(truncated);
    expect(got).toContain("Real JD text");
    expect(got).not.toContain("21.3056");
  });
});
