import { describe, expect, test, vi } from "vitest";
import {
  callModel,
  chooseLlm,
  DEFAULT_MODEL,
  effectiveProvider,
  isProvider,
  llmNote,
  OPERATOR_MODEL,
  OPERATOR_PROVIDER,
  PROVIDERS,
  resumeImportOutputTokens,
  SUGGESTED_MODELS,
} from "./llm_providers";

// chooseLlm encodes the whole product decision behind "the key is an upgrade,
// not a toll", so the matrix is pinned here rather than discovered in prod.

describe("chooseLlm", () => {
  test("a user with no preference and no key rides the operator key", () => {
    const c = chooseLlm({ operatorKey: "op" });
    expect(c.source).toBe("operator");
    expect(c.provider).toBe(OPERATOR_PROVIDER);
    expect(c.model).toBe(OPERATOR_MODEL);
    expect(c.apiKey).toBe("op");
  });

  test("a saved key with NO preference row still wins over the operator key", () => {
    // The regression this guards: gating the key lookup on a settings row that
    // did not exist before this feature orphaned every key saved earlier, and
    // silently moved those users onto the shared key and its daily cap.
    const c = chooseLlm({ preference: null, userKey: "sk-legacy", operatorKey: "op" });
    expect(c.source).toBe("user");
    expect(c.provider).toBe(OPERATOR_PROVIDER);
    expect(c.apiKey).toBe("sk-legacy");
  });

  test("effectiveProvider defaults to the operator provider when unset", () => {
    expect(effectiveProvider(null)).toBe(OPERATOR_PROVIDER);
    expect(effectiveProvider({ provider: "nonsense" })).toBe(OPERATOR_PROVIDER);
    expect(effectiveProvider({ provider: "anthropic" })).toBe("anthropic");
  });

  test("a user's own key wins over the operator key, on their chosen provider", () => {
    const c = chooseLlm({
      preference: { provider: "anthropic", model: "claude-sonnet-5" },
      userKey: "sk-user",
      operatorKey: "op",
    });
    expect(c.source).toBe("user");
    expect(c.provider).toBe("anthropic");
    expect(c.model).toBe("claude-sonnet-5");
    expect(c.apiKey).toBe("sk-user");
  });

  test("a chosen provider with no model falls back to that provider's default", () => {
    const c = chooseLlm({
      preference: { provider: "openrouter" },
      userKey: "sk-user",
    });
    expect(c.model).toBe(DEFAULT_MODEL.openrouter);
  });

  test("a preference without a key does NOT strand the user - the operator key still runs", () => {
    // The failure this guards: picking a model in the UI, never saving a key,
    // and silently losing tailoring altogether.
    const c = chooseLlm({
      preference: { provider: "openai", model: "gpt-5.1" },
      userKey: null,
      operatorKey: "op",
    });
    expect(c.source).toBe("operator");
    expect(c.provider).toBe(OPERATOR_PROVIDER);
  });

  test("an unknown provider preference still uses a saved key, on the default provider", () => {
    const c = chooseLlm({
      preference: { provider: "definitely-not-a-provider" },
      userKey: "sk-user",
      operatorKey: "op",
    });
    expect(c.source).toBe("user");
    expect(c.provider).toBe(OPERATOR_PROVIDER);
  });

  test("the daily cap disables the LLM but never fails the build", () => {
    const c = chooseLlm({ operatorKey: "op", operatorCapReached: true });
    expect(c.source).toBe("none");
    expect(c.apiKey).toBeNull();
    expect(c.reason).toMatch(/daily limit/i);
    // The way out is named, not implied.
    expect(c.reason).toMatch(/your own API key/i);
  });

  test("a user's own key is NOT subject to the operator cap", () => {
    const c = chooseLlm({
      preference: { provider: "anthropic" },
      userKey: "sk-user",
      operatorKey: "op",
      operatorCapReached: true,
    });
    expect(c.source).toBe("user");
    expect(c.apiKey).toBe("sk-user");
  });

  test("no key anywhere still yields a runnable build, with a reason", () => {
    const c = chooseLlm({});
    expect(c.source).toBe("none");
    expect(c.apiKey).toBeNull();
    expect(c.reason).toMatch(/no shared model/i);
  });
});

