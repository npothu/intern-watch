// Pure helpers for the add-URL dialog's bulk paste: pull links out of
// whatever was pasted (one per line, space separated, or a block of story
// text with links in it), dedupe, and describe a coverage gap.

export const MAX_BULK_LINKS = 25;

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

/** Every http(s) link in `text`, in order, trailing punctuation trimmed,
 * duplicates (ignoring a trailing slash and #fragment) dropped. */
export function parseLinks(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[),.;:!?\]}]+$/, "");
    let key: string;
    try {
      const u = new URL(url);
      key = `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
    } catch {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

export type GapInfo = { ats?: string; atsBoard?: string; boardWatched?: boolean; atsSupported?: boolean };

const ATS_LABEL: Record<string, string> = {
  greenhouse: "Greenhouse",
  "greenhouse-eu": "Greenhouse EU",
  lever: "Lever",
  "lever-eu": "Lever EU",
  ashby: "Ashby",
  smartrecruiters: "SmartRecruiters",
  workday: "Workday",
  oracle: "Oracle",
  avature: "Avature",
  icims: "iCIMS",
  eightfold: "Eightfold",
  ibm: "IBM Careers",
  jibe: "Jibe",
  workable: "Workable",
  taleo: "Taleo",
  successfactors: "SuccessFactors",
  radancy: "Radancy",
};

/** "SmartRecruiters board Gamma isn't watched" when the add exposed a board
 * the watcher doesn't poll; null when it is watched or that's unknown. An ATS
 * with no adapter gets a different message: no yaml row can fix that. */
export function gapMessage(g: GapInfo): string | null {
  if (g.boardWatched !== false || !g.ats || !g.atsBoard) return null;
  const label = ATS_LABEL[g.ats] ?? g.ats;
  if (g.atsSupported !== true) {
    return g.ats === "other"
      ? "This site isn’t on a known ATS. It’s counted in the weekly coverage-gaps issue."
      : `${label} has no adapter yet. It’s counted in the weekly coverage-gaps issue.`;
  }
  return `${label} board “${g.atsBoard}” isn’t watched.`;
}

/** A data/ats_boards.yaml row for the board, ready to paste - only for an
 * ATS the adapter polls (a row for any other ATS breaks the source). */
export function boardYamlRow(g: GapInfo, company?: string): string | null {
  if (!g.ats || !g.atsBoard || g.atsSupported !== true) return null;
  const name = (company || g.atsBoard).replace(/"/g, "'");
  return `- company: "${name}"\n  ats: ${g.ats}\n  slug: "${g.atsBoard}"\n`;
}
