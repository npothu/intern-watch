// The resume tailor's LLM providers.
//
// This is the TypeScript twin of src/llm.py's `_PROVIDERS` / `DEFAULT_MODEL`
// tables, deliberately mirroring their shape rather than inventing a second
// vocabulary: same provider ids, same "one function per provider taking
// (model, system, user, apiKey)" contract, same default-model map. When a
// provider is added on one side, add it on the other.
//
// It lives apart from resume_node.ts (which is "use node") so the registry
// itself stays a pure module with no Convex imports - which is what makes the
// selection logic below unit-testable without a backend.
//
// Every call here uses plain `fetch` and no SDK: the Anthropic and OpenAI
// clients pull in large dependency trees for what is one POST, and the Convex
// bundler is happier without them.

/** Provider ids. `openrouter` is OpenAI-compatible and shares its adapter. */
export const PROVIDERS = ["gemini", "anthropic", "openai", "openrouter"] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(v: unknown): v is Provider {
  return typeof v === "string" && (PROVIDERS as readonly string[]).includes(v);
}

/**
 * The model used when a user picks a provider but not a specific model.
 * gemini's entry matches src/llm.py's DEFAULT_MODEL so the watcher and the
 * resume builder agree on what "the default model" means.
 */
export const DEFAULT_MODEL: Record<Provider, string> = {
  gemini: "gemini-flash-lite-latest",
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-5.1-mini",
  openrouter: "google/gemini-2.5-flash-lite",
};

/**
 * What the operator's key runs when a user has expressed no preference. Kept
 * cheap on purpose: it is the host paying, and it is capped per user per day.
 */
export const OPERATOR_PROVIDER: Provider = "gemini";
export const OPERATOR_MODEL = DEFAULT_MODEL.gemini;

/** Models offered in the UI picker. Free text is still accepted server-side -
 *  this is a convenience list, not an allowlist, so a new model never needs a
 *  deploy to become usable. */
export const SUGGESTED_MODELS: Record<Provider, string[]> = {
  gemini: ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-pro"],
  anthropic: [
    "claude-haiku-4-5-20251001",
    "claude-sonnet-5",
    "claude-opus-5",
  ],
  openai: ["gpt-5.1-mini", "gpt-5.1"],
  openrouter: [
    "google/gemini-2.5-flash-lite",
    "anthropic/claude-sonnet-5",
    "deepseek/deepseek-v4-flash-0731",
  ],
};

/** Human label for a provider, for UI and for build-report notes. */
export const PROVIDER_LABEL: Record<Provider, string> = {
  gemini: "Gemini",
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

const MAX_OUTPUT_TOKENS = 8192;
const TIMEOUT_MS = 120_000;

export function resumeImportOutputTokens(
  provider: Provider,
  model: string,
): number | undefined {
  return provider === "gemini" && SUGGESTED_MODELS.gemini.includes(model)
    ? 32_768
    : undefined;
}

type CallArgs = {
  model: string;
  system: string;
  user: string;
  apiKey: string;
  maxOutputTokens?: number;
};

/** Every provider raises on a non-2xx so the caller's single catch can fall
 *  back to bank text, exactly as the Python tailor never raises past itself. */
async function post(url: string, init: RequestInit): Promise<Response> {
  const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!resp.ok) {
    // The body usually names the real cause (bad key, unknown model, quota).
    const detail = (await resp.text().catch(() => "")).slice(0, 300);
    throw new Error(`HTTP ${resp.status}${detail ? ` - ${detail}` : ""}`);
  }
  return resp;
}

async function callGemini({
  model,
  system,
  user,
  apiKey,
  maxOutputTokens = MAX_OUTPUT_TOKENS,
}: CallArgs): Promise<string> {
  const resp = await post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens,
          temperature: 0,
        },
      }),
    },
  );
  const data = (await resp.json()) as {
    candidates?: Array<{
      finishReason?: string;
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };
  if (data.candidates?.[0]?.finishReason === "MAX_TOKENS") {
    throw new Error("Gemini stopped because the output token limit was reached");
  }
  return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
}