describe("llmNote", () => {
  test("names the model and whose quota paid for it", () => {
    expect(llmNote(chooseLlm({ operatorKey: "op" }))).toContain("the shared key");
    const mine = llmNote(
      chooseLlm({ preference: { provider: "anthropic" }, userKey: "k" }),
    );
    expect(mine).toContain("your key");
    expect(mine).toContain("Anthropic");
    expect(mine).toContain(DEFAULT_MODEL.anthropic);
  });

  test("a skipped build explains itself instead of going quiet", () => {
    expect(llmNote(chooseLlm({}))).toMatch(/bank text used verbatim/);
  });
});

describe("registry integrity", () => {
  test("every provider has a default model and suggestions", () => {
    for (const p of PROVIDERS) {
      expect(DEFAULT_MODEL[p], `default model for ${p}`).toBeTruthy();
      expect(SUGGESTED_MODELS[p].length, `suggestions for ${p}`).toBeGreaterThan(0);
      // The default must be offered in the picker, or the UI would open showing
      // a model different from the one a fresh user actually gets.
      expect(SUGGESTED_MODELS[p]).toContain(DEFAULT_MODEL[p]);
    }
  });

  test("isProvider accepts exactly the known ids", () => {
    for (const p of PROVIDERS) expect(isProvider(p)).toBe(true);
    expect(isProvider("gpt")).toBe(false);
    expect(isProvider(undefined)).toBe(false);
    expect(isProvider(null)).toBe(false);
  });
});

describe("provider request budgets", () => {
  test("the larger resume-import budget is scoped to Gemini", () => {
    expect(resumeImportOutputTokens("gemini", "gemini-flash-lite-latest")).toBe(32_768);
    expect(resumeImportOutputTokens("gemini", "custom-gemini-model")).toBeUndefined();
    expect(resumeImportOutputTokens("anthropic", "claude-sonnet-5")).toBeUndefined();
    expect(resumeImportOutputTokens("openai", "gpt-5.1")).toBeUndefined();
    expect(
      resumeImportOutputTokens("openrouter", "google/gemini-2.5-flash-lite"),
    ).toBeUndefined();
  });

  test("a caller can raise Gemini's output budget for structured imports", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "{}" }] } }],
        }),
        { status: 200 },
      ),
    );
    try {
      await callModel("gemini", {
        model: "gemini-flash-lite-latest",
        system: "system",
        user: "user",
        apiKey: "test-key",
        maxOutputTokens: 32_768,
      });

      const request = fetchMock.mock.calls[0][1];
      const body = JSON.parse(String(request?.body)) as {
        generationConfig: { maxOutputTokens: number };
      };
      expect(body.generationConfig.maxOutputTokens).toBe(32_768);
    } finally {
      fetchMock.mockRestore();
    }
  });

  test.each([
    [
      "gemini" as const,
      {
        candidates: [
          {
            finishReason: "MAX_TOKENS",
            content: { parts: [{ text: "{" }] },
          },
        ],
      },
    ],
    [
      "anthropic" as const,
      {
        stop_reason: "max_tokens",
        content: [{ type: "text", text: "{" }],
      },
    ],
    [
      "openai" as const,
      {
        choices: [
          {
            finish_reason: "length",
            message: { content: "{" },
          },
        ],
      },
    ],
  ])("%s reports output truncation before JSON validation", async (provider, response) => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    try {
      await expect(
        callModel(provider, {
          model: "test-model",
          system: "system",
          user: "user",
          apiKey: "test-key",
        }),
      ).rejects.toThrow(/output|token|length/i);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
