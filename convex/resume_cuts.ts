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
    const lead = entry.bullets.find((b) => b.included)?.id;
    for (const bullet of [...entry.bullets].reverse()) {
      if (afterPages <= 1) break;
      if (
        bullet.id === lead ||
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
  // Offer optional entries when supporting bullets alone cannot reach one page.
  // A locked selected bullet also protects its containing entry from removal.
  for (const { entry, kind } of entries) {
    if (afterPages <= 1) break;
    if (kind !== "projects" && kind !== "community") continue;
    if (entry.bullets.some((b) => b.included && b.locked)) continue;
    const remaining = candidate.sections
      .filter((s) => s.kind === kind)
      .flatMap((s) => s.entries)
      .filter((e) => e.included);
    if (remaining.length <= 1) continue;
    entry.included = false;
    for (let index = cuts.length - 1; index >= 0; index--)
      if (cuts[index].entryId === entry.id) cuts.splice(index, 1);
    cuts.push({
      id: `${entry.id}/entry`,
      entryId: entry.id,
      heading: entry.heading,
      text: "Exclude this entire entry from the resume.",
      reason:
        "Makes room while retaining this entry and its bullets in Excluded.",
    });
    afterPages = await pages(candidate);
  }
  return { revision: resumeRevision(source), beforePages, afterPages, cuts };
}
