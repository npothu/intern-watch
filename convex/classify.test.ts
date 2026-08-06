import { describe, expect, test } from "vitest";
import replyVectors from "../tests/data/reply_vectors.json";
import {
  classifyReply,
  decideTransition,
  normCompany,
  normTitle,
  scoreCandidates,
  stripHtml,
} from "./classify";

// Phase 3a: pure classifier port + cross-language parity fixture.
//
// The same tests/data/reply_vectors.json sweep drives the Python reference
// implementation in tests/test_reply_vectors.py and this TypeScript port.
// Keeping both green proves the two runtimes agree on every vector.

type Vector = {
  subject: string;
  body: string;
  html?: boolean;
  expect: string | null;
};
const VECTORS = replyVectors as Vector[];

describe("classifyReply parity sweep vs tests/data/reply_vectors.json", () => {
  test.each(VECTORS.map((v, i) => [i, v] as const))(
    "vector %i: %j",
    (_i, v: Vector) => {
      const body = v.html ? stripHtml(v.body) : v.body;
      const result = classifyReply(v.subject, body);
      expect(result ? result.signal : null).toBe(v.expect);
    },
  );
});

describe("stripHtml", () => {
  test("unescapes named + numeric + hex entities and strips tags", () => {
    expect(stripHtml("a &amp; b &lt;tag&gt; &#65; &#x42;")).toBe("a & b A B");
  });
});

describe("normCompany (verified against src/normalize.py)", () => {
  test("strips punctuation and corporate suffix", () => {
    expect(normCompany("Acme, Inc.")).toBe("acme");
  });
  test("pops multi-word trailing corporate suffixes", () => {
    expect(normCompany("The Walt Disney Company")).toBe("the walt disney");
  });
  test("expands & and handles LLC suffix", () => {
    expect(normCompany("AT&T Services LLC")).toBe("at and t services");
  });
  test("single token stays", () => {
    expect(normCompany("Google")).toBe("google");
  });
});

describe("normTitle (verified against src/normalize.py)", () => {
  test("drops season/year term tokens and punctuation", () => {
    expect(normTitle("Developer Intern, Open Source- Fall 2026")).toBe(
      "developer intern open source",
    );
  });
});

