import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import modelCost from "../../extensions/model-cost/index";
import { __setOmpModuleLoaderForTest } from "../../extensions/model-cost/chatgpt-usage";
import { installInProcessFileLock } from "./test-lock";

installInProcessFileLock();

type EventHandler = (event: unknown, ctx: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => unknown;

function mountExtension() {
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

function installFakeCodexModules(overrides: {
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

function codexContext(overrides: {
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

function weeklyReport(usedPercent = 34, resetsAt = Date.now() + 24 * 60 * 60 * 1000) {
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

afterEach(() => {
  __setOmpModuleLoaderForTest(null);
  delete process.env.PI_PROXY_OPENAI_CODEX;
  delete process.env.PI_PROXY;
});

function extensionContext(
  tokens: number,
  model = { id: "gpt-5.4", provider: "openai-codex" },
) {
  const widgetCalls: Array<string[] | undefined> = [];
  const widgetContents: Array<unknown> = [];
  const notifyCalls: Array<{ message: string; type?: string }> = [];
  const timers: Array<() => void | Promise<void>> = [];
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
      resolver: () => undefined,
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
    setTimeout(fn: () => void | Promise<void>) {
      timers.push(fn);
      return timers.length;
    },
    clearTimer() {},
  };
  return { ctx, notifyCalls, widgetCalls, widgetContents, timers };
}

function fire(handlers: Map<string, EventHandler>, event: string, ctx: unknown): unknown {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`handler not registered: ${event}`);
  return handler({}, ctx);
}

function fireWithPayload(
  handlers: Map<string, EventHandler>,
  event: string,
  payload: unknown,
  ctx: unknown,
): unknown {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`handler not registered: ${event}`);
  return handler(payload, ctx);
}

function runCommand(
  commands: Map<string, CommandHandler>,
  name: string,
  args: string,
  ctx: unknown,
): unknown {
  const handler = commands.get(name);
  if (!handler) throw new Error(`command not registered: ${name}`);
  return handler(args, ctx);
}

function renderLastWidget(
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

async function withTemporaryHome<T>(run: () => T | Promise<T>): Promise<T> {
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

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await Promise.resolve();
  }
}

describe("model-cost extension", () => {
  test("ChatGPT mode renders a fixed 272K context budget", () => {
    const { handlers } = mountExtension();
    const { ctx, widgetCalls } = extensionContext(136_000);

    fire(handlers, "agent_start", ctx);

    expect(widgetCalls[widgetCalls.length - 1]?.[0]).toContain("(136.0K/272.0K)");
  });

  test("DeepSeek mode renders a default 450K context budget", async () => {
    await withTemporaryHome(() => {
      const { handlers } = mountExtension();
      const { ctx, widgetCalls } = extensionContext(
        225_000,
        { id: "deepseek-v4-pro", provider: "deepseek" },
      );

      fire(handlers, "agent_start", ctx);

      expect(widgetCalls[widgetCalls.length - 1]?.[0]).toContain("(225.0K/450.0K)");
    });
  });

  test("ChatGPT mode rejects budget overrides without preconfiguring DeepSeek", async () => {
    await withTemporaryHome(async () => {
      const { commands, handlers } = mountExtension();
      const chatGPT = extensionContext(136_000);

      await runCommand(commands, "budget", "300K", chatGPT.ctx);

      const deepSeek = extensionContext(
        225_000,
        { id: "deepseek-v4-flash", provider: "deepseek" },
      );
      fire(handlers, "agent_start", deepSeek.ctx);

      expect({
        notification: chatGPT.notifyCalls[chatGPT.notifyCalls.length - 1],
        deepSeekDefaultPreserved: deepSeek.widgetCalls[
          deepSeek.widgetCalls.length - 1
        ]?.[0]?.includes("(225.0K/450.0K)"),
      }).toEqual({
        notification: {
          message: "ChatGPT context budget is fixed at 272.0K.",
          type: "warning",
        },
        deepSeekDefaultPreserved: true,
      });
    });
  });

  test("unsupported models reject budget overrides without preconfiguring DeepSeek", async () => {
    await withTemporaryHome(async () => {
      const { commands, handlers } = mountExtension();
      const unsupported = extensionContext(
        100_000,
        { id: "claude-sonnet", provider: "anthropic" },
      );

      await runCommand(commands, "budget", "300K", unsupported.ctx);

      const deepSeek = extensionContext(
        225_000,
        { id: "deepseek-v4-pro", provider: "deepseek" },
      );
      fire(handlers, "agent_start", deepSeek.ctx);

      expect({
        notification: unsupported.notifyCalls[unsupported.notifyCalls.length - 1],
        deepSeekDefaultPreserved: deepSeek.widgetCalls[
          deepSeek.widgetCalls.length - 1
        ]?.[0]?.includes("(225.0K/450.0K)"),
      }).toEqual({
        notification: {
          message: "Context budget can only be changed in DeepSeek mode.",
          type: "warning",
        },
        deepSeekDefaultPreserved: true,
      });
    });
  });

  test("DeepSeek mode accepts a custom context budget", async () => {
    await withTemporaryHome(async () => {
      const { commands } = mountExtension();
      const deepSeek = extensionContext(
        150_000,
        { id: "deepseek-v4-pro", provider: "deepseek" },
      );

      await runCommand(commands, "budget", "300", deepSeek.ctx);

      expect(deepSeek.widgetCalls[
        deepSeek.widgetCalls.length - 1
      ]?.[0]).toContain("(150.0K/300.0K)");
    });
  });

  test("zero resets a DeepSeek override to the 450K default", async () => {
    await withTemporaryHome(async () => {
      const { commands } = mountExtension();
      const deepSeek = extensionContext(
        225_000,
        { id: "deepseek-v4-pro", provider: "deepseek" },
      );

      await runCommand(commands, "budget", "300K", deepSeek.ctx);
      await runCommand(commands, "budget", "0", deepSeek.ctx);

      expect(deepSeek.widgetCalls[
        deepSeek.widgetCalls.length - 1
      ]?.[0]).toContain("(225.0K/450.0K)");
    });
  });

  test("DeepSeek budget values above 1000K are silently clamped", async () => {
    await withTemporaryHome(async () => {
      const { commands } = mountExtension();
      const deepSeek = extensionContext(
        500_000,
        { id: "deepseek-v4-pro", provider: "deepseek" },
      );

      await runCommand(commands, "budget", "1200K", deepSeek.ctx);

      expect({
        notification: deepSeek.notifyCalls[deepSeek.notifyCalls.length - 1],
        widgetUsesClampedBudget: deepSeek.widgetCalls[
          deepSeek.widgetCalls.length - 1
        ]?.[0]?.includes("(500.0K/1,000.0K)"),
      }).toEqual({
        notification: { message: "Budget: 1,000.0K", type: "info" },
        widgetUsesClampedBudget: true,
      });
    });
  });

  test("low context usage renders exactly twenty empty bar cells", () => {
    const { handlers } = mountExtension();
    const chatGPT = extensionContext(1);

    fire(handlers, "agent_start", chatGPT.ctx);

    const firstLine = chatGPT.widgetCalls[chatGPT.widgetCalls.length - 1]?.[0];
    const cells = firstLine?.match(/\[([█░]+)\s/)?.[1];
    expect(cells).toBe("░".repeat(20));
  });

  test("ChatGPT session start shows weekly usage and reset time", async () => {
    process.env.PI_PROXY = "http://generic-proxy";
    installFakeCodexModules({ fetchUsage: async () => weeklyReport(34) });
    const { handlers } = mountExtension();
    const { ctx, widgetCalls } = codexContext();

    await fire(handlers, "session_start", ctx);

    const last = widgetCalls[widgetCalls.length - 1] ?? [];
    expect(last.join("\n")).toContain("34.0%");
    expect(last.join("\n")).toContain("resets in");
  });
});

describe("model-cost Codex usage lifecycle", () => {
  test("session_start starts one refresh and renders loading first", async () => {
    let calls = 0;
    installFakeCodexModules({
      fetchUsage: async () => {
        calls += 1;
        return weeklyReport();
      },
    });
    process.env.PI_PROXY = "http://generic-proxy";
    const { handlers } = mountExtension();
    const { ctx, widgetCalls } = codexContext();

    await fire(handlers, "session_start", ctx);

    expect(calls).toBe(1);
    expect(widgetCalls.some(lines => lines?.some(line => line.includes("正在获取")))).toBe(true);
    const last = widgetCalls[widgetCalls.length - 1] ?? [];
    expect(last.join("\n")).toContain("34.0%");
  });

  test("agent_start starts one active usage request", async () => {
    let calls = 0;
    installFakeCodexModules({
      fetchUsage: async () => {
        calls += 1;
        return weeklyReport();
      },
    });
    process.env.PI_PROXY = "http://generic-proxy";
    const { handlers } = mountExtension();
    const { ctx } = codexContext();

    await fire(handlers, "agent_start", ctx);

    expect(calls).toBe(1);
  });

  test("agent_end starts one refresh per completed turn", async () => {
    let calls = 0;
    installFakeCodexModules({
      fetchUsage: async () => {
        calls += 1;
        return weeklyReport();
      },
    });
    process.env.PI_PROXY = "http://generic-proxy";
    const { handlers } = mountExtension();
    const { ctx } = codexContext();

    await fire(handlers, "session_start", ctx);
    await fire(handlers, "agent_end", ctx);

    expect(calls).toBe(2);
  });

  test("overlapping triggers share one in-flight request without trailing call", async () => {
    let calls = 0;
    const { promise: pending, resolve: resolveFetch } = Promise.withResolvers<unknown>();
    installFakeCodexModules({
      fetchUsage: () => {
        calls += 1;
        return pending;
      },
    });
    process.env.PI_PROXY = "http://generic-proxy";
    const { handlers } = mountExtension();
    const { ctx } = codexContext();

    const sessionStart = fire(handlers, "session_start", ctx);
    const agentEnd = fire(handlers, "agent_end", ctx);
    resolveFetch(weeklyReport());
    await sessionStart;
    await agentEnd;

    expect(calls).toBe(1);
  });

  test("after_provider_response updates both 5h and 7d from headers", async () => {
    process.env.PI_PROXY = "http://generic-proxy";
    installFakeCodexModules({
      fetchUsage: async () => weeklyReport(34),
      parseRateLimitHeaders: (_headers: Record<string, string>, now = Date.now()) => ({
        provider: "openai-codex",
        fetchedAt: now,
        limits: [{
          id: "openai-codex:primary",
          scope: { accountId: "acct-1", windowId: "5h" },
          window: { id: "5h", durationMs: 5 * 60 * 60 * 1000, resetsAt: 1_800_000_000_000 },
          amount: { used: 20, limit: 100, usedFraction: 0.2, unit: "percent" },
        }, {
          id: "openai-codex:secondary",
          scope: { accountId: "acct-1", windowId: "7d" },
          window: { id: "7d", durationMs: 7 * 24 * 60 * 60 * 1000, resetsAt: 1_800_100_000_000 },
          amount: { used: 55, limit: 100, usedFraction: 0.55, unit: "percent" },
        }],
      }),
    });
    const { handlers } = mountExtension();
    const { ctx, widgetCalls } = codexContext();

    await fire(handlers, "session_start", ctx);
    await fireWithPayload(
      handlers,
      "after_provider_response",
      { headers: {} },
      ctx,
    );

    const last = widgetCalls[widgetCalls.length - 1] ?? [];
    expect(last.join("\n")).toContain("5h");
    expect(last.join("\n")).toContain("20.0%");
    expect(last.join("\n")).toContain("7d");
    expect(last.join("\n")).toContain("55.0%");
  });

  test("message_end does not start an active usage request", async () => {
    let calls = 0;
    installFakeCodexModules({
      fetchUsage: async () => {
        calls += 1;
        return weeklyReport();
      },
    });
    process.env.PI_PROXY = "http://generic-proxy";
    const { handlers } = mountExtension();
    const { ctx } = codexContext();

    await fire(handlers, "session_start", ctx);
    const before = calls;
    await fire(handlers, "message_end", { message: { usage: { input: 1, cacheRead: 0, output: 0 } } }, ctx);
    expect(calls).toBe(before);
  });

  test("active failure clears API data but preserves header data", async () => {
    let fail = false;
    installFakeCodexModules({
      fetchUsage: async () => (fail ? null : weeklyReport(34)),
      parseRateLimitHeaders: (headers: Record<string, string>, now = Date.now()) => {
        const usedPercent = Number(headers["x-codex-primary-used-percent"]);
        if (!Number.isFinite(usedPercent)) return null;
        return {
          provider: "openai-codex",
          fetchedAt: now,
          limits: [{
            id: "openai-codex:primary",
            scope: { accountId: "acct-1", windowId: "7d" },
            window: { id: "7d", durationMs: 7 * 24 * 60 * 60 * 1000, resetsAt: 1_800_000_000_000 },
            amount: { used: usedPercent, limit: 100, usedFraction: usedPercent / 100, unit: "percent" },
          }],
        };
      },
    });
    process.env.PI_PROXY = "http://generic-proxy";
    const { handlers } = mountExtension();
    const { ctx, widgetCalls } = codexContext();

    await fire(handlers, "session_start", ctx);
    fireWithPayload(
      handlers,
      "after_provider_response",
      { headers: { "x-codex-primary-used-percent": "50", "x-codex-primary-window-minutes": "10080" } },
      ctx,
    );
    fail = true;
    await fire(handlers, "agent_end", ctx);

    const last = widgetCalls[widgetCalls.length - 1] ?? [];
    expect(last.join("\n")).toContain("50.0%");
    expect(last.join("\n")).toContain("usage request failed");
  });

  test("missing proxy renders config error without notification", async () => {
    installFakeCodexModules({});
    const { handlers } = mountExtension();
    const { ctx, notifyCalls, widgetCalls } = codexContext();

    await fire(handlers, "session_start", ctx);

    const last = widgetCalls[widgetCalls.length - 1] ?? [];
    expect(last.join("\n")).toContain("PI_PROXY_OPENAI_CODEX");
    expect(notifyCalls.length).toBe(0);
  });

  test("incompatible OMP version renders in widget and keeps extension mounted", async () => {
    __setOmpModuleLoaderForTest(async () => {
      throw new Error("Cannot find package");
    });
    const { handlers } = mountExtension();
    const { ctx, widgetCalls } = codexContext();

    await fire(handlers, "session_start", ctx);

    expect(widgetCalls.some(lines => lines?.some(line => line.includes("incompatible OMP version")))).toBe(true);
  });

  test("successful refresh clears prior transport error", async () => {
    let fail = true;
    installFakeCodexModules({
      fetchUsage: async () => (fail ? null : weeklyReport(34)),
    });
    process.env.PI_PROXY = "http://generic-proxy";
    const { handlers } = mountExtension();
    const { ctx, widgetCalls } = codexContext();

    await fire(handlers, "session_start", ctx);
    fail = false;
    await fire(handlers, "agent_end", ctx);

    const last = widgetCalls[widgetCalls.length - 1] ?? [];
    expect(last.join("\n")).toContain("34.0%");
    expect(last.join("\n")).not.toContain("usage request failed");
  });
});

describe("model-cost weekly pacing widget", () => {
  test("renders context, 5h, and 7d progress bars on separate lines", async () => {
    process.env.PI_PROXY = "http://generic-proxy";
    installFakeCodexModules({ fetchUsage: async () => weeklyReport(60) });
    const { handlers } = mountExtension();
    const { ctx, widgetContents } = codexContext();

    await fire(handlers, "session_start", ctx);

    const lines = renderLastWidget(widgetContents, 300);
    expect(lines[0]).toContain("136.0K/272.0K");
    expect(lines[0]).not.toContain("5h");
    expect(lines[0]).not.toContain("7d");
    expect(lines[1]).toContain("5h");
    expect(lines[1]).not.toContain("7d");
    expect(lines[2]).toContain("7d");
    expect(lines[2]).toContain("━");
    expect(lines[2]).toContain("60.0% /");
    expect(lines.some(line => line.includes("Total:"))).toBe(true);
  });

  test("applies semantic status color only to heavy quota glyphs and quota number", async () => {
    const WEEK = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    process.env.PI_PROXY = "http://generic-proxy";
    installFakeCodexModules({
      fetchUsage: async () => weeklyReport(40, now + WEEK * 0.7),
    });
    const { handlers } = mountExtension();
    const { ctx, widgetContents } = codexContext();
    const theme = { fg: (color: string, text: string) => `[${color}]${text}[/${color}]` };

    await fire(handlers, "session_start", ctx);

    const lines = renderLastWidget(widgetContents, 500, theme);
    expect(lines[2]).toContain("[success]━[/success]");
    expect(lines[2]).toContain("[success]40.0[/success]%");
    expect(lines[2]).not.toContain("[success]│[/success]");
    expect(lines[2]).not.toContain("[success]─[/success]");
  });

  test("drops the bar before precise percentages on narrow widths", async () => {
    process.env.PI_PROXY = "http://generic-proxy";
    installFakeCodexModules({ fetchUsage: async () => weeklyReport(60) });
    const { handlers } = mountExtension();
    const { ctx, widgetContents } = codexContext();

    await fire(handlers, "session_start", ctx);

    const wide = renderLastWidget(widgetContents, 300);
    expect(wide[2]).toContain("━");

    const narrow = renderLastWidget(widgetContents, 30);
    expect(narrow[2]).not.toContain("━");
    expect(narrow[2]).toContain("60.0% /");
    expect(narrow.length).toBe(wide.length);
  });

  test("existing redraw observes a later controlled time with a new usage request", async () => {
    const WEEK = 7 * 24 * 60 * 60 * 1000;
    const fakeNow = 1_800_000_000_000;
    let calls = 0;
    process.env.PI_PROXY = "http://generic-proxy";
    installFakeCodexModules({
      fetchUsage: async () => {
        calls += 1;
        return weeklyReport(10, fakeNow + WEEK);
      },
    });
    const { handlers } = mountExtension();
    const { ctx, widgetContents } = codexContext();
    const originalNow = Date.now;
    Date.now = () => fakeNow;
    try {
      await fire(handlers, "session_start", ctx);
      const first = renderLastWidget(widgetContents, 120);
      expect(first[2]).toContain("10.0% / 0.0%");

      Date.now = () => fakeNow + WEEK * 0.5;
      await fire(handlers, "agent_start", ctx);
      const second = renderLastWidget(widgetContents, 120);
      expect(second[2]).toContain("10.0% / 50.0%");
      expect(calls).toBe(2);
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("model-cost token-only mode", () => {
  test("opencode-go deepseek-v4-* renders token-only without RMB/balance/daily", async () => {
    await withTemporaryHome(() => {
      const { handlers } = mountExtension();
      const { ctx, widgetCalls } = extensionContext(
        225_000,
        { id: "deepseek-v4-flash", provider: "opencode-go" },
      );

      fire(handlers, "agent_start", ctx);

      const lines = widgetCalls[widgetCalls.length - 1] ?? [];
      expect(lines[0]).toContain("(225.0K/450.0K)");
      expect(lines.some(line => line.includes("Total:"))).toBe(true);
      const text = lines.join("\n");
      expect(text).not.toContain("¥");
      expect(text).not.toContain("Bal:");
      expect(text).not.toContain("Accrued:");
      expect(text).not.toContain("🔥");
      expect(text).not.toContain("🌙");
    });
  });

  test("non-DeepSeek non-Codex unknown model still hides widget", () => {
    const { handlers } = mountExtension();
    const { ctx, widgetCalls } = extensionContext(
      100_000,
      { id: "claude-sonnet", provider: "anthropic" },
    );

    fire(handlers, "agent_start", ctx);

    expect(widgetCalls[widgetCalls.length - 1]).toBeUndefined();
  });
});

describe("model-cost provider-gated billing", () => {
  test("opencode-go deepseek-v4-* does not accumulate RMB cost or daily spend", async () => {
    await withTemporaryHome(async () => {
      const { handlers } = mountExtension();
      const { ctx } = extensionContext(
        0,
        { id: "deepseek-v4-flash", provider: "opencode-go" },
      );

      fireWithPayload(handlers, "before_provider_request", {}, ctx);
      fireWithPayload(
        handlers,
        "message_end",
        { message: { usage: { input: 1_000_000, cacheRead: 0, output: 0 } } },
        ctx,
      );
      await fire(handlers, "agent_end", ctx);

      const dailyPath = path.join(process.env.HOME!, ".omp", "cost-archive", "deepseek-cost.json");
      expect(fs.existsSync(dailyPath)).toBe(false);
    });
  });
});

describe("model-cost concurrent DeepSeek CLIs", () => {
  test("two extension instances both accrue into the shared daily archive", async () => {
    await withTemporaryHome(async () => {
      function mutableDeepSeekContext(sessionId: string) {
        const stats = {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          orchestrationInput: 0,
          orchestrationCacheRead: 0,
          orchestrationOutput: 0,
          totalTokens: 0,
        };
        const { ctx } = extensionContext(
          0,
          { id: "deepseek-v4-pro", provider: "deepseek" },
        );
        ctx.sessionManager.getSessionId = () => sessionId;
        ctx.sessionManager.getSessionName = () => `cli ${sessionId}`;
        ctx.sessionManager.getUsageStatistics = () => stats;
        return { ctx, stats };
      }

      function chargeTurn(
        handlers: Map<string, EventHandler>,
        ctx: unknown,
        usage: { input: number; output: number },
      ) {
        fireWithPayload(handlers, "before_provider_request", {}, ctx);
        fireWithPayload(
          handlers,
          "message_end",
          { message: { usage: { input: usage.input, cacheRead: 0, output: usage.output } } },
          ctx,
        );
      }

      const extA = mountExtension();
      const extB = mountExtension();
      const a = mutableDeepSeekContext("session-a");
      const b = mutableDeepSeekContext("session-b");

      await fire(extA.handlers, "session_start", a.ctx);
      await fire(extB.handlers, "session_start", b.ctx);

      // CLI A finishes a turn.
      a.stats.input = 1_000_000;
      a.stats.output = 50_000;
      chargeTurn(extA.handlers, a.ctx, { input: 400_000, output: 50_000 });
      await fire(extA.handlers, "agent_end", a.ctx);

      // CLI B finishes a turn afterwards.
      b.stats.input = 2_000_000;
      b.stats.output = 100_000;
      chargeTurn(extB.handlers, b.ctx, { input: 800_000, output: 100_000 });
      await fire(extB.handlers, "agent_end", b.ctx);

      // CLI A finishes a second turn.
      a.stats.input = 1_200_000;
      a.stats.output = 70_000;
      chargeTurn(extA.handlers, a.ctx, { input: 200_000, output: 20_000 });
      await fire(extA.handlers, "agent_end", a.ctx);

      const dailyPath = path.join(process.env.HOME!, ".omp", "cost-archive", "deepseek-cost.json");
      const data = JSON.parse(fs.readFileSync(dailyPath, "utf-8")) as {
        totalCost: number;
        totalTokens: { input: number; output: number };
        sessions: Array<{ id: string; lastInput: number; lastOutput: number; cost: number }>;
      };
      expect(data.sessions).toHaveLength(2);
      const aSess = data.sessions.find(s => s.id === "session-a");
      const bSess = data.sessions.find(s => s.id === "session-b");
      expect(aSess?.cost).toBeGreaterThan(0);
      expect(bSess?.cost).toBeGreaterThan(0);
      expect(data.totalCost).toBeCloseTo((aSess?.cost ?? 0) + (bSess?.cost ?? 0), 6);
      expect(aSess?.lastInput).toBe(1_200_000);
      expect(aSess?.lastOutput).toBe(70_000);
      expect(bSess?.lastInput).toBe(2_000_000);
      expect(bSess?.lastOutput).toBe(100_000);
      expect(data.totalTokens.input).toBe(3_200_000);
      expect(data.totalTokens.output).toBe(170_000);
    });
  });
});

describe("model-cost budget provider gate", () => {
  test("opencode-go deepseek-v4-* rejects budget overrides", async () => {
    await withTemporaryHome(async () => {
      const { commands } = mountExtension();
      const opencodeGo = extensionContext(
        150_000,
        { id: "deepseek-v4-flash", provider: "opencode-go" },
      );

      await runCommand(commands, "budget", "300K", opencodeGo.ctx);

      expect(opencodeGo.notifyCalls[opencodeGo.notifyCalls.length - 1]).toEqual({
        message: "Context budget can only be changed in DeepSeek mode.",
        type: "warning",
      });
    });
  });
});

describe("model-cost input dual fetch", () => {
  test("/model input fetches DeepSeek balance and Codex usage when cache is empty", async () => {
    let deepSeekCalls = 0;
    let codexCalls = 0;
    installFakeCodexModules({
      fetchUsage: async () => {
        codexCalls += 1;
        return weeklyReport();
      },
    });
    process.env.PI_PROXY = "http://generic-proxy";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      deepSeekCalls += 1;
      return new Response(JSON.stringify({
        balance_infos: [{ currency: "CNY", total_balance: "12.34" }],
      }));
    };
    try {
      const { handlers } = mountExtension();
      const { ctx } = codexContext();
      ctx.model = { id: "claude-sonnet", provider: "anthropic" };
      ctx.modelRegistry = {
        ...ctx.modelRegistry,
        resolver: () => async () => "key",
        getProviderBaseUrl: () => "https://api.deepseek.com",
      };

      fireWithPayload(handlers, "input", { text: "/model deepseek-v4-pro" }, ctx);
      await flushPromises();

      expect(deepSeekCalls).toBe(1);
      expect(codexCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("/models and /switch also trigger dual fetch", async () => {
    for (const command of ["/models deepseek-v4-pro", "/switch"]) {
      let deepSeekCalls = 0;
      let codexCalls = 0;
      installFakeCodexModules({
        fetchUsage: async () => {
          codexCalls += 1;
          return weeklyReport();
        },
      });
      process.env.PI_PROXY = "http://generic-proxy";
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        deepSeekCalls += 1;
        return new Response(JSON.stringify({
          balance_infos: [{ currency: "CNY", total_balance: "12.34" }],
        }));
      };
      try {
        const { handlers } = mountExtension();
        const { ctx } = codexContext();
        ctx.model = { id: "claude-sonnet", provider: "anthropic" };
        ctx.modelRegistry = {
          ...ctx.modelRegistry,
          resolver: () => async () => "key",
          getProviderBaseUrl: () => "https://api.deepseek.com",
        };

        fireWithPayload(handlers, "input", { text: command }, ctx);
        await flushPromises();

        expect(deepSeekCalls).toBe(1);
        expect(codexCalls).toBe(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    }
  });

  test("normal input does not fetch either source", async () => {
    let deepSeekCalls = 0;
    let codexCalls = 0;
    installFakeCodexModules({
      fetchUsage: async () => {
        codexCalls += 1;
        return weeklyReport();
      },
    });
    process.env.PI_PROXY = "http://generic-proxy";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      deepSeekCalls += 1;
      return new Response("{}");
    };
    try {
      const { handlers } = mountExtension();
      const { ctx } = codexContext();
      ctx.model = { id: "claude-sonnet", provider: "anthropic" };
      ctx.modelRegistry = {
        ...ctx.modelRegistry,
        resolver: () => async () => "key",
        getProviderBaseUrl: () => "https://api.deepseek.com",
      };

      fireWithPayload(handlers, "input", { text: "hello" }, ctx);
      await flushPromises();

      expect(deepSeekCalls).toBe(0);
      expect(codexCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("second /model input within TTL does not refetch", async () => {
    let deepSeekCalls = 0;
    let codexCalls = 0;
    installFakeCodexModules({
      fetchUsage: async () => {
        codexCalls += 1;
        return weeklyReport();
      },
    });
    process.env.PI_PROXY = "http://generic-proxy";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      deepSeekCalls += 1;
      return new Response(JSON.stringify({
        balance_infos: [{ currency: "CNY", total_balance: "12.34" }],
      }));
    };
    try {
      const { handlers } = mountExtension();
      const { ctx } = codexContext();
      ctx.model = { id: "claude-sonnet", provider: "anthropic" };
      ctx.modelRegistry = {
        ...ctx.modelRegistry,
        resolver: () => async () => "key",
        getProviderBaseUrl: () => "https://api.deepseek.com",
      };

      fireWithPayload(handlers, "input", { text: "/model deepseek-v4-pro" }, ctx);
      await flushPromises();
      fireWithPayload(handlers, "input", { text: "/model deepseek-v4-flash" }, ctx);
      await flushPromises();

      expect(deepSeekCalls).toBe(1);
      expect(codexCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("model-cost start refresh cache", () => {
  test("agent_start DeepSeek skips balance fetch when cache is fresh", async () => {
    let deepSeekCalls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      deepSeekCalls += 1;
      return new Response(JSON.stringify({
        balance_infos: [{ currency: "CNY", total_balance: "12.34" }],
      }));
    };
    try {
      const { handlers } = mountExtension();
      const { ctx } = extensionContext(0, { id: "deepseek-v4-pro", provider: "deepseek" });
      ctx.modelRegistry = {
        resolver: () => async () => "key",
        getProviderBaseUrl: () => "https://api.deepseek.com",
      };

      await fire(handlers, "agent_start", ctx);
      expect(deepSeekCalls).toBe(1);

      await fire(handlers, "agent_start", ctx);
      expect(deepSeekCalls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("agent_start Codex skips usage fetch when cache is fresh", async () => {
    let codexCalls = 0;
    installFakeCodexModules({
      fetchUsage: async () => {
        codexCalls += 1;
        return weeklyReport();
      },
    });
    process.env.PI_PROXY = "http://generic-proxy";
    const { handlers } = mountExtension();
    const { ctx } = codexContext();

    await fire(handlers, "agent_start", ctx);
    expect(codexCalls).toBe(1);

    await fire(handlers, "agent_start", ctx);
    expect(codexCalls).toBe(1);
  });
});

describe("model-cost agent_end force refresh cache", () => {
  test("agent_end DeepSeek refreshes balance and updates cache", async () => {
    await withTemporaryHome(async () => {
      let deepSeekCalls = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        deepSeekCalls += 1;
        return new Response(JSON.stringify({
          balance_infos: [{ currency: "CNY", total_balance: "12.34" }],
        }));
      };
      const originalNow = Date.now;
      Date.now = () => 1_000_000_000_000;
      try {
        const { handlers } = mountExtension();
        const { ctx } = extensionContext(0, { id: "deepseek-v4-pro", provider: "deepseek" });
        ctx.modelRegistry = {
          resolver: () => async () => "key",
          getProviderBaseUrl: () => "https://api.deepseek.com",
        };

        await fire(handlers, "agent_start", ctx);
        expect(deepSeekCalls).toBe(1);

        Date.now = () => 1_000_000_000_000 + 31_000;
        await fire(handlers, "agent_end", ctx);
        expect(deepSeekCalls).toBe(2);

        await fire(handlers, "agent_start", ctx);
        expect(deepSeekCalls).toBe(2);
      } finally {
        Date.now = originalNow;
        globalThis.fetch = originalFetch;
      }
    });
  });

  test("agent_end Codex refreshes usage and updates cache", async () => {
    let codexCalls = 0;
    installFakeCodexModules({
      fetchUsage: async () => {
        codexCalls += 1;
        return weeklyReport();
      },
    });
    process.env.PI_PROXY = "http://generic-proxy";
    const originalNow = Date.now;
    Date.now = () => 1_000_000_000_000;
    try {
      const { handlers } = mountExtension();
      const { ctx } = codexContext();

      await fire(handlers, "agent_start", ctx);
      expect(codexCalls).toBe(1);

      Date.now = () => 1_000_000_000_000 + 31_000;
      await fire(handlers, "agent_end", ctx);
      expect(codexCalls).toBe(2);

      await fire(handlers, "agent_start", ctx);
      expect(codexCalls).toBe(2);
    } finally {
      Date.now = originalNow;
    }
  });
});
