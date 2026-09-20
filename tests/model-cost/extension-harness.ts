/**
 * Mounted-extension test harness, shared by the model-cost suites: it mounts
 * the real extension against a fake ExtensionAPI, installs the fake Codex
 * module loader, builds context factories (one with an injectable clock), fires
 * lifecycle events and commands, captures the widget component factory and
 * renders it at a chosen width, and substitutes the archive home for a
 * temporary directory.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import modelCost from "../../extensions/model-cost/index";
import { __setOmpModuleLoaderForTest } from "../../extensions/model-cost/chatgpt-usage";

export type EventHandler = (event: unknown, ctx: unknown) => unknown;
export type CommandHandler = (args: string, ctx: unknown) => unknown;

/** A callback armed through `ctx.setTimeout`, with the clock time it is due at. */
export interface ScheduledTimer {
  id: number;
  at: number;
  fn: () => void | Promise<void>;
}

export function mountExtension() {
  const handlers = new Map<string, EventHandler>();
  const commands = new Map<string, CommandHandler>();
  const api = {
    setLabel() {},
    registerCommand(name: string, command: { handler: CommandHandler }) {
      commands.set(name, command.handler);
    },
    on(event: string, handler: EventHandler) {
      handlers.set(event, handler);
    },
  };
  modelCost(api as Parameters<typeof modelCost>[0]);
  return { commands, handlers };
}

export function installFakeCodexModules(overrides: {
  fetchUsage?: () => Promise<unknown>;
  parseRateLimitHeaders?: (headers: Record<string, string>, now?: number) => unknown;
} = {}) {
  __setOmpModuleLoaderForTest(async () => ({
    openaiCodexUsageProvider: {
      fetchUsage: overrides.fetchUsage ?? (async () => null),
    },
    parseCodexRateLimitHeaders: overrides.parseRateLimitHeaders ?? (() => null),
    wrapFetchForProxy: (fetchImpl: unknown) => fetchImpl,
    getProxyForProvider: () => process.env.PI_PROXY_OPENAI_CODEX || process.env.PI_PROXY,
  }));
}

export function codexContext(overrides: {
  accounts?: Array<{ position: number; accountId?: string; email?: string }>;
  access?: { ok: true; accessToken: string; accountId?: string; email?: string } | { ok: false; error: string };
} = {}) {
  const widgetCalls: Array<string[] | undefined> = [];
  const widgetContents: Array<unknown> = [];
  const notifyCalls: Array<{ message: string; type?: string }> = [];
  const authStorage = {
    listOAuthAccounts: () => overrides.accounts ?? [{ position: 0, accountId: "acct-1", email: "u@example.com" }],
    getOAuthAccessAt: async () => overrides.access ?? { ok: true, accessToken: "token-1", accountId: "acct-1", email: "u@example.com" },
    fetchUsageReports: async () => { throw new Error("aggregate usage must not be called"); },
  };
  const ctx = {
    hasUI: true,
    model: { id: "gpt-5.4", provider: "openai-codex" },
    sessionManager: {
      getSessionId: () => "s1",
      getSessionName: () => "test",
      getUsageStatistics: () => ({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        orchestrationInput: 0,
        orchestrationCacheRead: 0,
        orchestrationOutput: 0,
        totalTokens: 0,
      }),
    },
    modelRegistry: { authStorage },
    getContextUsage: () => ({ tokens: 136_000 }),
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setWidget: (_key: string, content: unknown) => {
        widgetContents.push(content);
        if (typeof content === "function") {
          const component = (content as (tui: unknown, theme: { fg: (color: string, text: string) => string }) => { render(width: number): string[] })(
            {},
            { fg: (_color: string, text: string) => text },
          );
          widgetCalls.push(component.render(120));
        } else {
          widgetCalls.push(content as string[] | undefined);
        }
      },
      notify(message: string, type?: string) {
        notifyCalls.push({ message, type });
      },
    },
    cwd: "C:/tmp",
    setTimeout: () => 1,
    clearTimer() {},
  };
  return { ctx, notifyCalls, widgetCalls, widgetContents };
}

