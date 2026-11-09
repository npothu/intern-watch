import { describe, expect, it } from "vitest";
import { addUrlFieldOnOpen, looksLikeUrl } from "./url";

describe("addUrlFieldOnOpen", () => {
  it("uses a passed prefill, trimmed", () => {
    expect(addUrlFieldOnOpen("  https://example.invalid/job/1 ")).toBe("https://example.invalid/job/1");
  });
  it("starts empty when opened without one", () => {
    expect(addUrlFieldOnOpen(undefined)).toBe("");
    expect(addUrlFieldOnOpen(null)).toBe("");
    expect(addUrlFieldOnOpen(42)).toBe("");
  });
});

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
