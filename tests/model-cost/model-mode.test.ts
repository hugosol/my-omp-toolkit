import { describe, expect, test } from "bun:test";
import {
  classifyModelMode,
  isDeepSeekModel,
  isTokenOnlyDeepSeekModel,
} from "../../extensions/model-cost/model-mode";
import { priceForModel } from "../../extensions/model-cost/cost-calc";

describe("classifyModelMode", () => {
  test("classifies official DeepSeek provider with known DeepSeek model as deepseek", () => {
    expect(classifyModelMode({ id: "deepseek-v4-pro", provider: "deepseek" })).toBe("deepseek");
    expect(classifyModelMode({ id: "deepseek-v4-flash", provider: "deepseek" })).toBe("deepseek");
  });

  test("treats deepseek-v4-flash-vision-exp as flash only on official DeepSeek provider", () => {
    expect(priceForModel("deepseek-v4-flash-vision-exp")).toEqual({
      peak: { input: 3, cacheRead: 0.1, output: 9 },
      offPeak: { input: 1.5, cacheRead: 0.05, output: 4.5 },
    });
    expect(classifyModelMode({ id: "deepseek-v4-flash-vision-exp", provider: "deepseek" })).toBe("deepseek");
    expect(classifyModelMode({ id: "deepseek-v4-flash-vision-exp", provider: "opencode-go" })).toBe("hidden");
  });

  test("classifies openai-codex provider as codex regardless of model id", () => {
    expect(classifyModelMode({ id: "gpt-5.4", provider: "openai-codex" })).toBe("codex");
  });

  test("classifies a known DeepSeek model on a non-DeepSeek provider as token-only", () => {
    expect(classifyModelMode({ id: "deepseek-v4-flash", provider: "opencode-go" })).toBe("token-only");
    expect(classifyModelMode({ id: "deepseek-v4-pro", provider: "nvidia" })).toBe("token-only");
  });

  test("classifies unknown models and undefined model as hidden", () => {
    expect(classifyModelMode({ id: "claude-sonnet", provider: "anthropic" })).toBe("hidden");
    expect(classifyModelMode({ id: "kimi-k2", provider: "opencode-go" })).toBe("hidden");
    expect(classifyModelMode(undefined)).toBe("hidden");
  });
});

describe("isDeepSeekModel", () => {
  test("is true only for official DeepSeek provider with a known DeepSeek model", () => {
    expect(isDeepSeekModel({ id: "deepseek-v4-pro", provider: "deepseek" })).toBe(true);
    expect(isDeepSeekModel({ id: "deepseek-v4-flash", provider: "opencode-go" })).toBe(false);
    expect(isDeepSeekModel({ id: "deepseek-v4-pro", provider: "deepseek" })).toBe(true);
  });

  test("is false for unknown DeepSeek provider model ids", () => {
    expect(isDeepSeekModel({ id: "unknown-model", provider: "deepseek" })).toBe(false);
  });
});

describe("isTokenOnlyDeepSeekModel", () => {
  test("is true for known DeepSeek models on non-DeepSeek, non-Codex providers", () => {
    expect(isTokenOnlyDeepSeekModel({ id: "deepseek-v4-flash", provider: "opencode-go" })).toBe(true);
  });

  test("is false for official DeepSeek, Codex, and unknown models", () => {
    expect(isTokenOnlyDeepSeekModel({ id: "deepseek-v4-pro", provider: "deepseek" })).toBe(false);
    expect(isTokenOnlyDeepSeekModel({ id: "gpt-5.4", provider: "openai-codex" })).toBe(false);
    expect(isTokenOnlyDeepSeekModel({ id: "kimi-k2", provider: "opencode-go" })).toBe(false);
  });
});
