/**
 * Parity check: lib/shortkey.ts must match src/dashboard.py short_key().
 *
 * The expected values below were generated with the Python side directly:
 *
 *   python -c "import hashlib; print(hashlib.sha1('KEY'.encode('utf-8')).hexdigest()[:12])"
 *
 * for each hardcoded input. Run with:  node scripts/shortkey-check.ts
 */
import { shortKey } from "../lib/shortkey.ts";

const CASES: Array<[string, string]> = [
  ["jr:1e6a1907abcd1234ef567890", "a2f10e78d0ef"],
  [
    "url:https://boards.greenhouse.io/embed/job_app?token=abc123",
    "dcd1179d882e",
  ],
  ["", "da39a3ee5e6b"],
];

let failed = 0;
for (const [input, expected] of CASES) {
  const got = shortKey(input);
  const ok = got === expected;
  if (!ok) failed += 1;
  console.log(
    `${ok ? "ok  " : "FAIL"} shortKey(${JSON.stringify(input)}) => ${got} ${
      ok ? "" : `(expected ${expected})`
    }`
  );
}

if (failed > 0) {
  console.error(`\n${failed}/${CASES.length} case(s) failed parity check`);
  process.exit(1);
}
console.log(`\nAll ${CASES.length} case(s) match Python short_key().`);