/** A Codex usage report carrying the 5h and 7d windows the extension consumes. */
export function weeklyReport(usedPercent = 34, resetsAt = Date.now() + 24 * 60 * 60 * 1000) {
  const fiveHourResetsAt = Date.now() + 2 * 60 * 60 * 1000;
  return {
    provider: "openai-codex",
    fetchedAt: 123,
    limits: [{
      id: "openai-codex:primary",
      scope: { accountId: "acct-1", windowId: "5h" },
      window: { id: "5h", durationMs: 5 * 60 * 60 * 1000, resetsAt: fiveHourResetsAt },
      amount: { used: 12, limit: 100, usedFraction: 0.12, unit: "percent" },
    }, {
      id: "openai-codex:secondary",
      scope: { accountId: "acct-1", windowId: "7d" },
      window: { id: "7d", durationMs: 7 * 24 * 60 * 60 * 1000, resetsAt },
      amount: { used: usedPercent, limit: 100, usedFraction: usedPercent / 100, unit: "percent" },
    }],
  };
}

export interface ExtensionContextOptions {
  /** Clock the scheduled deadlines are measured against; defaults to `Date.now`. */
  now?: () => number;
  /** Provider resolver exposed as `ctx.modelRegistry.resolver`. */
  resolver?: (provider: string) => unknown;
}

export function extensionContext(
  tokens: number,
  model = { id: "gpt-5.4", provider: "openai-codex" },
  options: ExtensionContextOptions = {},
) {
  const widgetCalls: Array<string[] | undefined> = [];
  const widgetContents: Array<unknown> = [];
  const notifyCalls: Array<{ message: string; type?: string }> = [];
  const timers: ScheduledTimer[] = [];
  let nextTimerId = 1;
  const now = options.now ?? (() => Date.now());
  const ctx = {
    hasUI: true,
    model,
    sessionManager: {
      getSessionId: () => "s1",
      getSessionName: () => "test",
      getUsageStatistics: () => ({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        orchestrationInput: 0,
        orchestrationCacheRead: 0,
        orchestrationOutput: 0,
        totalTokens: 0,
      }),
    },
    getContextUsage: () => ({ tokens }),
    modelRegistry: {
      resolver: options.resolver ?? (async () => undefined),
      getProviderBaseUrl: () => undefined,
    },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setWidget: (_key: string, content: unknown) => {
        widgetContents.push(content);
        if (typeof content === "function") {
          const component = (content as (tui: unknown, theme: { fg: (color: string, text: string) => string }) => { render(width: number): string[] })(
            {},
            { fg: (_color: string, text: string) => text },
          );
          widgetCalls.push(component.render(120));
        } else {
          widgetCalls.push(content as string[] | undefined);
        }
      },
      notify(message: string, type?: string) {
        notifyCalls.push({ message, type });
      },
    },
    setTimeout(fn: () => void | Promise<void>, ms?: number) {
      const id = nextTimerId++;
      timers.push({ id, at: now() + (ms ?? 0), fn });
      return id;
    },
    clearTimer(id: number) {
      const index = timers.findIndex(t => t.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
  };
  return { ctx, notifyCalls, widgetCalls, widgetContents, timers };
}

export function fire(handlers: Map<string, EventHandler>, event: string, ctx: unknown): unknown {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`handler not registered: ${event}`);
  return handler({}, ctx);
}

export function fireWithPayload(
  handlers: Map<string, EventHandler>,
  event: string,
  payload: unknown,
  ctx: unknown,
): unknown {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`handler not registered: ${event}`);
  return handler(payload, ctx);
}

export function runCommand(
  commands: Map<string, CommandHandler>,
  name: string,
  args: string,
  ctx: unknown,
): unknown {
  const handler = commands.get(name);
  if (!handler) throw new Error(`command not registered: ${name}`);
  return handler(args, ctx);
}

export function renderLastWidget(
  widgetContents: unknown[],
  width: number,
  theme: { fg: (color: string, text: string) => string } = { fg: (_color, text) => text },
): string[] {
  const content = widgetContents[widgetContents.length - 1];
  if (typeof content !== "function") throw new Error("last widget content is not a component factory");
  const factory = content as (tui: unknown, theme: { fg: (color: string, text: string) => string }) => {
    render(width: number): string[];
  };
  return factory({}, theme).render(width);
}

/** Run `run` with HOME/USERPROFILE pointing at a fresh temporary directory. */
export async function withTemporaryHome<T>(run: () => T | Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "model-cost-extension-test-"));
  process.env.HOME = temporaryHome;
  process.env.USERPROFILE = temporaryHome;
  try {
    return await run();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  }
}

export async function flushPromises(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await Promise.resolve();
  }
}
