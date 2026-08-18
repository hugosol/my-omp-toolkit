/**
 * ChatGPT/Codex weekly usage — request-scoped Codex usage provider integration.
 *
 * The active usage fetch reuses OMP's public Codex usage provider, OAuth access
 * APIs, rate-limit header parser, and provider proxy wrapper. Proxy discovery is
 * limited to `PI_PROXY_OPENAI_CODEX`, then `PI_PROXY`; missing configuration is
 * rendered as an explicit widget error and never falls back to a direct request.
 */

import type { ChatGPTUsageState } from "./tracker-state";

const CODEX_PROVIDER = "openai-codex";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const USAGE_TIMEOUT_MS = 10_000;

interface AccountLike {
  position: number;
  accountId?: string;
  email?: string;
}

interface OAuthAccessOkLike {
  ok: true;
  accessToken: string;
  accountId?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
}

interface OAuthAccessFailLike {
  ok: false;
  error: string;
}

type OAuthAccessLike = OAuthAccessOkLike | OAuthAccessFailLike;

interface AuthStorageLike {
  listOAuthAccounts(provider: string, sessionId?: string): AccountLike[];
  getOAuthAccessAt(
    provider: string,
    position: number,
    options?: { signal?: AbortSignal },
  ): Promise<OAuthAccessLike | undefined>;
}

interface UsageFetchContextLike {
  modelRegistry: { authStorage: AuthStorageLike };
  sessionManager: { getSessionId(): string | undefined };
}

