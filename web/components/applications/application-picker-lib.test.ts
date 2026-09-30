import { describe, expect, test } from "vitest";

import { orderedApplications } from "./application-picker-lib";

const applications = [
  {
    short: "111111111111",
    company: "Acme",
    title: "Software Intern",
    location: "Austin",
    url: "https://acme.test/job/42",
    status: "applied",
  },
  {
    short: "222222222222",
    company: "Quiet Co",
    title: "Data Intern",
    location: "Remote",
    url: "https://quiet.test/job/7",
    status: "phone_screen",
  },
];

describe("orderedApplications", () => {
  test("puts classifier suggestions first without hiding the rest", () => {
    const result = orderedApplications(applications, ["222222222222"], "");
    expect(result.map((item) => item.short)).toEqual([
      "222222222222",
      "111111111111",
    ]);
    expect(result.map((item) => item.suggested)).toEqual([true, false]);
  });

  test.each(["quiet", "data", "remote", "quiet.test", "phone screen"])(
    "searches every catalog field for %s",
    (query) => {
      expect(orderedApplications(applications, [], query).map((item) => item.short))
        .toEqual(["222222222222"]);
    },
  );
});
