// An ingest's short names a match only once the match exists. Handed out
// while fetching, or after a failure, it looks usable and is not: resume
// builds against it 404 (scrape issue #1). Shared by the REST API
// (lib/api/endpoints.ts) and the Add URL server actions.

/** Statuses whose short is backed by a match row. */
export function shortIsBacked(status: string): boolean {
  return status === "done" || status === "already_exists";
}

/** The row without `short` unless a match backs it. */
export function withBackedShort<T extends { status: string; short?: string }>(row: T): Omit<T, "short"> & { short?: string } {
  const { short, ...rest } = row;
  return shortIsBacked(row.status) && short ? { ...rest, short } : rest;
}