async function callAnthropic({
  model,
  system,
  user,
  apiKey,
  maxOutputTokens = MAX_OUTPUT_TOKENS,
}: CallArgs): Promise<string> {
  const resp = await post("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxOutputTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const data = (await resp.json()) as {
    stop_reason?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (data.stop_reason === "max_tokens") {
    throw new Error("Anthropic stopped because the output token limit was reached");
  }
  return (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

/**
 * One adapter for every OpenAI-compatible chat-completions endpoint. OpenAI and
 * OpenRouter differ only in base URL, which is why supporting both cost one
 * function rather than two.
 */
function openAiCompatible(baseUrl: string) {
  return async ({
    model,
    system,
    user,
    apiKey,
    maxOutputTokens = MAX_OUTPUT_TOKENS,
  }: CallArgs): Promise<string> => {
    const resp = await post(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: maxOutputTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    const data = (await resp.json()) as {
      choices?: Array<{
        finish_reason?: string;
        message?: { content?: string };
      }>;
    };
    if (data.choices?.[0]?.finish_reason === "length") {
      throw new Error("The model stopped because the output token limit was reached");
    }
    return data.choices?.[0]?.message?.content ?? "";
  };
}

const CALLERS: Record<Provider, (args: CallArgs) => Promise<string>> = {
  gemini: callGemini,
  anthropic: callAnthropic,
  openai: openAiCompatible("https://api.openai.com/v1"),
  openrouter: openAiCompatible("https://openrouter.ai/api/v1"),
};

/**
 * Run the tailor prompt against one provider and return its raw text.
 * Throws on any failure; the caller falls back to bank text.
 */
export async function callModel(
  provider: Provider,
  args: CallArgs,
): Promise<string> {
  const text = await CALLERS[provider](args);
  if (!text.trim()) throw new Error(`${PROVIDER_LABEL[provider]} returned an empty response`);
  return text;
}

// --- selection ---------------------------------------------------------------

/** Where the key that ran a build came from. Surfaced in the build report so a
 *  user can always tell whose quota paid for their resume. */
export type LlmSource = "user" | "operator" | "none";

/**
 * The provider a user's saved key should be looked up under.
 *
 * A user with no stored preference still gets one: the operator default. That
 * is what lets a key saved before per-user model choice existed keep working -
 * see the note in chooseLlm.
 */
export function effectiveProvider(
  preference?: { provider?: string } | null,
): Provider {
  return isProvider(preference?.provider)
    ? (preference!.provider as Provider)
    : OPERATOR_PROVIDER;
}

/**
 * Cheap credential check per provider: hit an authenticated endpoint that
 * costs no tokens, so the Connections page's Test button never bills the user
 * for pressing it. Returns a short human verdict either way.
 */
export async function testProviderKey(
  provider: Provider,
  apiKey: string,
): Promise<{ ok: boolean; detail: string }> {
  const req: Record<Provider, { url: string; headers: Record<string, string> }> = {
    gemini: {
      url: "https://generativelanguage.googleapis.com/v1beta/models",
      headers: { "x-goog-api-key": apiKey },
    },
    anthropic: {
      url: "https://api.anthropic.com/v1/models?limit=1",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    },
    openai: {
      url: "https://api.openai.com/v1/models",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    openrouter: {
      url: "https://openrouter.ai/api/v1/key",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  };
  const { url, headers } = req[provider];
  try {
    const started = Date.now();
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) {
      const body = (await resp.text().catch(() => "")).slice(0, 160);
      return {
        ok: false,
        detail: `${PROVIDER_LABEL[provider]} rejected the key (HTTP ${resp.status})${body ? ` - ${body}` : ""}`,
      };
    }
    return {
      ok: true,
      detail: `${PROVIDER_LABEL[provider]} accepted the key in ${Date.now() - started} ms`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export type LlmChoice = {
  source: LlmSource;
  provider: Provider;
  model: string;
  apiKey: string | null;
  /** Set when source is "none" - the human-readable reason, for the report. */
  reason?: string;
};

/**
 * Decide which provider, model and key a build should use.
 *
 * Order, and the product decision behind it: a user's OWN key always wins and
 * is never capped, because it is their quota. Otherwise the operator's key runs
 * a cheap default model, subject to a per-user daily cap. If neither exists the
 * build still succeeds - it just uses bank text verbatim - which is why this
 * returns a "none" choice rather than throwing.
 *
 * Pure, so the whole matrix is unit-testable without a deployment.
 */
export function chooseLlm(opts: {
  /** The user's saved preference, if any. */
  preference?: { provider?: string; model?: string } | null;
  /** The user's own API key for `effectiveProvider(preference)`, if they saved one. */
  userKey?: string | null;
  /** The deployment's shared key. */
  operatorKey?: string | null;
  /** True when the user has already used up today's operator-key allowance. */
  operatorCapReached?: boolean;
}): LlmChoice {
  const provider = effectiveProvider(opts.preference);

  // Note this does NOT require an explicit preference. Before per-user model
  // choice existed, a user's Gemini key was read unconditionally; gating on a
  // preference row would have silently orphaned every key saved before the
  // settings table existed, downgrading those users to the shared key without
  // a word. Falling back to the default provider keeps them on their own key.
  if (opts.userKey) {
    return {
      source: "user",
      provider,
      model: opts.preference?.model?.trim() || DEFAULT_MODEL[provider],
      apiKey: opts.userKey,
    };
  }

  if (opts.operatorKey) {
    if (opts.operatorCapReached) {
      return {
        source: "none",
        provider: OPERATOR_PROVIDER,
        model: OPERATOR_MODEL,
        apiKey: null,
        reason:
          "daily limit on the shared model reached - add your own API key in Settings for unlimited rebuilds",
      };
    }
    return {
      source: "operator",
      provider: OPERATOR_PROVIDER,
      model: OPERATOR_MODEL,
      apiKey: opts.operatorKey,
    };
  }

  return {
    source: "none",
    provider: OPERATOR_PROVIDER,
    model: OPERATOR_MODEL,
    apiKey: null,
    reason:
      "no shared model is configured on this deployment - add your own API key in Settings to enable tailoring",
  };
}

/** The build-report note describing what actually ran. */
export function llmNote(choice: LlmChoice): string {
  if (choice.source === "none") return `${choice.reason} - bank text used verbatim`;
  const who = choice.source === "user" ? "your key" : "the shared key";
  return `tailored with ${PROVIDER_LABEL[choice.provider]} ${choice.model} (${who})`;
}