describe("scoreCandidates", () => {
  const apps = [
    { short: "aaa000000001", company: "Acme, Inc.", title: "SWE Intern", url: "https://careers.acme.com/jobs/1" },
    { short: "bbb000000002", company: "Beta Corp", title: "SWE Intern", url: "https://beta.jobs/jobs/1" },
  ];

  test("sender-domain hit beats a subject mention", () => {
    const email = {
      fromAddr: "hiring@acme.com",
      fromName: "Acme Talent Acquisition",
      subject: "Acme Beta SWE Intern",
      body: "Beta is hiring",
    };
    const res = scoreCandidates(email, apps);
    expect(res.length).toBe(2);
    expect(res[0].short).toBe("aaa000000001");
    expect(res[0].score).toBeGreaterThan(res[1].score);
  });

  test("generic ATS sender domain uses fromName for the +3 rule", () => {
    const email = {
      fromAddr: "no-reply@greenhouse.io",
      fromName: "Acme Talent Acquisition",
      subject: "Application update",
      body: "hi",
    };
    const res = scoreCandidates(email, [
      { ...apps[0] },
    ]);
    expect(res).toHaveLength(1);
    expect(res[0].short).toBe("aaa000000001");
    // +3 from the fromName brand word matching the company; no other scoring.
    expect(res[0].score).toBe(3);
  });

  test("caps results at 5", () => {
    const email = {
      fromAddr: "hiring@acme.com",
      fromName: "Acme",
      subject: "Acme update",
      body: "hi",
    };
    const many = Array.from({ length: 7 }, (_, i) => ({
      short: `s${String(i).padStart(12, "0")}`,
      company: `Acme Unit ${i}`,
      title: `Role ${i}`,
      url: `https://acme.com/careers/${i}`,
    }));
    const res = scoreCandidates(email, many);
    expect(res.length).toBe(5);
  });

  test("empty on no hits", () => {
    const email = {
      fromAddr: "mailer@newsletter.example.com",
      fromName: "News",
      subject: "Weekly digest",
      body: "Resume tips and cover letters.",
    };
    const res = scoreCandidates(email, apps);
    expect(res).toEqual([]);
  });

  test("ATS subdomain sender is still recognized as the platform", () => {
    // Sender domain mail.myworkday.com is not in the deny-list verbatim, but
    // its registrable base is; without base matching, "myworkday.com" would
    // +3-match EVERY application hosted on Workday.
    const email = {
      fromAddr: "notifications@mail.myworkday.com",
      fromName: "NVIDIA University Recruiting",
      subject: "Application update",
      body: "hi",
    };
    const wd = [
      { short: "n0000000001", company: "NVIDIA", title: "SWE Intern",
        url: "https://nvidia.wd5.myworkdayjobs.com/jobs/1" },
      { short: "d0000000002", company: "Datadog", title: "SWE Intern",
        url: "https://datadog.wd1.myworkdayjobs.com/jobs/2" },
    ];
    const res = scoreCandidates(email, wd);
    expect(res).toHaveLength(1);
    expect(res[0].short).toBe("n0000000001");
    expect(res[0].score).toBe(3);
  });

  test("sender domain must be the host or a parent of it, never a substring", () => {
    const email = {
      fromAddr: "hiring@acme.com",
      fromName: "Acme",
      subject: "update",
      body: "hi",
    };
    const res = scoreCandidates(email, [
      { short: "x0000000001", company: "Notacme", title: "SWE Intern",
        url: "https://notacme.com/jobs/1" },
      { short: "y0000000002", company: "Acme Robotics", title: "SWE Intern",
        url: "https://jobs.acme.com/jobs/2" },
    ]);
    expect(res).toHaveLength(1);
    expect(res[0].short).toBe("y0000000002");
  });

  test("punctuated company names phrase-match via the normalized haystack", () => {
    // normCompany("AT&T Services LLC") is "at and t services", which can only
    // appear in a subject that went through the same normalization.
    const email = {
      fromAddr: "no-reply@example-mailer.com",
      fromName: "Recruiting",
      subject: "Your AT&T Services application",
      body: "hi",
    };
    const res = scoreCandidates(email, [
      { short: "t0000000001", company: "AT&T Services LLC",
        title: "Network Intern", url: "https://att.jobs/1" },
    ]);
    expect(res).toHaveLength(1);
    expect(res[0].score).toBeGreaterThanOrEqual(2);
  });
});

describe("decideTransition", () => {
  test("null/undefined/empty current applies", () => {
    expect(decideTransition(null, "rejected")).toBe("apply");
    expect(decideTransition(undefined, "oa")).toBe("apply");
    expect(decideTransition("", "interview")).toBe("apply");
  });
  test("forward transitions apply", () => {
    expect(decideTransition("oa", "interview")).toBe("apply");
    expect(decideTransition("applied", "oa")).toBe("apply");
    expect(decideTransition("phone_screen", "interview")).toBe("apply");
  });
  test("backward transitions queue", () => {
    expect(decideTransition("interview", "oa")).toBe("queue");
    expect(decideTransition("offer", "oa")).toBe("queue");
  });
  test("rejected from any non-terminal applies", () => {
    expect(decideTransition("oa", "rejected")).toBe("apply");
    expect(decideTransition("interview", "rejected")).toBe("apply");
  });
  test("terminal current always queues", () => {
    expect(decideTransition("offer", "rejected")).toBe("queue");
    expect(decideTransition("rejected", "oa")).toBe("queue");
    expect(decideTransition("rejected", "interview")).toBe("queue");
  });
  test("same status skips", () => {
    expect(decideTransition("oa", "oa")).toBe("skip");
    expect(decideTransition("applied", "applied")).toBe("skip");
    expect(decideTransition("offer", "offer")).toBe("skip");
  });
  test("proposed applied is never forward", () => {
    expect(decideTransition("oa", "applied")).toBe("queue");
  });
});
