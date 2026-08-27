// Company-name normalization, mirrored from src/normalize.py norm_company so
// the web app can match a row's employer against the priority list the same
// way the watcher does: casefold, "&" -> "and", punctuation to spaces, and
// trailing corporate suffixes dropped ("Meta Platforms, Inc." ~ "meta
// platforms"). Keep the two in step; web/lib/company.test.ts pins cases.

const SUFFIXES = new Set([
  "inc", "incorporated", "llc", "llp", "ltd", "limited", "corp",
  "corporation", "co", "company", "plc", "gmbh", "sa", "ag", "nv",
]);

export function normCompany(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[.,()'’"!]+/g, " ");
  const tokens = s.replace(/\s+/g, " ").trim().split(" ");
  while (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(" ");
}
