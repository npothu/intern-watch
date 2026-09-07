import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { approvedUsers } from "../access-config";

const keysSchema = z.array(z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  user: z.string().trim().min(1),
  access: z.enum(["read", "write"]),
}));

export type ApiPrincipal = { user: string; access: "read" | "write" };

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** API keys never fall back to Clerk cookies or accept a caller-supplied user. */
export function authenticate(request: Request): ApiPrincipal {
  const raw = process.env.TRACKER_API_KEYS;
  if (!raw) throw new ApiError(503, "api_disabled", "Script API keys are not configured.");
  let keys: z.infer<typeof keysSchema>;
  try {
    keys = keysSchema.parse(JSON.parse(raw));
    if (new Set(keys.map((key) => key.sha256)).size !== keys.length) throw new Error();
  } catch {
    throw new ApiError(503, "api_disabled", "Script API key configuration is invalid.");
  }
  const match = /^Bearer (iw_[A-Za-z0-9_-]{43})$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new ApiError(401, "unauthorized", "Provide an API key in the Authorization: Bearer header.");
  const digest = createHash("sha256").update(match[1]).digest();
  const key = keys.find((entry) => timingSafeEqual(digest, Buffer.from(entry.sha256, "hex")));
  if (!key) throw new ApiError(401, "unauthorized", "Invalid or revoked API key.");
  if (![...approvedUsers(process.env.TRACKER_USER_MAP).values()].includes(key.user)) {
    throw new ApiError(403, "forbidden", "This account no longer has access.");
  }
  return { user: key.user, access: key.access };
}
