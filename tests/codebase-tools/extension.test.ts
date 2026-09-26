import { beforeEach, describe, expect, test } from "bun:test";

import codeBaseTools, { __resetCodebaseToolsForTests, name } from "../../extensions/codebase-tools/index";
import { INIT_MESSAGE_TYPE, REMINDER_MESSAGE_TYPE, STATE_CUSTOM_TYPE } from "../../extensions/codebase-tools/state";

type Handler = (event: unknown, ctx: unknown) => unknown;
type InjectionResult = { message?: { customType?: string; content?: string; display?: boolean; attribution?: string } };
type WidgetCall = { key: string; content: unknown; placement: string | undefined };

interface Harness {
	appended: Array<{ customType: string; data: unknown }>;
	widgets: WidgetCall[];
	notices: string[];
	fire<T = unknown>(event: string, payload?: unknown): Promise<T>;
	toggle(): Promise<void>;
}

function harness(entries: unknown[] = [], kind: "main" | "sub" = "main"): Harness {
	const handlers: Record<string, Handler> = {};
	const commands: Record<string, { handler: (args: string, ctx: unknown) => unknown }> = {};
	const appended: Array<{ customType: string; data: unknown }> = [];
	const widgets: WidgetCall[] = [];
	const notices: string[] = [];

	const ctx = {
		agent: {
			kind,
			id: kind === "main" ? "Main" : "0-Explore",
			name: kind === "main" ? "main" : "explore",
			depth: kind === "main" ? 0 : 1,
		},
		sessionManager: { getBranch: () => entries },
		hasUI: true,
		mode: "tui",
		ui: {
			setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
				widgets.push({ key, content, placement: options?.placement });
			},
			notify: (message: string) => {
				notices.push(message);
			},
		},
	};

	const pi = {
		setLabel: () => {},
		on: (event: string, handler: Handler) => {
			handlers[event] = handler;
		},
		registerCommand: (commandName: string, options: { handler: (args: string, ctx: unknown) => unknown }) => {
			commands[commandName] = options;
		},
		appendEntry: (customType: string, data: unknown) => {
			appended.push({ customType, data });
		},
	};

	codeBaseTools(pi as never);

	return {
		appended,
		widgets,
		notices,
		async fire<T = unknown>(event: string, payload: unknown = {}) {
			const handler = handlers[event];
			if (!handler) throw new Error(`no handler registered for ${event}`);
			return (await handler(payload, ctx)) as T;
		},
		async toggle() {
			const command = commands["codebase-tools"];
			if (!command) throw new Error("codebase-tools command not registered");
			await command.handler("", ctx);
		},
	};
}

/** One fixture shape shared by every persistence test, so type and data stay in lockstep. */
const stateEntry = (data: unknown) => ({ type: "custom", customType: STATE_CUSTOM_TYPE, data });

const markerWidget = { key: "codebase-tools", content: ["◈ codeBaseTools"], placement: "aboveEditor" };

beforeEach(() => {
	__resetCodebaseToolsForTests();
});

describe("codeBaseTools extension", () => {
	test("exports the agreed name", () => {
		expect(name).toBe("codeBaseTools");
	});

	test("starts off: no injection, no marker", async () => {
		const h = harness();
		await h.fire("session_start", { type: "session_start" });
		expect(h.widgets).toEqual([]);
		expect(await h.fire("before_agent_start")).toBeUndefined();
	});

	test("/codebase-tools toggles on, shows the marker above the editor, persists state", async () => {
		const h = harness();
		await h.toggle();
		expect(h.appended).toEqual([{ customType: STATE_CUSTOM_TYPE, data: { on: true, initInjected: false } }]);
		expect(h.widgets[h.widgets.length - 1]).toEqual(markerWidget);
		expect(h.notices).toEqual(["codeBaseTools on"]);
	});

	test("first enabled turn injects init once, then reminder, re-asserting the marker", async () => {
		const h = harness();
		await h.toggle();
		const afterToggle = h.widgets.length;

		const first = await h.fire<InjectionResult>("before_agent_start");
		expect(first.message?.customType).toBe(INIT_MESSAGE_TYPE);
		expect(first.message?.display).toBe(false);
		expect(first.message?.attribution).toBe("agent");
		expect(first.message?.content).toContain("【codeBaseTools 路由】");
		expect(h.appended[h.appended.length - 1]).toEqual({
			customType: STATE_CUSTOM_TYPE,
			data: { on: true, initInjected: true },
		});
		expect(h.widgets.length).toBe(afterToggle + 1);
		expect(h.widgets[h.widgets.length - 1]).toEqual(markerWidget);

		const second = await h.fire<InjectionResult>("before_agent_start");
		expect(second.message?.customType).toBe(REMINDER_MESSAGE_TYPE);
		expect(h.widgets.length).toBe(afterToggle + 2);
		expect(h.widgets[h.widgets.length - 1]).toEqual(markerWidget);
	});

	test("off stops injection, clears the marker, and never resets init", async () => {
		const h = harness();
		await h.toggle();
		await h.fire("before_agent_start");
		await h.toggle();

		expect(h.appended[h.appended.length - 1]).toEqual({
			customType: STATE_CUSTOM_TYPE,
			data: { on: false, initInjected: true },
		});
		const cleared = h.widgets[h.widgets.length - 1];
		expect(cleared.key).toBe("codebase-tools");
		expect(cleared.placement).toBe("aboveEditor");
		expect(cleared.content).toBeUndefined();
		expect(await h.fire("before_agent_start")).toBeUndefined();
	});

	test("re-enabling resumes with reminder, no duplicate init", async () => {
		const h = harness();
		await h.toggle();
		await h.fire("before_agent_start");
		await h.toggle();
		await h.toggle();

		const result = await h.fire<InjectionResult>("before_agent_start");
		expect(result.message?.customType).toBe(REMINDER_MESSAGE_TYPE);
	});

	test("resume restores on + initInjected; marker appears on the first turn", async () => {
		const h = harness([stateEntry({ on: true, initInjected: true })]);
		await h.fire("session_start", { type: "session_start" });
		expect(h.widgets).toEqual([]);

		const result = await h.fire<InjectionResult>("before_agent_start");
		expect(result.message?.customType).toBe(REMINDER_MESSAGE_TYPE);
		expect(h.widgets[h.widgets.length - 1]).toEqual(markerWidget);
	});

	test("resume of an un-initialized on state injects init", async () => {
		const h = harness([stateEntry({ on: true, initInjected: false })]);
		await h.fire("session_switch", { type: "session_switch", reason: "resume" });

		const result = await h.fire<InjectionResult>("before_agent_start");
		expect(result.message?.customType).toBe(INIT_MESSAGE_TYPE);
	});

	test("invalid state data restores off", async () => {
		const h = harness([stateEntry({ on: "yes" })]);
		await h.fire("session_start");
		expect(await h.fire("before_agent_start")).toBeUndefined();
	});

	test("subagent inherits a main session's toggle with its own init state", async () => {
		const main = harness();
		await main.toggle();

		const sub = harness([], "sub");
		await sub.fire("session_start");
		expect((await sub.fire<InjectionResult>("before_agent_start")).message?.customType).toBe(INIT_MESSAGE_TYPE);
		expect((await sub.fire<InjectionResult>("before_agent_start")).message?.customType).toBe(REMINDER_MESSAGE_TYPE);
	});

	test("subagent stays silent while the main session is off", async () => {
		const sub = harness([], "sub");
		await sub.fire("session_start");
		expect(await sub.fire("before_agent_start")).toBeUndefined();
	});
});
