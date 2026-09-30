export const APPLICATION_STATUSES = [
  "applied",
  "oa",
  "phone_screen",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export type ManualApplicationDraft = {
  company: string;
  title?: string;
  location?: string;
  url?: string;
  note?: string;
  status?: string;
  appliedDate?: string;
};

export type ManualApplicationRequest = {
  requestId: string;
  draft: ManualApplicationDraft;
};

export type NormalizedManualApplication = {
  company: string;
  title?: string;
  location?: string;
  url?: string;
  note?: string;
  status: ApplicationStatus;
  appliedDate: string;
  appliedDateWasProvided: boolean;
};

export const MANUAL_APPLICATION_LIMITS = {
  company: 200,
  title: 300,
  location: 200,
  url: 2_000,
  note: 2_000,
} as const;

export function isApplicationStatus(value: string): value is ApplicationStatus {
  return (APPLICATION_STATUSES as readonly string[]).includes(value);
}

function optionalText(value: unknown, field: keyof typeof MANUAL_APPLICATION_LIMITS) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be text`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MANUAL_APPLICATION_LIMITS[field]) {
    throw new Error(`${field} is too long`);
  }
  return trimmed;
}

function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function normalizeManualApplication(
  draft: ManualApplicationDraft,
  today = new Date().toISOString().slice(0, 10),
): NormalizedManualApplication {
  const company = optionalText(draft.company, "company");
  if (!company) throw new Error("company is required");

  const title = optionalText(draft.title, "title");
  const location = optionalText(draft.location, "location");
  const url = optionalText(draft.url, "url");
  const note = optionalText(draft.note, "note");
  if (url) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("job link must start with http:// or https://");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("job link must start with http:// or https://");
    }
  }

  const status = draft.status?.trim() || "applied";
  if (!isApplicationStatus(status)) throw new Error("invalid status");

  const suppliedDate = draft.appliedDate?.trim() || "";
  if (suppliedDate && !isRealDate(suppliedDate)) {
    throw new Error("applied date must be a valid date");
  }

  return {
    company,
    ...(title ? { title } : {}),
    ...(location ? { location } : {}),
    ...(url ? { url } : {}),
    ...(note ? { note } : {}),
    status,
    appliedDate: suppliedDate || today,
    appliedDateWasProvided: Boolean(suppliedDate),
  };
}

export function manualApplicationFingerprint(
  draft: NormalizedManualApplication,
): string {
  return JSON.stringify({
    company: draft.company,
    title: draft.title ?? "",
    location: draft.location ?? "",
    url: draft.url ?? "",
    note: draft.note ?? "",
    status: draft.status,
    appliedDate: draft.appliedDateWasProvided ? draft.appliedDate : "",
  });
}

export function assertManualRequestId(requestId: string): void {
  if (
    typeof requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      requestId,
    )
  ) {
    throw new Error("invalid request id");
  }
}

export function manualApplicationRequestError(
  request: ManualApplicationRequest,
): string | null {
  try {
    assertManualRequestId(request.requestId);
    normalizeManualApplication(request.draft);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}
