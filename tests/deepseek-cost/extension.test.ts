import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import deepseekCost from "../../extensions/deepseek-cost/index";

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
  deepseekCost(api as Parameters<typeof deepseekCost>[0]);
  return { commands, handlers };
}

function extensionContext(
  tokens: number,
  model = { id: "gpt-5.4", provider: "openai-codex" },
) {
  const widgetCalls: Array<string[] | undefined> = [];
  const notifyCalls: Array<{ message: string; type?: string }> = [];
  const ctx = {
    hasUI: true,
    model,
    sessionManager: {
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
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setWidget: (_key: string, lines: string[] | undefined) => widgetCalls.push(lines),
      notify(message: string, type?: string) {
        notifyCalls.push({ message, type });
      },
    },
  };
  return { ctx, notifyCalls, widgetCalls };
}

function fire(handlers: Map<string, EventHandler>, event: string, ctx: unknown): unknown {
  const handler = handlers.get(event);
  if (!handler) throw new Error(`handler not registered: ${event}`);
  return handler({}, ctx);
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

async function withTemporaryHome<T>(run: () => T | Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "deepseek-cost-extension-test-"));
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

describe("deepseek-cost extension", () => {
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
    const { handlers } = mountExtension();
    const widgetCalls: Array<string[] | undefined> = [];
    const now = Date.now();
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
      modelRegistry: {
        authStorage: {
          getOAuthAccountIdentity: () => ({ accountId: "acct-1" }),
          fetchUsageReports: async () => [{
            provider: "openai-codex",
            fetchedAt: now,
            limits: [{
              scope: { accountId: "acct-1", windowId: "7d" },
              window: { id: "7d", resetsAt: now + 2 * 24 * 60 * 60 * 1000 },
              amount: { usedFraction: 0.34 },
            }],
          }],
        },
      },
      getContextUsage: () => ({ tokens: 136_000 }),
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        setWidget: (_key: string, lines: string[] | undefined) => widgetCalls.push(lines),
        notify() {},
      },
      cwd: "C:/tmp",
      setTimeout: () => 1,
      clearTimer() {},
    };

    await fire(handlers, "session_start", ctx);

    const last = widgetCalls[widgetCalls.length - 1]?.[0] ?? "";
    expect(last).toContain("7d 34%");
    expect(last).toContain("重置");
  });
});
