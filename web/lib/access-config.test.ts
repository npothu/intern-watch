import { expect, test } from "vitest";
import { approvedUsers } from "./access-config";

test("approved identities are exact normalized addresses with explicit user keys", () => {
  const map = approvedUsers(JSON.stringify({ "Alice@Gmail.com": "alice" }));
  expect(map.get("alice@gmail.com")).toBe("alice");
  expect(map.get("alice+friend@gmail.com")).toBeUndefined();
  expect(map.get("constructor")).toBeUndefined();
});

test.each([undefined, "{broken", "[]", '{"a@gmail.com":3}', '{"a@gmail.com":""}', '{"a@gmail.com":"alice","A@gmail.com":"bob"}'])("invalid maps fail closed: %s", (raw) => {
  expect(approvedUsers(raw).size).toBe(0);
});
