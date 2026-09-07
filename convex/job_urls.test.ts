import { describe, expect, test } from "vitest";
import cases from "../shared/job-url-cases.json";
import { applyUrlRank, postingIdentity } from "./ingest_extract";

describe("job URL identities agree with the watcher", () => {
  test.each(cases)("$url", ({ url, identity, rank }) => {
    expect(postingIdentity(url)).toBe(identity);
    expect(applyUrlRank(url)).toBe(rank);
  });
});
