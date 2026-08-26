import { describe, expect, it } from "vitest";
import { filenameFromDisposition } from "./download";

describe("filenameFromDisposition", () => {
  it("prefers the RFC 5987 encoded name", () => {
    expect(
      filenameFromDisposition(
        `attachment; filename="Alex_Example_Resume.pdf"; filename*=UTF-8''Alex_Ex%C3%A1mple_Resume.pdf`
      )
    ).toBe("Alex_Exámple_Resume.pdf");
  });

  it("falls back to the quoted name", () => {
    expect(filenameFromDisposition('attachment; filename="Alex_Example_Resume_swe.docx"')).toBe(
      "Alex_Example_Resume_swe.docx"
    );
  });

  it("accepts a bare token", () => {
    expect(filenameFromDisposition("attachment; filename=resume.pdf")).toBe("resume.pdf");
  });

  it("returns null when nothing is named", () => {
    expect(filenameFromDisposition(null)).toBeNull();
    expect(filenameFromDisposition("attachment")).toBeNull();
    expect(filenameFromDisposition('attachment; filename=""')).toBeNull();
  });
});
