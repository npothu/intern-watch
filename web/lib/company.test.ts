import { describe, expect, it } from "vitest";
import { normCompany } from "./company";

// Same cases src/normalize.py's norm_company is expected to produce.
describe("normCompany", () => {
  it("casefolds and drops punctuation and suffixes", () => {
    expect(normCompany("Meta, Inc.")).toBe("meta");
    expect(normCompany("Amazon Web Services LLC")).toBe("amazon web services");
    expect(normCompany("Johnson & Johnson")).toBe("johnson and johnson");
    expect(normCompany("Zillow Group")).toBe("zillow group");
    expect(normCompany("  NVIDIA  ")).toBe("nvidia");
    expect(normCompany("Company Co.")).toBe("company");
  });
  it("keeps a lone suffix-looking word", () => {
    expect(normCompany("Inc")).toBe("inc");
  });
});
