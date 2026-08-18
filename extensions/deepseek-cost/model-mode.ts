/**
 * Model mode classification for the DeepSeek Cost Tracker.
 *
 * The extension has three visible modes plus an inactive state:
 * - "deepseek": official DeepSeek provider with a known DeepSeek model; uses RMB billing.
 * - "codex": OpenAI Codex OAuth models; uses ChatGPT/Codex USD billing and weekly usage.
 * - "token-only": known DeepSeek model IDs served through another provider (e.g. opencode-go);
 *   shows token usage only, never RMB costs, balance, or daily accumulation.
 * - "hidden": anything else; no widget.
 */

import { priceForModel } from "./cost-calc";
import { isOpenAICodexModel } from "./chatgpt-usage";

export const DEEPSEEK_PROVIDER = "deepseek";

export type ModelMode = "deepseek" | "codex" | "token-only" | "hidden";

/** True when the current model is the official DeepSeek provider with a known DeepSeek model. */
export function isDeepSeekModel(model: { provider?: string; id?: string } | undefined): boolean {
  return model?.provider === DEEPSEEK_PROVIDER && priceForModel(model?.id) !== undefined;
}

/** True when a known DeepSeek model is served through a non-DeepSeek, non-Codex provider. */
export function isTokenOnlyDeepSeekModel(
  model: { provider?: string; id?: string } | undefined,
): boolean {
  return (
    !isDeepSeekModel(model) &&
    !isOpenAICodexModel(model) &&
    priceForModel(model?.id) !== undefined
  );
}

/** Classify the current model into one of the extension's display modes. */
export function classifyModelMode(
  model: { provider?: string; id?: string } | undefined,
): ModelMode {
  if (isOpenAICodexModel(model)) return "codex";
  if (isDeepSeekModel(model)) return "deepseek";
  if (isTokenOnlyDeepSeekModel(model)) return "token-only";
  return "hidden";
}
