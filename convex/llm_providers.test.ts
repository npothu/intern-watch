import { describe, expect, test } from "vitest";
import {
  chooseLlm,
  DEFAULT_MODEL,
  isProvider,
  llmNote,
  OPERATOR_MODEL,
  OPERATOR_PROVIDER,
  PROVIDERS,
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

  test("an unknown provider string is ignored rather than trusted", () => {
    const c = chooseLlm({
      preference: { provider: "definitely-not-a-provider" },
      userKey: "sk-user",
      operatorKey: "op",
    });
    expect(c.source).toBe("operator");
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
