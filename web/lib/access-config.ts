/** Exact, operator-approved identities. Invalid configuration grants no access. */
export function approvedUsers(raw: string | undefined): Map<string, string> {
  const users = new Map<string, string>();
  if (!raw) return users;
  try {
    const entries: unknown = JSON.parse(raw);
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) return users;
    for (const [address, value] of Object.entries(entries)) {
      const email = address.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof value !== "string" ||
          !/^[a-zA-Z0-9_-]{1,100}$/.test(value) || users.has(email)) return new Map();
      users.set(email, value);
    }
    return users;
  } catch {
    return users;
  }
}
