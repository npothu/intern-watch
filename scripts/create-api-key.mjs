#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [user, output, access = "write", ...extra] = process.argv.slice(2);
if (!user?.trim() || !output || !["read", "write"].includes(access) || extra.length) {
  console.error("Usage: node scripts/create-api-key.mjs <tracker-user> <key-file> [read|write]");
  process.exit(1);
}
const apiKey = `iw_${randomBytes(32).toString("base64url")}`;
const sha256 = createHash("sha256").update(apiKey).digest("hex");
const filename = resolve(output);
try {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  writeFileSync(filename, `${JSON.stringify({ apiKey, user: user.trim(), access }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
} catch (error) {
  console.error(`Could not create key file: ${error.code ?? "write failed"}. Existing files are never overwritten.`);
  process.exit(1);
}
console.error(`API key saved to ${filename}. Keep this file private.`);
console.error("Add this entry to the server's TRACKER_API_KEYS JSON array:");
console.log(JSON.stringify({ sha256, user: user.trim(), access }));
