import { PDFDocument } from "pdf-lib";
import {
  resolveResume,
  resumeRevision,
  type SavedResume,
  type CutProposal,
} from "../shared/resume-compose";
import { renderFullResumePdf } from "./resume_renderers/pdf";

async function pages(resume: SavedResume): Promise<number> {
  const bytes = await renderFullResumePdf(resolveResume(resume), "base");
  return (await PDFDocument.load(bytes)).getPageCount();
}

/** Propose reversible cuts; never mutate the source or touch locked text. */
export async function suggestResumeCuts(
  source: SavedResume,
): Promise<CutProposal> {
  const candidate = structuredClone(source);
  const beforePages = await pages(candidate);
  let afterPages = beforePages;
  const cuts: CutProposal["cuts"] = [];
  const entries = candidate.sections
    .flatMap((s) => s.entries.map((e) => ({ entry: e, kind: s.kind })))
    .filter(
      ({ entry, kind }) =>
        entry.included && !entry.locked && kind !== "education",
    )
    .sort((a, b) => (b.entry.priority ?? 1) - (a.entry.priority ?? 1));
  for (const { entry } of entries.reverse()) {
    for (const bullet of [...entry.bullets].reverse()) {
      if (afterPages <= 1) break;
      if (
        !bullet.included ||
        bullet.locked ||
        entry.bullets.filter((b) => b.included).length <= 1
      )
        continue;
      bullet.included = false;
      cuts.push({
        id: `${entry.id}/${bullet.id}`,
        entryId: entry.id,
        bulletId: bullet.id,
        text: bullet.text,
        heading: entry.heading,
        reason:
          "Remove a supporting bullet while keeping this entry and its lead bullet.",
      });
      afterPages = await pages(candidate);
    }
    if (afterPages <= 1) break;
  }
  return { revision: resumeRevision(source), beforePages, afterPages, cuts };
}
