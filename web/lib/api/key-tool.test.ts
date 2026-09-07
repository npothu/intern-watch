// @vitest-environment node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("key creation writes a private file and prints only its hash configuration", () => {
  const directory = mkdtempSync(join(tmpdir(), "intern-watch-key-test-"));
  try {
    const output = join(directory, "key.json");
    const script = new URL("../../../scripts/create-api-key.mjs", import.meta.url).pathname;
    const stdout = execFileSync(process.execPath, [script, "alice", output, "read"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const content = readFileSync(output, "utf8");
    const key = JSON.parse(content);
    expect(key.apiKey).toMatch(/^iw_[A-Za-z0-9_-]{43}$/);
    expect(stdout).not.toContain(key.apiKey);
    expect(JSON.parse(stdout)).toEqual({ sha256: createHash("sha256").update(key.apiKey).digest("hex"), user: "alice", access: "read" });
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(() => execFileSync(process.execPath, [script, "bob", output], { stdio: "pipe" })).toThrow();
    expect(readFileSync(output, "utf8")).toBe(content);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
