// Pure composition model shared by the browser and backend. Type-only imports
// are erased; this module must never import the Convex runtime.
import type { Entry, ProfileV2, Section } from "../convex/profile_schema";

export type ResumeBullet = {
  id: string;
  text: string;
  included: boolean;
  locked: boolean;
};
export type ResumeEntry = Omit<Entry, "bullets" | "hiddenIn"> & {
  included: boolean;
  locked: boolean;
  bullets: ResumeBullet[];
};
export type ResumeSection = Omit<Section, "entries"> & {
  entries: ResumeEntry[];
};
export type SavedResume = {
  name: string;
  header: ProfileV2["header"];
  skills: ProfileV2["skills"];
  sections: ResumeSection[];
};
export type CutSuggestion = {
  id: string;
  entryId: string;
  bulletId: string;
  text: string;
  heading: string;
  reason: string;
};
export type CutProposal = {
  revision: string;
  cuts: CutSuggestion[];
  beforePages: number;
  afterPages: number;
};
export const MAX_PROFILE_BYTES = 768 * 1024;

export function snapshotVariant(profile: ProfileV2, name: string): SavedResume {
  return structuredClone({
    name,
    header: profile.header,
    skills: profile.skills,
    sections: profile.sections.map((section) => ({
      ...section,
      entries: section.entries.map(({ bullets, hiddenIn, ...entry }) => ({
        ...entry,
        included: !hiddenIn?.includes(name),
        locked: false,
        bullets: (bullets[name] ?? bullets.base ?? []).map((text, index) => ({
          id: `${entry.id}:${index}`,
          text,
          included: true,
          locked: false,
        })),
      })),
    })),
  });
}

/** Presence of savedResumes, even [], is the migration marker. */
export function savedResumes(profile: ProfileV2): SavedResume[] {
  if (profile.savedResumes) return profile.savedResumes;
  const names = new Set(profile.variants ?? []);
  profile.sections.forEach((s) =>
    s.entries.forEach((e) =>
      Object.keys(e.bullets).forEach((n) => names.add(n)),
    ),
  );
  names.delete("base");
  return [...names].map((name) => snapshotVariant(profile, name));
}

export function getResume(profile: ProfileV2, name: string): SavedResume {
  if (name === "base") return snapshotVariant(profile, name);
  const resume = savedResumes(profile).find((r) => r.name === name);
  if (!resume && !profile.savedResumes) return snapshotVariant(profile, name);
  if (!resume) throw new Error(`Resume variant "${name}" no longer exists.`);
  return resume;
}

export function putResume(profile: ProfileV2, resume: SavedResume): ProfileV2 {
  if (resume.name === "base")
    throw new Error("Create a variant to compose a resume.");
  const resumes = savedResumes(profile);
  return {
    ...profile,
    savedResumes: resumes.some((r) => r.name === resume.name)
      ? resumes.map((r) => (r.name === resume.name ? resume : r))
      : [...resumes, resume],
  };
}

export function copyResume(
  profile: ProfileV2,
  source: string,
  name: string,
): ProfileV2 {
  name = name.trim();
  if (!name || name.length > 40)
    throw new Error("Use a name between 1 and 40 characters.");
  if (
    name.toLowerCase() === "base" ||
    savedResumes(profile).some(
      (r) => r.name.toLowerCase() === name.toLowerCase(),
    )
  ) {
    throw new Error("That variant name already exists.");
  }
  return putResume(profile, {
    ...structuredClone(getResume(profile, source)),
    name,
  });
}

export function deleteResumeVariant(
  profile: ProfileV2,
  name: string,
): ProfileV2 {
  return {
    ...profile,
    savedResumes: savedResumes(profile).filter((r) => r.name !== name),
    variants: profile.variants?.filter((v) => v !== name),
    sections: profile.sections.map((s) => ({
      ...s,
      entries: s.entries.map((e) => ({
        ...e,
        hiddenIn: e.hiddenIn?.filter((v) => v !== name),
        bullets: Object.fromEntries(
          Object.entries(e.bullets).filter(([v]) => v !== name),
        ),
      })),
    })),
  };
}

