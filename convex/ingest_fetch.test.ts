// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BROWSER_HEADERS, FetchError, fetchWithLimits, resolveIngest } from "./ingest_node";
import { atsApiUrl } from "./jd_acquire";

// Fetch robustness for manual ingests (scrape issue #1): Avature's empty 202,
// a browser-like identity, one retry, and the manual-JD escape hatch.

const fixture = (name: string) =>
  readFileSync(new URL(`../tests/fixtures/jd/${name}`, import.meta.url), "utf8");

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const AVATURE_202 = () => new Response("", { status: 202, headers: { "x-amzn-waf-action": "challenge" } });

describe("fetchWithLimits", () => {
  test("Avature's empty 202 is a blocked failure, retried once, with a browser UA", async () => {
    const fn = stubFetch(AVATURE_202);
    const err = await fetchWithLimits("https://careers.example.com/en_US/careers/JobDetail?jobId=137214").catch((e) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect(err.code).toBe("blocked");
    expect(err.message).toMatch(/HTTP 202/);
    expect(fn).toHaveBeenCalledTimes(2);
    const headers = fn.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe("Mozilla/5.0 (compatible; intern-baddie/1.0)");
    expect(headers).toEqual(BROWSER_HEADERS);
  });

  test("a 202 with a challenge body is still blocked", async () => {
    stubFetch(() => new Response("<html><script>challenge()</script></html>", { status: 202 }));
    await expect(fetchWithLimits("https://example.com/job/1")).rejects.toMatchObject({ code: "blocked" });
  });

  test("a transient 503 is retried and can succeed", async () => {
    let n = 0;
    const fn = stubFetch(() => (++n === 1 ? new Response("busy", { status: 503 }) : new Response("<html>ok</html>")));
    expect(await fetchWithLimits("https://example.com/job/1")).toBe("<html>ok</html>");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  test("a WAF captcha on another status is blocked, not retried", async () => {
    const fn = stubFetch(() => new Response("captcha", { status: 405, headers: { "x-amzn-waf-action": "captcha" } }));
    await expect(fetchWithLimits("https://acme.icims.com/jobs/1/job?in_iframe=1")).rejects.toMatchObject({
      code: "blocked", message: expect.stringMatching(/bot check \(HTTP 405, captcha\)/),
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("a closed posting (410) fails at once, without a retry", async () => {
    const fn = stubFetch(() => new Response("gone", { status: 410 }));
    await expect(fetchWithLimits("https://example.com/job/1")).rejects.toMatchObject({
      code: "fetch_failed", message: expect.stringMatching(/HTTP 410 - the posting may be closed/),
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("resolveIngest", () => {
  const blocked = async () => { throw new FetchError("blocked", "empty response (HTTP 202) - this page likely renders with JavaScript or blocks automated fetches"); };

  test("a bot-walled page with no ATS API fails with a hint, never a placeholder", async () => {
    await expect(resolveIngest("https://careers.example.com/en_US/careers/JobDetail?jobId=137214", {}, blocked))
      .rejects.toMatchObject({ code: "blocked", message: expect.stringMatching(/HTTP 202.*paste the job description and title/) });
  });

  test("a bot-walled page plus a caller-supplied JD and title becomes a match", async () => {
    const jdText = "Responsibilities: build things. ".repeat(10);
    const got = await resolveIngest("https://careers.example.com/en_US/careers/JobDetail?jobId=137214",
      { jdText, title: "Software Engineer Intern", company: "Example" }, blocked);
    expect(got).toEqual({
      company: "Example", title: "Software Engineer Intern", location: "", jobDescription: jdText.trim(), jdIsManual: true,
    });
  });

  test("a JD without a title, on a page that gives none, asks for the title", async () => {
    await expect(resolveIngest("https://careers.example.com/job/1", { jdText: "x".repeat(300) }, blocked))
      .rejects.toThrow(/pass `title`/);
  });

  test("Oracle CX: the REST feed names the role; the shell's <title> is the employer", async () => {
    const url = "https://ehtl.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/19813";
    const routes: Record<string, string> = {
      [url]: "<html><head><title>Resideo</title></head><body><div id=app></div></body></html>",
      [atsApiUrl(url)!.api]: fixture("oracle_cx_detail.json"),
    };
    const got = await resolveIngest(url, {}, async (u) => {
      if (u in routes) return routes[u];
      throw new FetchError("fetch_failed", "fetch failed: HTTP 404");
    });
    expect(got).toMatchObject({
      company: "Resideo", title: "Firmware Engineering Intern - Summer 2027", location: "Aurora, IL, United States", jdIsManual: false,
    });
    expect(got.jobDescription).toContain("Firmware");
  });

  test("iCIMS: title, company and JD come from the iframe page", async () => {
    const url = "https://campus-americas.icims.com/jobs/26272/data-engineer-intern%2c-2027-summer-u.s./job";
    const got = await resolveIngest(url, {}, async (u) => {
      if (u === `${url}?in_iframe=1`) return fixture("icims_iframe.html");
      throw new FetchError("fetch_failed", "unexpected " + u);
    });
    expect(got).toMatchObject({ company: "Atlassian", title: "Data Engineer Intern, 2027 Summer U.S." });
    expect(got.jobDescription).toContain("Atlassian");
  });
});