interface UsageLimitLike {
  id: string;
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

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface OmpUsageModules {
  openaiCodexUsageProvider: {
    fetchUsage(
      params: unknown,
      ctx: { fetch: FetchLike; logger?: unknown },
    ): Promise<UsageReportLike | null>;
  };
  parseCodexRateLimitHeaders(headers: Record<string, string>, now?: number): UsageReportLike | null;
  wrapFetchForProxy(fetchImpl: FetchLike, provider: string): FetchLike;
  getProxyForProvider?(provider: string): string | undefined;
}

/** True when the current model is a ChatGPT/Codex OAuth model. */
export function isOpenAICodexModel(model: { provider?: string } | undefined): boolean {
  return model?.provider === CODEX_PROVIDER;
}

async function loadOmpUsageModules(): Promise<OmpUsageModules> {
  const [ai, proxy] = await Promise.all([
    import("@oh-my-pi/pi-ai"),
    import("@oh-my-pi/pi-ai/utils/proxy"),
  ]);
  const aiModules = ai as {
    openaiCodexUsageProvider?: OmpUsageModules["openaiCodexUsageProvider"];
    parseCodexRateLimitHeaders?: OmpUsageModules["parseCodexRateLimitHeaders"];
  };
  const proxyModules = proxy as {
    wrapFetchForProxy?: OmpUsageModules["wrapFetchForProxy"];
    getProxyForProvider?: OmpUsageModules["getProxyForProvider"];
  };
  if (
    !aiModules.openaiCodexUsageProvider?.fetchUsage ||
    typeof aiModules.parseCodexRateLimitHeaders !== "function" ||
    typeof proxyModules.wrapFetchForProxy !== "function"
  ) {
    throw new Error("incompatible OMP version");
  }
  return {
    openaiCodexUsageProvider: aiModules.openaiCodexUsageProvider,
    parseCodexRateLimitHeaders: aiModules.parseCodexRateLimitHeaders,
    wrapFetchForProxy: proxyModules.wrapFetchForProxy,
    getProxyForProvider: proxyModules.getProxyForProvider,
  };
}

let ompModuleLoader: () => Promise<OmpUsageModules> = loadOmpUsageModules;

/** Test seam: replace the dynamic OMP module loader. Pass null to restore. */
export function __setOmpModuleLoaderForTest(loader: (() => Promise<OmpUsageModules>) | null): void {
  ompModuleLoader = loader ?? loadOmpUsageModules;
}

function readProviderProxy(): string | undefined {
  return process.env.PI_PROXY_OPENAI_CODEX || process.env.PI_PROXY || undefined;
}

function errorState(kind: ChatGPTUsageState["kind"], error: string): ChatGPTUsageState {
  return { kind, usedPercent: null, resetsAt: null, fetchedAt: null, error };
}

function usageStateFromLimit(
  report: UsageReportLike,
  limit: UsageLimitLike,
  source: "api" | "header",
): ChatGPTUsageState {
  const used = limit.amount.used;
  const usedFraction = limit.amount.usedFraction;
  const usedPercent = typeof usedFraction === "number"
    ? usedFraction * 100
    : typeof used === "number"
      ? used
      : null;
  return {
    kind: "ok",
    source,
    usedPercent,
    resetsAt: limit.window?.resetsAt ?? null,
    fetchedAt: report.fetchedAt,
  };
}

/**
 * Fetch the first stored Codex OAuth account's weekly usage through the public
 * Codex usage provider, with a request-scoped provider proxy.
 */
export async function fetchChatGPTUsage(ctx: UsageFetchContextLike): Promise<ChatGPTUsageState> {
  let modules: OmpUsageModules;
  try {
    modules = await ompModuleLoader();
  } catch {
    return errorState("incompatible", "incompatible OMP version");
  }

  try {
    const auth = ctx.modelRegistry.authStorage;
    const sessionId = ctx.sessionManager.getSessionId();
    const accounts = auth.listOAuthAccounts(CODEX_PROVIDER, sessionId);
    if (!accounts || accounts.length === 0) {
      return errorState("auth", "no Codex OAuth account");
    }

    const access = await auth.getOAuthAccessAt(CODEX_PROVIDER, accounts[0].position);
    if (!access || !access.ok) {
      return errorState("auth", access && "error" in access ? access.error : "OAuth access failed");
    }

    const proxy = modules.getProxyForProvider
      ? modules.getProxyForProvider(CODEX_PROVIDER)
      : readProviderProxy();
    if (!proxy) {
      return errorState("config", "missing PI_PROXY_OPENAI_CODEX / PI_PROXY");
    }

    let capturedError: string | null = null;
    let capturedStatus: number | null = null;
    const baseFetch: FetchLike = (input, init) => fetch(input, init);
    const proxiedFetch = modules.wrapFetchForProxy(baseFetch, CODEX_PROVIDER);
    const capturingFetch: FetchLike = async (input, init) => {
      try {
        const response = await proxiedFetch(input, init);
        if (!response.ok) capturedStatus = response.status;
        return response;
      } catch (error) {
        capturedError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    };

    const report = await modules.openaiCodexUsageProvider.fetchUsage(
      {
        provider: CODEX_PROVIDER,
        credential: {
          type: "oauth",
          accessToken: access.accessToken,
          ...(access.accountId ? { accountId: access.accountId } : {}),
          ...(access.email ? { email: access.email } : {}),
          ...(access.orgId ? { orgId: access.orgId } : {}),
          ...(access.orgName ? { orgName: access.orgName } : {}),
        },
        signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
      },
      { fetch: capturingFetch },
    );

    if (!report) {
      if (capturedError) return errorState("transport", capturedError);
      if (capturedStatus !== null) return errorState("transport", `HTTP ${capturedStatus}`);
      return errorState("transport", "usage request failed");
    }

    const limit = pickWeeklyLimit(report, { accountId: access.accountId, email: access.email });
    if (!limit) {
      return { kind: "missing", source: "api", usedPercent: null, resetsAt: null, fetchedAt: report.fetchedAt };
    }
    return usageStateFromLimit(report, limit, "api");
  } catch (error) {
    return errorState("transport", error instanceof Error ? error.message : String(error));
  }
}

const WEEK_MS = 7 * DAY_MS;
const WEEK_TOLERANCE_MS = WEEK_MS * 0.05;
const MIN_WEEK_MS = WEEK_MS - WEEK_TOLERANCE_MS;
const MAX_WEEK_MS = WEEK_MS + WEEK_TOLERANCE_MS;
const WEEKLY_BAR_WIDTH = 20;
const WEEKLY_HEAVY = "\u2501"; // ━
const WEEKLY_THIN = "\u2500"; // ─
const WEEKLY_MARKER = "\u2502"; // │

/** Pick the closest 7d main-chat window for the active account. */
export function pickWeeklyLimit(
  report: UsageReportLike,
  identity?: AccountIdentityLike,
): UsageLimitLike | undefined {
  const weekly = report.limits
    .filter(limit => limit.id === "openai-codex:primary" || limit.id === "openai-codex:secondary")
    .filter(isWeeklyLimit);
  if (weekly.length === 0) return undefined;

  let candidates = weekly;
  const accountId = identity?.accountId;
  if (accountId) {
    const byAccount = weekly.filter(limit => limit.scope.accountId === accountId);
    if (byAccount.length > 0) candidates = byAccount;
  }

  return [...candidates].sort((a, b) => {
    const aDelta = Math.abs((a.window?.durationMs ?? 0) - WEEK_MS);
    const bDelta = Math.abs((b.window?.durationMs ?? 0) - WEEK_MS);
    return aDelta - bDelta;
  })[0];
}

/** A window is weekly only when its reported duration is within ±5% of 7 days. */
function isWeeklyLimit(limit: UsageLimitLike): boolean {
  const durationMs = limit.window?.durationMs;
  return (
    typeof durationMs === "number" &&
    Number.isFinite(durationMs) &&
    durationMs >= MIN_WEEK_MS &&
    durationMs <= MAX_WEEK_MS
  );
}

/** Format reset as `2d 14h (08/20 15:00)` using the local timezone. */
export function formatReset(resetsAt: number | null, now: number = Date.now()): string {
  if (!resetsAt || !Number.isFinite(resetsAt)) return "";
  const diff = resetsAt - now;
  if (diff < 0) return `0h (${formatLocalTime(resetsAt)})`;
  const days = Math.floor(diff / DAY_MS);
  const hours = Math.floor((diff % DAY_MS) / HOUR_MS);
  const countdown = days > 0 ? `${days}d ${hours}h` : `${Math.max(1, Math.ceil(diff / HOUR_MS))}h`;
  return `${countdown} (${formatLocalTime(resetsAt)})`;
}

function formatLocalTime(resetsAt: number): string {
  const date = new Date(resetsAt);
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${mm}/${dd} ${hh}:${mi}`;
}

export interface WeeklyThemeLike {
  fg(color: string, text: string): string;
}

const IDENTITY_THEME: WeeklyThemeLike = { fg: (_color, text) => text };

/**
 * Build the weekly usage widget segment, e.g.
 * `7d ━━━│━━──── 60.0% / 30.0% · resets in 4d 21h (08/23 14:00)`.
 *
 * Width fallback follows the agreed priority: full bar + reset text, no bar +
 * reset text, no bar + countdown only, minimal percentages, then ANSI-aware
 * truncation of the minimal form. The result always stays on one physical line.
 */
export function buildWeeklyUsagePart(
  usage: Pick<ChatGPTUsageState, "kind" | "usedPercent" | "resetsAt" | "error">,
  now: number = Date.now(),
  width: number = 120,
  theme: WeeklyThemeLike = IDENTITY_THEME,
): string {
  const kind = usage.kind;
  if (kind === "idle") return "";
  if (kind === "loading") return "7d … · 正在获取";
  if (kind === "incompatible") return "7d incompatible OMP version";
  if (kind === "config" || kind === "auth" || kind === "transport") {
    return `7d ${formatErrorText(usage.error ?? "")}`;
  }
  if (kind === "missing") {
    const parts = ["7d weekly limit not reported"];
    if (usage.error) parts.push(formatErrorText(usage.error));
    return parts.join(" · ");
  }

  const pct = usage.usedPercent;
  if (pct === null || !Number.isFinite(pct)) {
    const reset = buildResetText(usage.resetsAt, now);
    const parts = ["7d --%"];
    if (reset) parts.push(reset);
    if (usage.error) parts.push(formatErrorText(usage.error));
    return parts.join(" · ");
  }

  const resetState = getResetState(usage.resetsAt, now);
  const timePct = resetState.valid
    ? ((now - (usage.resetsAt! - WEEK_MS)) / WEEK_MS) * 100
    : null;
  const status = resetState.valid ? pacingColor(pct - timePct!) : "muted";
  const quotaLabel = pct.toFixed(1);
  const styledQuotaLabel = theme.fg(status, quotaLabel);
  const timeLabel = timePct === null ? "--" : timePct.toFixed(1);
  const bar = buildPacingBar(pct, timePct, status, theme);
  const resetFull = buildResetText(usage.resetsAt, now);
  const resetCountdown = resetState.valid
    ? `resets in ${formatCountdown(usage.resetsAt!, now)}`
    : null;

  const candidates = [
    `7d ${bar} ${styledQuotaLabel}% / ${timeLabel}%${resetFull ? ` · ${resetFull}` : ""}`,
    `7d ${styledQuotaLabel}% / ${timeLabel}%${resetFull ? ` · ${resetFull}` : ""}`,
    `7d ${styledQuotaLabel}% / ${timeLabel}%${resetCountdown ? ` · ${resetCountdown}` : ""}`,
    `7d ${styledQuotaLabel}% / ${timeLabel}%`,
  ];

  let selected = "";
  for (const candidate of candidates) {
    if (visibleDisplayWidth(candidate) <= width) {
      selected = candidate;
      break;
    }
  }
  if (!selected) selected = truncateToDisplayWidth(candidates[candidates.length - 1]!, width);
  if (usage.error) selected += ` · ${formatErrorText(usage.error)}`;
  return selected;
}

function getResetState(
  resetsAt: number | null | undefined,
  now: number,
): { valid: boolean; kind: "valid" | "unknown" | "expired" | "invalid" } {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) {
    return { valid: false, kind: "unknown" };
  }
  if (resetsAt < now) return { valid: false, kind: "expired" };
  if (resetsAt - now > WEEK_MS) return { valid: false, kind: "invalid" };
  return { valid: true, kind: "valid" };
}

function buildResetText(resetsAt: number | null | undefined, now: number): string | null {
  const state = getResetState(resetsAt, now);
  if (state.valid) return `resets in ${formatReset(resetsAt!, now)}`;
  if (state.kind === "unknown") return "reset unknown";
  if (state.kind === "expired") return `reset expired (${formatLocalTime(resetsAt!)})`;
  return `reset invalid (${formatLocalTime(resetsAt!)})`;
}

function formatCountdown(resetsAt: number, now: number): string {
  const diff = resetsAt - now;
  if (diff < 0) return "0h";
  const days = Math.floor(diff / DAY_MS);
  const hours = Math.floor((diff % DAY_MS) / HOUR_MS);
  return days > 0 ? `${days}d ${hours}h` : `${Math.max(1, Math.ceil(diff / HOUR_MS))}h`;
}

function pacingColor(delta: number): "text" | "success" | "warning" | "error" {
  if (delta <= 0) return "text";
  if (delta <= 15) return "success";
  if (delta <= 30) return "warning";
  return "error";
}

function buildPacingBar(
  quotaPct: number,
  timePct: number | null,
  status: string,
  theme: WeeklyThemeLike,
): string {
  const clamped = Math.min(100, Math.max(0, quotaPct));
  const quotaCells = Math.round((clamped / 100) * WEEKLY_BAR_WIDTH);
  const markerIndex = timePct === null
    ? null
    : Math.min(WEEKLY_BAR_WIDTH - 1, Math.max(0, Math.round((timePct / 100) * WEEKLY_BAR_WIDTH)));

  let result = "";
  let heavyRun = "";
  const flushHeavy = () => {
    if (heavyRun) {
      result += theme.fg(status, heavyRun);
      heavyRun = "";
    }
  };

  for (let i = 0; i < WEEKLY_BAR_WIDTH; i++) {
    if (i === markerIndex) {
      flushHeavy();
      result += WEEKLY_MARKER;
    } else if (i < quotaCells) {
      heavyRun += WEEKLY_HEAVY;
    } else {
      flushHeavy();
      result += WEEKLY_THIN;
    }
  }
  flushHeavy();
  return result;
}

/** Escape control characters into visible sequences and cap at 48 display columns. */
export function formatErrorText(message: string): string {
  const escaped = escapeControlCharacters(message);
  return truncateToDisplayWidth(escaped, 48);
}

function escapeControlCharacters(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, char => {
    switch (char) {
      case "\n": return "\\n";
      case "\r": return "\\r";
      case "\t": return "\\t";
      default: return `\\x${char.codePointAt(0)!.toString(16).padStart(2, "0")}`;
    }
  });
}

/** ANSI-aware visible terminal width used by the weekly renderer. */
export function visibleDisplayWidth(text: string): number {
  let width = 0;
  let i = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) === 0x1b) {
      i += ansiSequenceLength(text, i);
      continue;
    }
    const char = String.fromCodePoint(text.codePointAt(i)!);
    width += displayWidth(char);
    i += char.length;
  }
  return width;
}

function truncateToDisplayWidth(text: string, maxWidth: number): string {
  let width = 0;
  let result = "";
  let i = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) === 0x1b) {
      const len = ansiSequenceLength(text, i);
      result += text.slice(i, i + len);
      i += len;
      continue;
    }
    const char = String.fromCodePoint(text.codePointAt(i)!);
    const charWidth = displayWidth(char);
    if (width + charWidth > maxWidth - 1) {
      return `${result}…`;
    }
    result += char;
    width += charWidth;
    i += char.length;
  }
  return result;
}

function ansiSequenceLength(text: string, start: number): number {
  if (start + 1 >= text.length) return 1;
  const second = text.charCodeAt(start + 1);
  if (second === 0x5b) {
    let i = start + 2;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i - start + 1;
      i++;
    }
    return text.length - start;
  }
  if (second === 0x5d) {
    let i = start + 2;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code === 0x07) return i - start + 1;
      if (code === 0x1b && i + 1 < text.length && text.charCodeAt(i + 1) === 0x5c) {
        return i - start + 2;
      }
      i++;
    }
    return text.length - start;
  }
  return 2;
}

function displayWidth(char: string): number {
  const code = char.codePointAt(0)!;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/**
 * Parse Codex rate-limit headers into a weekly usage snapshot using OMP's
 * public parser and the same main-chat weekly-window selector.
 */
export async function parseChatGPTUsageHeaders(
  headers: Record<string, string>,
  now: number = Date.now(),
): Promise<ChatGPTUsageState | null> {
  let modules: OmpUsageModules;
  try {
    modules = await ompModuleLoader();
  } catch {
    return null;
  }

  try {
    const report = modules.parseCodexRateLimitHeaders(headers, now);
    if (!report) return null;
    const limit = pickWeeklyLimit(report);
    if (!limit) {
      return { kind: "missing", source: "header", usedPercent: null, resetsAt: null, fetchedAt: now };
    }
    return usageStateFromLimit(report, limit, "header");
  } catch {
    return null;
  }
}
