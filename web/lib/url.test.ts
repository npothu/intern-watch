import { describe, expect, it } from "vitest";
import { looksLikeUrl } from "./url";

describe("looksLikeUrl", () => {
  it("accepts absolute http(s) URLs, trimmed", () => {
    expect(looksLikeUrl("https://boards.greenhouse.io/acme/jobs/123")).toBe(true);
    expect(looksLikeUrl("  http://example.invalid/job?id=4 ")).toBe(true);
  });
  it("rejects search text and other schemes", () => {
    expect(looksLikeUrl("stripe")).toBe(false);
    expect(looksLikeUrl("stripe.com/jobs")).toBe(false);
    expect(looksLikeUrl("https://a b")).toBe(false);
    expect(looksLikeUrl("ftp://example.invalid/x")).toBe(false);
    expect(looksLikeUrl("https://")).toBe(false);
  });
});
