// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  acquireJdFromUrl,
  atsApiUrl,
  jdFromAtsPayload,
  metaFromAtsPayload,
  oracleApiFromPage,
  oracleApiUrl,
  pageFetchUrl,
  phenomJob,
} from "./jd_acquire";

// JD adapters for the JS-rendered boards (Oracle CX, Eightfold, Apple,
// iCIMS, Phenom) against payloads recorded from each employer's own public
// career-page endpoint (tests/fixtures/jd, shared with the Python twin in
// tests/test_jd_source_adapters.py - keep the two in lockstep).

const fixture = (name: string) =>
  readFileSync(new URL(`../tests/fixtures/jd/${name}`, import.meta.url), "utf8");
const json = (name: string) => JSON.parse(fixture(name));

/** An injected fetch that serves fixtures by exact URL and 404s the rest. */
function fakeFetch(routes: Record<string, string>) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    if (url in routes) return routes[url];
    throw new Error(`fetch failed: HTTP 404 (${url})`);
  };
  return { fn, calls };
}

describe("atsApiUrl: JS-rendered boards", () => {
  test("Oracle CX with a site number", () => {
    expect(atsApiUrl("https://ehtl.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/19813")).toEqual({
      kind: "oracle",
      api: "https://ehtl.fa.us6.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails"
        + "?expand=all&onlyData=true&finder=ById;Id=%2219813%22,siteNumber=CX",
    });
  });
  test("Oracle CX without a site, and the ocs pod shape", () => {
    expect(atsApiUrl("https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/job/334345/")?.api)
      .toMatch(/\/hcmRestApi\/.*finder=ById;Id=%22334345%22$/);
    expect(atsApiUrl("https://fa-essf-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/10005930")?.kind)
      .toBe("oracle");
  });
  test("an Oracle listing page is not a posting", () => {
    expect(atsApiUrl("https://ehtl.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/jobs?keyword=intern")).toBeNull();
  });
  test("the doc's working Oracle feed URL shape", () => {
    expect(oracleApiUrl("pod.fa.dc.oraclecloud.com", "CX_1", "123"))
      .toBe('https://pod.fa.dc.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id="123",siteNumber=CX_1'.replace(/"/g, "%22"));
  });
  test("Eightfold: Microsoft, /careers/job/<id> and ?pid=", () => {
    expect(atsApiUrl("https://apply.careers.microsoft.com/careers/job/1970393556972687")).toEqual({
      kind: "eightfold", api: "https://apply.careers.microsoft.com/api/apply/v2/jobs/1970393556972687", company: "Microsoft",
    });
    expect(atsApiUrl("https://acme.eightfold.ai/careers?pid=563808972035923")?.api)
      .toBe("https://acme.eightfold.ai/api/apply/v2/jobs/563808972035923");
    expect(atsApiUrl("https://acme.eightfold.ai/careers?query=intern")).toBeNull();
  });
  test("Apple details URL, with and without a slug", () => {
    expect(atsApiUrl("https://jobs.apple.com/en-us/details/200676912-3715/software-engineering-intern")?.api)
      .toBe("https://jobs.apple.com/api/v1/jobDetails/200676912-3715");
    expect(atsApiUrl("https://jobs.apple.com/en-us/details/200689488")?.kind).toBe("apple");
    expect(atsApiUrl("https://jobs.apple.com/en-us/search?search=intern")).toBeNull();
  });
});

describe("JD + metadata from recorded payloads", () => {
  test("Oracle CX requisition detail", () => {
    const p = json("oracle_cx_detail.json");
    const text = jdFromAtsPayload("oracle", p);
    expect(text).toContain("Firmware");
    expect(text).not.toMatch(/<[a-z]/i);
    expect(metaFromAtsPayload("oracle", p)).toEqual({
      title: "Firmware Engineering Intern - Summer 2027", location: "Aurora, IL, United States",
    });
  });
  test("Oracle CX empty feed (closed posting or wrong site) is a miss", () => {
    expect(jdFromAtsPayload("oracle", json("oracle_cx_empty.json"))).toBeNull();
    expect(metaFromAtsPayload("oracle", json("oracle_cx_empty.json"))).toBeNull();
  });
  test("Eightfold job", () => {
    const p = json("eightfold_job.json");
    expect(jdFromAtsPayload("eightfold", p)).toContain("Microsoft");
    expect(metaFromAtsPayload("eightfold", p)).toMatchObject({
      title: expect.stringContaining("Software Engineer"), location: "United States, California, Mountain View",
    });
  });
  test("Apple job details", () => {
    const p = json("apple_job.json");
    const text = jdFromAtsPayload("apple", p)!;
    expect(text).toContain("Minimum Qualifications");
    expect(text).toContain("Preferred Qualifications");
    expect(metaFromAtsPayload("apple", p)).toEqual({
      title: "Software Engineering Intern – AI Tools for Hardware Engineering", company: "Apple", location: "Shanghai",
    });
  });
  test("Phenom phApp.ddo", () => {
    const got = phenomJob(fixture("phenom_job.html"))!;
    expect(got.text).toContain("Splunk");
    expect(got.meta).toEqual({
      title: "Splunk Solutions Engineer (Intern) - United States",
      company: "Cisco",
      location: "Research Triangle Park, North Carolina, United States of America",
    });
  });
});

describe("acquireJdFromUrl through the new tiers", () => {
  test("Oracle: the REST feed wins and carries the title", async () => {
    const url = "https://ehtl.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/job/19813";
    const { fn, calls } = fakeFetch({ [atsApiUrl(url)!.api]: fixture("oracle_cx_detail.json") });
    const got = await acquireJdFromUrl(url, fn);
    expect(got.source).toBe("ats:oracle");
    expect(got.meta?.title).toBe("Firmware Engineering Intern - Summer 2027");
    expect(calls).toHaveLength(1); // the JS shell page is never needed
  });
  test("Oracle on a custom domain: the page names the pod", async () => {
    const url = "https://careers.example.com/en/sites/CX_1/job/26011082";
    const page = fixture("oracle_custom_domain_page.html");
    const hinted = oracleApiFromPage(url, page)!;
    expect(hinted.api).toBe(oracleApiUrl("egug.fa.us2.oraclecloud.com", "CX_1", "26011082"));
    const { fn } = fakeFetch({ [url]: page, [hinted.api]: fixture("oracle_cx_detail.json") });
    expect((await acquireJdFromUrl(url, fn)).source).toBe("ats:oracle");
    // No /sites/<site>/ segment or no pod named: not Oracle.
    expect(oracleApiFromPage("https://careers.example.com/en/job/1", page)).toBeNull();
    expect(oracleApiFromPage(url, "<html></html>")).toBeNull();
  });
  test("iCIMS: the iframe page is fetched and its JSON-LD is the JD", async () => {
    const url = "https://campus-americas.icims.com/jobs/26272/data-engineer-intern%2c-2027-summer-u.s./job";
    const frame = pageFetchUrl(url);
    expect(frame).toBe(`${url}?in_iframe=1`);
    expect(pageFetchUrl(frame)).toBe(frame);
    expect(pageFetchUrl("https://example.com/jobs/1")).toBe("https://example.com/jobs/1");
    const { fn, calls } = fakeFetch({ [frame]: fixture("icims_iframe.html") });
    const got = await acquireJdFromUrl(url, fn);
    expect(got.source).toBe("embedded");
    expect(got.text).toContain("Atlassian");
    expect(calls).toEqual([frame]);
  });
  test("Phenom: embedded tier, with metadata", async () => {
    const url = "https://careers.example.com/global/en/job/2028084/splunk-solutions-engineer-intern";
    const { fn } = fakeFetch({ [url]: fixture("phenom_job.html") });
    const got = await acquireJdFromUrl(url, fn);
    expect(got.source).toBe("embedded");
    expect(got.meta?.company).toBe("Cisco");
  });
  test("Microsoft's Eightfold host names the employer", async () => {
    const url = "https://apply.careers.microsoft.com/careers/job/1970393556972687";
    const { fn } = fakeFetch({ [atsApiUrl(url)!.api]: fixture("eightfold_job.json") });
    const got = await acquireJdFromUrl(url, fn);
    expect(got.source).toBe("ats:eightfold");
    expect(got.meta?.company).toBe("Microsoft");
  });
  test("an ATS miss still reports its metadata", async () => {
    const url = "https://jobs.apple.com/en-us/details/200676912-3715";
    const short = { res: { postingTitle: "Intern", jobSummary: "Too short." } };
    const { fn } = fakeFetch({ [atsApiUrl(url)!.api]: JSON.stringify(short) });
    const got = await acquireJdFromUrl(url, fn);
    expect(got.text).toBeNull();
    expect(got.meta).toEqual({ title: "Intern", company: "Apple" });
  });
});
