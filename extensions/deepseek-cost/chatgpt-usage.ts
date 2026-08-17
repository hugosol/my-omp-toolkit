/**
 * ChatGPT/Codex weekly usage — reads the existing AuthStorage usage pipeline
 * and formats the 7-day window for the active OAuth account.
 *
 * This deliberately reuses `AuthStorage.fetchUsageReports()` (which already
 * owns OAuth refresh, per-credential caching, and `openai-codex` parsing)
 * instead of implementing a second `/backend-api/wham/usage` client.
 */

import type { ChatGPTUsageState } from "./tracker-state";

const CODEX_PROVIDER = "openai-codex";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** Minimal AuthStorage surface used by the usage fetcher. */
interface AuthStorageLike {
  getOAuthAccountIdentity(provider: string, sessionId?: string): AccountIdentityLike | undefined;
  fetchUsageReports(): Promise<UsageReportLike[] | null>;
}

interface UsageFetchContextLike {
  modelRegistry: { authStorage: AuthStorageLike };
  sessionManager: { getSessionId(): string | undefined };
}

/** True when the current model is a ChatGPT/Codex OAuth model. */
export function isOpenAICodexModel(model: { provider?: string } | undefined): boolean {
  return model?.provider === CODEX_PROVIDER;
}

/**
 * Fetch the active account's weekly ChatGPT/Codex usage snapshot.
 * Returns null when the provider is unavailable, no report exists, or no
 * 7d window can be found.
 */
export async function fetchChatGPTUsage(ctx: UsageFetchContextLike): Promise<ChatGPTUsageState | null> {
  try {
    const auth = ctx.modelRegistry.authStorage;
    const sessionId = ctx.sessionManager.getSessionId();
    const identity = auth.getOAuthAccountIdentity(CODEX_PROVIDER, sessionId);

    const reports = await auth.fetchUsageReports();
    if (!reports) return null;

    for (const report of reports) {
      if (report.provider !== CODEX_PROVIDER) continue;
      const limit = pickWeeklyLimit(report, identity);
      if (!limit) continue;
      const used = limit.amount.used;
      const usedFraction = limit.amount.usedFraction;
      const usedPercent = typeof usedFraction === "number"
        ? usedFraction * 100
        : typeof used === "number"
          ? used
          : null;
      return {
        usedPercent,
        resetsAt: limit.window?.resetsAt ?? null,
        fetchedAt: report.fetchedAt,
      };
    }
    return null;
  } catch {
    // Usage fetch is best-effort; never block the widget.
    return null;
  }
}

interface UsageLimitLike {
  scope: { accountId?: string; windowId?: string };
  window?: { id?: string; resetsAt?: number; durationMs?: number };
  amount: { used?: number; usedFraction?: number };
}

interface UsageReportLike {
  provider: string;
  fetchedAt: number;
  metadata?: Record<string, unknown>;
  limits: UsageLimitLike[];
}

interface AccountIdentityLike {
  accountId?: string;
  email?: string;
}

/** Pick the 7d limit for the active account, falling back to the first 7d limit. */
export function pickWeeklyLimit(
  report: UsageReportLike,
  identity?: AccountIdentityLike,
): UsageLimitLike | undefined {
  const weekly = report.limits.filter(isWeeklyLimit);
  if (weekly.length === 0) return undefined;

  const accountId = identity?.accountId;
  if (accountId) {
    const byAccount = weekly.find(limit => limit.scope.accountId === accountId);
    if (byAccount) return byAccount;
  }

  const email = identity?.email;
  if (email && report.metadata?.email === email) {
    return weekly[0];
  }

  return weekly[0];
}

function isWeeklyLimit(limit: UsageLimitLike): boolean {
  if (limit.scope.windowId === "7d" || limit.window?.id === "7d") return true;
  const durationMs = limit.window?.durationMs;
  if (typeof durationMs === "number" && durationMs > 0) {
    const days = durationMs / DAY_MS;
    return days >= 6.5 && days <= 7.5;
  }
  return false;
}

/** Format reset as `2d14h (08/20 15:00)` using the local timezone. */
export function formatReset(resetsAt: number | null, now: number = Date.now()): string {
  if (!resetsAt) return "";
  const diff = Math.max(0, resetsAt - now);
  const days = Math.floor(diff / DAY_MS);
  const hours = Math.floor((diff % DAY_MS) / HOUR_MS);
  const countdown = diff <= 0 ? "0h" : days > 0 ? `${days}d${hours}h` : `${Math.max(1, Math.ceil(diff / HOUR_MS))}h`;

  const date = new Date(resetsAt);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${countdown} (${mm}/${dd} ${hh}:${mi})`;
}

/** Build the weekly usage widget segment, e.g. `7d 34% · 重置 2d14h (08/20 15:00)`. */
export function buildWeeklyUsagePart(
  usage: Pick<ChatGPTUsageState, "usedPercent" | "resetsAt">,
  now: number = Date.now(),
): string {
  if (usage.usedPercent === null && !usage.resetsAt) return "";
  const pct = usage.usedPercent === null ? "--" : `${Math.round(usage.usedPercent)}`;
  const reset = usage.resetsAt ? ` · 重置 ${formatReset(usage.resetsAt, now)}` : "";
  return `7d ${pct}%${reset}`;
}

/**
 * Parse Codex secondary-window rate-limit headers into a weekly usage snapshot.
 * This mirrors the OMP provider parser so the widget can absorb live response
 * headers without an extra `/wham/usage` fetch.
 */
export function parseChatGPTUsageHeaders(
  headers: Record<string, string>,
  now: number = Date.now(),
): ChatGPTUsageState | null {
  const rawPercent = Number(headers["x-codex-secondary-used-percent"]);
  if (!Number.isFinite(rawPercent)) return null;
  const usedPercent = Math.min(100, Math.max(0, rawPercent));

  const rawResetAt = Number(headers["x-codex-secondary-reset-at"]);
  let resetsAt: number | null = null;
  if (Number.isFinite(rawResetAt)) {
    resetsAt = rawResetAt > 1_000_000_000_000 ? rawResetAt : rawResetAt * 1000;
  }

  return { usedPercent, resetsAt, fetchedAt: now };
}