/** The sole output boundary: no excluded text or alternate fallback survives. */
export function resolveResume(resume: SavedResume): ProfileV2 {
  return structuredClone({
    version: 2,
    header: resume.header,
    skills: resume.skills,
    sections: resume.sections.map((s) => ({
      ...s,
      entries: s.entries
        .filter((e) => e.included)
        .map((e) => {
          const { included: _included, locked: _locked, bullets, ...entry } = e;
          return {
            ...entry,
            bullets: {
              base: bullets.filter((b) => b.included).map((b) => b.text),
            },
          };
        }),
    })),
  });
}

export function resumeRevision(resume: SavedResume): string {
  // Compare the complete value, including exclusions and locks, without hash collisions.
  return JSON.stringify(resume);
}

export function applyCuts(
  resume: SavedResume,
  proposal: CutProposal,
  accepted: string[],
): SavedResume {
  if (resumeRevision(resume) !== proposal.revision)
    throw new Error("The resume changed. Request new suggestions.");
  const ids = new Set(accepted);
  const cuts = proposal.cuts.filter((c) => ids.has(c.id));
  return {
    ...resume,
    sections: resume.sections.map((s) => ({
      ...s,
      entries: s.entries.map((e) => ({
        ...e,
        bullets: e.bullets.map((b) =>
          !e.locked &&
          !b.locked &&
          cuts.some((c) => c.entryId === e.id && c.bulletId === b.id)
            ? { ...b, included: false }
            : b,
        ),
      })),
    })),
  };
}

/** Library additions are offered explicitly and start excluded. Existing text never changes. */
export function addFromLibrary(
  profile: ProfileV2,
  resume: SavedResume,
): SavedResume {
  const base = snapshotVariant(profile, "base");
  const next = structuredClone(resume);
  for (const section of base.sections) {
    let target = next.sections.find((s) => s.id === section.id);
    if (!target) {
      target = { ...section, entries: [] };
      next.sections.push(target);
    }
    for (const entry of section.entries) {
      const current = target.entries.find((e) => e.id === entry.id);
      if (!current) target.entries.push({ ...entry, included: false });
      else {
        // Occurrence-aware matching keeps duplicate source bullets without duplicating existing ones.
        const remaining = current.bullets.map((b) => b.text);
        for (const bullet of entry.bullets) {
          const at = remaining.indexOf(bullet.text);
          if (at >= 0) remaining.splice(at, 1);
          else {
            let id = bullet.id;
            while (current.bullets.some((b) => b.id === id)) id += "+";
            current.bullets.push({ ...bullet, id, included: false });
          }
        }
      }
    }
  }
  return next;
}

export type ResumeDifference = {
  heading: string;
  before: string[];
  after: string[];
};
export function compareWithBase(
  profile: ProfileV2,
  resume: SavedResume,
): ResumeDifference[] {
  const before = resolveResume(snapshotVariant(profile, "base"));
  const after = resolveResume(resume);
  const changes: ResumeDifference[] = [];
  if (JSON.stringify(before.header) !== JSON.stringify(after.header))
    changes.push({
      heading: "Contact information",
      before: [JSON.stringify(before.header)],
      after: [JSON.stringify(after.header)],
    });
  if (JSON.stringify(before.skills) !== JSON.stringify(after.skills))
    changes.push({
      heading: "Skills",
      before: [JSON.stringify(before.skills)],
      after: [JSON.stringify(after.skills)],
    });
  if (
    before.sections.map((s) => s.id).join() !==
    after.sections.map((s) => s.id).join()
  )
    changes.push({
      heading: "Section order",
      before: before.sections.map((s) => s.title),
      after: after.sections.map((s) => s.title),
    });
  const a = before.sections.flatMap((s) => s.entries);
  const b = after.sections.flatMap((s) => s.entries);
  const ids = new Set([...a, ...b].map((e) => e.id));
  for (const id of ids) {
    const x = a.find((e) => e.id === id),
      y = b.find((e) => e.id === id);
    const describe = (e: Entry | undefined) =>
      e
        ? [
            e.heading,
            [e.subheading, e.location, e.date].filter(Boolean).join(" · "),
            ...(e.bullets.base ?? []),
          ]
        : [];
    const left = describe(x),
      right = describe(y);
    if (
      JSON.stringify(left) !== JSON.stringify(right) ||
      a.indexOf(x!) !== b.indexOf(y!)
    )
      changes.push({
        heading: y?.heading ?? x?.heading ?? "Entry",
        before: left,
        after: right,
      });
  }
  return changes;
}
