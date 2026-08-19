import { describe, expect, test } from "bun:test";

import modelCost from "../../extensions/model-cost/index";

type EventHandler = (event: unknown, ctx: unknown) => unknown;

interface ScheduledTimer {
  id: number;
  at: number;
  fn: () => void | Promise<void>;
}

function mountExtension() {
  const handlers: Record<string, EventHandler> = {};
  const api = {
    setLabel() {},
    registerCommand() {},
    on(event: string, handler: EventHandler) {
      handlers[event] = handler;
    },
  };
  modelCost(api as Parameters<typeof modelCost>[0]);
  return { handlers };
}

function createHarness(fakeNow: Date, resolver: () => Promise<unknown> = async () => undefined) {
  const RealDate = Date;
  let current = fakeNow;
  class FakeDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(current.getTime());
      else super(...(args as [string | number | Date]));
    }
    static now() {
      return current.getTime();
    }
  }
  globalThis.Date = FakeDate as typeof Date;

  const timers: ScheduledTimer[] = [];
  let nextTimerId = 1;
  const widgetCalls: Array<string[] | undefined> = [];

  const ctx = {
    hasUI: true,
    model: { id: "deepseek-v4-flash", provider: "deepseek" },
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
    getContextUsage: () => ({ tokens: 1000 }),
    modelRegistry: {
      resolver,
      getProviderBaseUrl: () => undefined,
    },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setWidget(_key: string, content: unknown) {
        if (typeof content === "function") {
          const component = (content as (
            _tui: unknown,
            theme: { fg: (color: string, text: string) => string },
          ) => { render(width: number): string[] })({}, { fg: (_color: string, text: string) => text });
          widgetCalls.push(component.render(120));
        } else {
          widgetCalls.push(content as string[] | undefined);
        }
      },
      notify() {},
    },
    setTimeout(fn: () => void | Promise<void>, ms?: number) {
      const id = nextTimerId++;
      timers.push({ id, at: current.getTime() + (ms ?? 0), fn });
      return id;
    },
    clearTimer(id: number) {
      const index = timers.findIndex(t => t.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
  };

  function advanceTo(date: Date) {
    while (true) {
      const due = timers
        .filter(t => t.at <= date.getTime())
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      const index = timers.findIndex(t => t.id === due.id);
      if (index >= 0) timers.splice(index, 1);
      current = new RealDate(due.at);
      due.fn();
    }
    current = date;
  }

  function restore() {
    globalThis.Date = RealDate;
  }

  return { ctx, widgetCalls, timers, advanceTo, restore };
}

describe("model-cost boundary timer", () => {
  test("schedules just after an inclusive peak-end boundary so idle icon flips to off-peak", async () => {
    const { handlers } = mountExtension();
    const harness = createHarness(new Date("2026-08-17T03:59:59.900Z")); // 11:59:59.900 Beijing
    const { ctx, widgetCalls, timers, advanceTo, restore } = harness;

    try {
      const dispatch = (event: string, payload = {}) => {
        const handler = handlers[event];
        if (!handler) throw new Error(`handler not registered: ${event}`);
        return handler(payload, ctx);
      };

      await dispatch("session_start");

      expect(widgetCalls.at(-1)?.[0]).toContain("🔥");
      expect(timers.length).toBe(1);
      // With the fix the timer is scheduled 1ms after 12:00 Beijing, not exactly on it.
      expect(timers[0]!.at).toBe(new Date("2026-08-17T04:00:00.001Z").getTime());

      // At exactly 12:00:00.000 the timer must not have fired yet (still peak).
      advanceTo(new Date("2026-08-17T04:00:00.000Z"));
      expect(widgetCalls.at(-1)?.[0]).toContain("🔥");
      expect(timers.length).toBe(1);

      // 1ms later the timer fires and the icon flips to off-peak.
      advanceTo(new Date("2026-08-17T04:00:00.001Z"));
      expect(widgetCalls.at(-1)?.[0]).toContain("🌙");
      expect(timers.length).toBe(1); // next boundary re-armed
    } finally {
      restore();
    }
  });

  test("arms the boundary timer before slow balance fetching blocks initialization", async () => {
    const { handlers } = mountExtension();
    let resolveResolver: ((value: unknown) => void) | undefined;
    const resolverPromise = new Promise<unknown>(resolve => {
      resolveResolver = resolve;
    });
    const harness = createHarness(
      new Date("2026-08-17T03:59:59.900Z"),
      () => resolverPromise,
    );
    const { ctx, timers, restore } = harness;

    try {
      const dispatch = (event: string, payload = {}) => {
        const handler = handlers[event];
        if (!handler) throw new Error(`handler not registered: ${event}`);
        return handler(payload, ctx);
      };

      const pending = dispatch("session_start");
      // The timer must already be armed even though initializeForModel is still
      // awaiting the unresolved balance fetch.
      expect(timers.length).toBe(1);

      resolveResolver?.(undefined);
      await pending;
    } finally {
      restore();
    }
  });
});
