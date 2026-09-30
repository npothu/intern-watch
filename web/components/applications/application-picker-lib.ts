import type { ApplicationOption } from "@/lib/convex";

export type OrderedApplication = ApplicationOption & { suggested: boolean };

export function orderedApplications(
  applications: ApplicationOption[],
  suggestedShorts: string[],
  query: string,
): OrderedApplication[] {
  const q = query.trim().toLowerCase();
  const suggestionRank = new Map(suggestedShorts.map((short, index) => [short, index]));
  return applications
    .filter((application) => {
      if (!q) return true;
      return [
        application.company,
        application.title,
        application.location,
        application.url,
        application.status.replaceAll("_", " "),
      ].some((value) => value.toLowerCase().includes(q));
    })
    .map((application) => ({
      ...application,
      suggested: suggestionRank.has(application.short),
    }))
    .sort((a, b) => {
      if (!q) {
        const aRank = suggestionRank.get(a.short) ?? Number.MAX_SAFE_INTEGER;
        const bRank = suggestionRank.get(b.short) ?? Number.MAX_SAFE_INTEGER;
        if (aRank !== bRank) return aRank - bRank;
      }
      return a.company.localeCompare(b.company) ||
        a.title.localeCompare(b.title) ||
        a.short.localeCompare(b.short);
    });
}
