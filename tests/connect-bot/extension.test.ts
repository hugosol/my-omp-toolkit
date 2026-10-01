/**
 * L1: the real `/connect-bot` command against the real factory, a local fake
 * ExtensionAPI/ExtensionCommandContext (the mounted-factory harness used by
 * model-cost / anchored-standard), and a fake push transport installed through
 * the module-level `__setPushClientForTest` seam (never `globalThis.fetch`).
 *
 * Covers this ticket's promises P1–P5 plus the P10 items it owns: the
 * `{ proxy: false }` option and the `/api/sessions/events` path are protocol
 * constants, and only the panel base URL comes from config.
 *
 * Also covers the state machine: the arm-time initial value, `agent_start` →
 * 工作中, the awaiting `session_stop` main path, and the `agent_end` backstop
 * with its self-check gate — each read through the `state` events the extension
 * actually pushes.
 *
 * And the session-switch slice (ticket 10): a `session_switch`/`session_branch`
 * that lands on a different id disconnects the old row best-effort, clears the
 * heartbeat, the machine, the failure budget and the footer, and leaves the new
 * session 未接入; an unchanged id (or an unarmed session) is a total no-op with
 * no request and no timer.
 *
 * No wall-clock waiting: the request deadlines are `AbortSignal.timeout`
 * deadlines, which Bun's fake timers drive, so a "the panel never answered"
 * case advances the clock instead of sleeping.
 *
 * Run: bun test tests/connect-bot/
 */
import { beforeEach, describe, expect, test, vi } from "bun:test";

import { __setPushClientForTest, type PushFetchInit, type PushHttpResponse } from "../../extensions/connect-bot/client";
import connectBot, { name } from "../../extensions/connect-bot/index";

// Spec/contract literals, deliberately not read from the implementation.
const ENDPOINT = "http://omp-bot.local:8787";
const EVENT_URL = `${ENDPOINT}/api/sessions/events`;
const EVENT_PATH = "/api/sessions/events";
const STATUS_KEY = "connect-bot";
const NO_UI_REFUSAL = "当前模式无 UI，不支持接入面板";
const ARM_FAILED = "无法连接 omp-bot，未启用；请确认面板已启动";
const OFFLINE_DISCONNECTED = "已断开 omp-bot 面板";
const OFFLINE_UNREACHABLE = "omp-bot 面板未响应";
/** 自动 disarm 文案：逐字来自票面（连续 3 次推送失败后通知一次）。 */
const AUTO_DISARM = "与 omp-bot 连接中断，已断开；重新执行 /connect-bot 可重连";
/** uuidv7, the id shape omp mints for a session. */
const SESSION_ID = "0192ce07-8c4f-7d66-afec-2482b5c9b03c";
/** 另一个会话的 id：`/resume`、`/fork`、新会话都会换到它。 */
const OTHER_SESSION_ID = "0192ce07-8c4f-7d66-afec-2482b5c9b03d";
/** 切换即断开的通知文案：逐字来自票面。 */
const SESSION_SWITCHED = "会话已切换，已断开面板；重新 /connect-bot 可重连";
const armedNotice = (onlineCount: number) => `已接入 omp-bot 面板（当前 ${onlineCount} 个在线会话）`;

interface PushCall {
	url: string;
	init: PushFetchInit;
}

type Responder = (call: PushCall) => PushHttpResponse | Promise<PushHttpResponse>;
type Handler = (args: string, ctx: unknown) => unknown;
type EventHandler = (event: unknown, ctx: unknown) => unknown;

const jsonResponse = (status: number, body: unknown): PushHttpResponse => ({
	status,
	text: async () => JSON.stringify(body),
});

const registered = (onlineCount: number): PushHttpResponse => jsonResponse(200, { outcome: "registered", onlineCount });

/** Install the fake transport; returns the shared call log. */
function installPush(responder: Responder): PushCall[] {
	const calls: PushCall[] = [];
	__setPushClientForTest(async (url, init) => {
		const call: PushCall = { url, init };
		calls.push(call);
		return await responder(call);
	});
	return calls;
}

/** A transport that only settles when the request's own deadline aborts it. */
const hangUntilAborted: Responder = call =>
	new Promise<PushHttpResponse>((_resolve, reject) => {
		if (call.init.signal.aborted) {
			reject(new Error("aborted"));
			return;
		}
		call.init.signal.addEventListener("abort", () => reject(new Error("aborted")));
	});

interface MountOptions {
	kind?: string;
	hasUI?: boolean;
	/** `ctx.isIdle()`; false = the agent is mid-turn (arm during a stream). */
	isIdle?: boolean;
	hasPendingMessages?: boolean;
	/** Running jobs `ctx.getAsyncJobSnapshot()` reports; `null` = no async-job manager. */
	runningJobs?: number | null;
	/** This session's id; a test can change it later through `setSessionId`. */
	sessionId?: string;
}

async function mount(options: MountOptions = {}) {
	const commands = new Map<string, Handler>();
	const handlers = new Map<string, EventHandler[]>();
	const notices: Array<{ message: string; type?: string }> = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	const timers: unknown[] = [];
	/** Mutable self-check answers, so a test can make the session busy between two fires. */
	const session = {
		id: options.sessionId ?? SESSION_ID,
		isIdle: options.isIdle ?? true,
		hasPendingMessages: options.hasPendingMessages ?? false,
		runningJobs: options.runningJobs ?? 0,
	};
	const ctx = {
		agent: { kind: options.kind ?? "main", id: "Main", name: "main", depth: 0 },
		hasUI: options.hasUI ?? true,
		mode: "tui",
		cwd: "C:/tmp",
		model: { id: "gpt-5.4", name: "gpt-5.4", provider: "openai-codex" },
		sessionManager: {
			getSessionId: () => session.id,
			getSessionName: () => "test",
			getSessionFile: () => undefined,
		},
		isIdle: () => session.isIdle,
		hasPendingMessages: () => session.hasPendingMessages,
		getAsyncJobSnapshot: () =>
			session.runningJobs === null
				? null
				: { running: Array.from({ length: session.runningJobs }, (_unused, index) => ({ id: `job-${index}` })) },
		ui: {
			notify: (message: string, type?: string) => {
				notices.push({ message, type });
			},
			setStatus: (key: string, text: string | undefined) => {
				statuses.push({ key, text });
			},
		},
		// The sanctioned extension-timer seam (`ctx.setInterval`/`ctx.setTimeout`);
		// background work scheduled anywhere else is the bug omp's managed timers exist to avoid.
		// A real timer factory is what omp's seam *is*, so it cannot be stubbed away here;
		// instead every heartbeat test installs `vi.useFakeTimers()`, which turns these
		// very calls into clock-driven fake timers, so no test ever spends wall-clock
		// time. Handles are unref'd exactly like omp's, and `timers` tracks the ones
		// still outstanding — `expect(h.timers).toEqual([])` therefore reads as
		// "nothing is scheduled any more".
		setTimeout: (callback: () => void, ms?: number) => {
			const handle = globalThis.setTimeout(callback, ms);
			handle.unref();
			timers.push(handle);
			return handle;
		},
		setInterval: (callback: () => void, ms?: number) => {
			const handle = globalThis.setInterval(callback, ms);
			handle.unref();
			timers.push(handle);
			return handle;
		},
		clearTimer: (handle: Timer) => {
			globalThis.clearInterval(handle);
			globalThis.clearTimeout(handle);
			const index = timers.indexOf(handle);
			if (index >= 0) timers.splice(index, 1);
		},
	};
	const api = {
		logger: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
		on: (event: string, handler: EventHandler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand: (commandName: string, command: { handler: Handler }) => {
			commands.set(commandName, command.handler);
		},
	};
	await connectBot(api as never);

	return {
		commands,
		handlers,
		notices,
		statuses,
		timers,
		session,
		/** Move this session to another id, exactly as `/resume`/new-session does. */
		setSessionId(id: string) {
			session.id = id;
		},
		messages: () => notices.map(entry => entry.message),
		statusTexts: () => statuses.map(entry => entry.text),
		/** Drive one omp event through every handler the extension registered for it. */
		async fire(event: string, payload: unknown = {}): Promise<void> {
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
			// Pushes leave through the background outbox: drain it before the caller
			// reads what the extension actually sent.
			await flushMicrotasks();
		},
		async run(args: string) {
			const handler = commands.get("connect-bot");
			if (!handler) throw new Error("the connect-bot command was not registered");
			await handler(args, ctx);
			await flushMicrotasks();
		},
		/** Start the command without waiting for it, for tests that drive the clock. */
		start(args: string): Promise<void> {
			const handler = commands.get("connect-bot");
			if (!handler) throw new Error("the connect-bot command was not registered");
			return Promise.resolve(handler(args, ctx)).then(() => undefined);
		},
	};
}

/** The parsed envelopes of every push so far, in order. */
function envelopes(calls: PushCall[]): Array<{ sessionId: string; kind: string; data?: Record<string, unknown> }> {
	return calls.map(call => JSON.parse(call.init.body) as { sessionId: string; kind: string; data?: Record<string, unknown> });
}

/** The `data` of every `state` event pushed so far, in order. */
function statePushes(calls: PushCall[]): Array<Record<string, unknown>> {
	return envelopes(calls)
		.filter(envelope => envelope.kind === "state")
		.map(envelope => envelope.data ?? {});
}

/**
 * Let pending promise chains settle without touching the clock: the command's
 * failure path runs a few microtasks after the deadline aborts the request.
 */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** Run `action` while capturing what the extension writes to stderr. */
async function captureStderr(action: () => Promise<void>): Promise<string[]> {
	const captured: string[] = [];
	const original = console.error;
	console.error = ((...args: unknown[]) => {
		captured.push(String(args[0]));
	}) as typeof console.error;
	try {
		await action();
	} finally {
		console.error = original;
	}
	return captured;
}

beforeEach(() => {
	__setPushClientForTest(null);
});

describe("mount", () => {
	test("exports the agreed name and registers the connect-bot command", async () => {
		expect(name).toBe("connect-bot");
		const h = await mount();
		expect([...h.commands.keys()]).toEqual(["connect-bot"]);
	});

	test("does not hook session_shutdown: a quit or a crash is left to the panel's 30s expiry", async () => {
		const h = await mount();
		expect([...h.handlers.keys()]).not.toContain("session_shutdown");
	});
});

describe("arm", () => {
	test("arms the main session through the panel's single event route and reports the online count", async () => {
		const calls = installPush(() => registered(3));
		const h = await mount();

		await h.run("  ");

		expect(calls).toHaveLength(2);
		expect(calls[0].url).toBe(EVENT_URL);
		expect(calls[0].url.endsWith(EVENT_PATH)).toBe(true);
		expect(calls[0].init.method).toBe("POST");
		expect(calls[0].init.proxy).toBe(false);
		expect(calls[0].init.headers["content-type"]).toBe("application/json");
		expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);

		// Envelope is exactly {sessionId, kind, data}: no version, no timestamp.
		const body = JSON.parse(calls[0].init.body);
		expect(Object.keys(body)).toEqual(["sessionId", "kind", "data"]);
		expect(body.sessionId).toBe(SESSION_ID);
		expect(body.kind).toBe("register");
		// The registered session's snapshot; empty optional fields are omitted.
		expect(body.data).toEqual({
			cwd: "C:/tmp",
			sessionName: "test",
			model: "gpt-5.4",
			pid: process.pid,
		});

		// Arm success is followed by the self-checked initial state: idle here.
		expect(JSON.parse(calls[1].init.body)).toEqual({
			sessionId: SESSION_ID,
			kind: "state",
			data: { value: "idle", reason: "register" },
		});
		expect(calls[1].url).toBe(EVENT_URL);
		expect(calls[1].init.proxy).toBe(false);
		expect(calls[1].init.signal).toBeInstanceOf(AbortSignal);

		expect(h.messages()).toEqual([armedNotice(3)]);
		expect(h.notices[0].type).toBeUndefined();
		expect(h.statuses).toEqual([{ key: STATUS_KEY, text: expect.stringContaining("已接入") }]);
	});

	test("arming mid-turn self-checks to 工作中 instead of a fake 空闲", async () => {
		const calls = installPush(() => registered(1));
		const h = await mount({ isIdle: false });

		await h.run("");

		expect(statePushes(calls)).toEqual([{ value: "working", reason: "register" }]);
	});

	test("a rejected register leaves the session unarmed with no leftover timers or further network work", async () => {
		vi.useFakeTimers();
		try {
			const calls = installPush(() => Promise.reject(new Error("ECONNREFUSED")));
			const h = await mount();

			await h.run("");

			expect(calls).toHaveLength(1);
			expect(h.messages()).toEqual([ARM_FAILED]);
			expect(h.notices[0].type).toBe("error");
			// Stayed 未接入: the footer was never touched.
			expect(h.statuses).toEqual([]);
			// Nothing scheduled on the sanctioned extension-timer seam…
			expect(h.timers).toEqual([]);

			// …and nothing on the clock either: no retry ever fires.
			vi.advanceTimersByTime(60_000);
			expect(calls).toHaveLength(1);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a non-2xx answer is not a successful register", async () => {
		const calls = installPush(() => jsonResponse(404, { code: "unknown-session", message: "该会话尚未注册" }));
		const h = await mount();

		await h.run("");

		expect(calls).toHaveLength(1);
		expect(h.messages()).toEqual([ARM_FAILED]);
		expect(h.statuses).toEqual([]);
	});

	test("a 2xx answer without the registered outcome is not a successful register", async () => {
		installPush(() => jsonResponse(200, { outcome: "accepted" }));
		const h = await mount();

		await h.run("");

		expect(h.messages()).toEqual([ARM_FAILED]);
		expect(h.statuses).toEqual([]);
	});

	test("a register that never answers times out after about a second and reports the failure", async () => {
		vi.useFakeTimers();
		try {
			const calls = installPush(hangUntilAborted);
			const h = await mount();

			const pending = h.start("");
			vi.advanceTimersByTime(999);
			await flushMicrotasks();
			// The deadline is ~1s: nothing may have given up yet.
			expect(h.messages()).toEqual([]);

			vi.advanceTimersByTime(1);
			await pending;

			expect(calls).toHaveLength(1);
			expect(calls[0].init.signal.aborted).toBe(true);
			expect(h.messages()).toEqual([ARM_FAILED]);
			expect(h.notices[0].type).toBe("error");
			expect(h.statuses).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("re-arming is an idempotent reconnect: register again, never unregister first", async () => {
		let registerCalls = 0;
		const calls = installPush(() => {
			registerCalls += 1;
			return registered(registerCalls === 1 ? 2 : 5);
		});
		const h = await mount();

		await h.run("");
		await h.run("");

		expect(calls.map(call => JSON.parse(call.init.body).kind)).toEqual(["register", "state", "register", "state"]);
		expect(h.messages()).toEqual([armedNotice(2), armedNotice(5)]);
		expect(h.statuses).toEqual([
			{ key: STATUS_KEY, text: expect.stringContaining("已接入") },
			{ key: STATUS_KEY, text: expect.stringContaining("已接入") },
		]);
	});

	test("a failed re-arm returns the session to 未接入", async () => {
		let attempts = 0;
		installPush(() => {
			attempts += 1;
			// The first arm is fully answered — its `register` and the initial `state`
			// that follows it; the reconnect's `register` then fails.
			return attempts <= 2 ? registered(2) : Promise.reject(new Error("panel restarted"));
		});
		const h = await mount();

		await h.run("");
		await h.run("");

		expect(h.messages()).toEqual([armedNotice(2), ARM_FAILED]);
		expect(h.statuses).toEqual([
			{ key: STATUS_KEY, text: expect.stringContaining("已接入") },
			{ key: STATUS_KEY, text: undefined },
		]);
	});
});

describe("state machine", () => {
	/** Mount and arm while idle; the caller reads the `state` events pushed from there on. */
	async function armed(isIdle = true) {
		const calls = installPush(() => registered(1));
		const h = await mount({ isIdle });
		await h.run("");
		return { calls, h };
	}

	test("agent_start reports 工作中 once, and a repeated start is silent", async () => {
		const { calls, h } = await armed();

		await h.fire("agent_start");
		await h.fire("agent_start");

		expect(statePushes(calls)).toEqual([
			{ value: "idle", reason: "register" },
			{ value: "working", reason: "agent_start" },
		]);
	});

	test("the awaiting session_stop settles 工作中 → 等待用户输入, and that settle's agent_end stays silent", async () => {
		const { calls, h } = await armed();
		await h.fire("agent_start");

		await h.fire("session_stop", { type: "session_stop" });
		// omp awaits session_stop and only then fires the display agent_end of the
		// same settle; the backstop finds the value already reported and stays quiet.
		await h.fire("agent_end", { type: "agent_end", messages: [] });

		expect(statePushes(calls)).toEqual([
			{ value: "idle", reason: "register" },
			{ value: "working", reason: "agent_start" },
			{ value: "awaiting-input", reason: "session_stop" },
		]);
		expect(JSON.parse(calls[3].init.body)).toEqual({
			sessionId: SESSION_ID,
			kind: "state",
			data: { value: "awaiting-input", reason: "session_stop" },
		});
		expect(calls[3].url).toBe(EVENT_URL);
		expect(calls[3].init.proxy).toBe(false);
	});

	test("every terminal agent_end shape that omits session_stop falls back to 等待用户输入", async () => {
		// omp 的 7 类终态在扩展侧只有两种可观测形状：前 6 类都是不带 `willContinue`
		// 的 `agent_end`（内部是哪个 return 分支都看不出来），第 7 类子代理由下面的守卫用例覆盖。
		const terminalShapes: Array<[string, unknown]> = [
			["无 assistant 消息", { type: "agent_end", messages: [] }],
			["skip-post-turn-maintenance", { type: "agent_end", messages: [] }],
			["successful yield", { type: "agent_end", messages: [] }],
			["compaction deferredHandoff / automaticContinuationBlocked", { type: "agent_end", messages: [] }],
			["尾消息仍带 toolCall", { type: "agent_end", messages: [] }],
			["abort", { type: "agent_end", messages: [] }],
		];
		for (const [label, event] of terminalShapes) {
			const { calls, h } = await armed();
			await h.fire("agent_start");
			await h.fire("agent_end", event);

			expect(statePushes(calls).at(-1), label).toEqual({ value: "awaiting-input", reason: "agent_end" });
		}
	});

	test("a scheduled continuation (willContinue) is never reported as a turn end", async () => {
		const { calls, h } = await armed();
		await h.fire("agent_start");

		await h.fire("agent_end", { type: "agent_end", messages: [], willContinue: true });

		expect(statePushes(calls)).toEqual([
			{ value: "idle", reason: "register" },
			{ value: "working", reason: "agent_start" },
		]);
	});

	test("the backstop self-check holds 工作中 while the session will wake itself", async () => {
		const cases: Array<[string, MountOptions, string[]]> = [
			["still streaming", { isIdle: false }, ["working"]],
			["a running async job", { runningJobs: 1 }, ["idle", "working"]],
			["queued input", { hasPendingMessages: true }, ["idle", "working"]],
		];
		for (const [label, options, expected] of cases) {
			const calls = installPush(() => registered(1));
			const h = await mount(options);
			await h.run("");
			await h.fire("agent_start");

			await h.fire("agent_end", { type: "agent_end", messages: [] });

			expect(statePushes(calls).map(push => push.value), label).toEqual(expected);
		}
	});

	test("a subagent session never moves the machine", async () => {
		const calls = installPush(() => registered(1));
		const h = await mount({ kind: "sub" });
		await h.run("");

		await h.fire("agent_start");
		await h.fire("session_stop", { type: "session_stop" });
		await h.fire("agent_end", { type: "agent_end", messages: [] });

		expect(calls).toEqual([]);
	});

	test("no state is reported before arming", async () => {
		const calls = installPush(() => registered(1));
		const h = await mount();

		await h.fire("agent_start");
		await h.fire("session_stop", { type: "session_stop" });
		await h.fire("agent_end", { type: "agent_end", messages: [] });

		expect(calls).toEqual([]);
	});
});

describe("heartbeat and the failure budget", () => {
	/** Arm while the panel answers; the caller then reads everything pushed from arm-up on. */
	async function armed(responder: Responder) {
		const calls = installPush(responder);
		const h = await mount();
		await h.run("");
		return { calls, h };
	}

	/** One heartbeat period: the managed clock advances, then the background flusher drains. */
	async function beat(): Promise<void> {
		vi.advanceTimersByTime(10_000);
		await flushMicrotasks();
	}

	test("a managed 10s heartbeat carries the state machine's current value", async () => {
		vi.useFakeTimers();
		try {
			const { calls, h } = await armed(() => registered(1));
			// One managed timer: the heartbeat. Nothing is pushed until it is due.
			expect(h.timers).toHaveLength(1);
			await h.fire("agent_start");

			vi.advanceTimersByTime(9_999);
			await flushMicrotasks();
			// 未到 10s：尚无心跳（此时已有 register 与 arm/agent_start 两次 state）。
			expect(calls.filter(call => JSON.parse(call.init.body).kind === "heartbeat")).toEqual([]);

			await beat();
			const beats = calls.filter(call => JSON.parse(call.init.body).kind === "heartbeat");
			expect(beats).toHaveLength(1);
			expect(JSON.parse(beats[0].init.body)).toEqual({
				sessionId: SESSION_ID,
				kind: "heartbeat",
				data: { value: "working" },
			});
			expect(beats[0].url).toBe(EVENT_URL);
			expect(beats[0].init.proxy).toBe(false);
			expect(beats[0].init.signal).toBeInstanceOf(AbortSignal);

			// 心跳不迁移状态、不重复提示：没有新的 state 帧，也没有新通知。
			expect(statePushes(calls)).toEqual([
				{ value: "idle", reason: "register" },
				{ value: "working", reason: "agent_start" },
			]);
			expect(h.messages()).toEqual([armedNotice(1)]);

			await beat();
			expect(calls.filter(call => JSON.parse(call.init.body).kind === "heartbeat")).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	test("three consecutive failures (~30s) auto-disarm once, clear the footer and never reconnect", async () => {
		vi.useFakeTimers();
		try {
			let panelUp = true;
			const { calls, h } = await armed(() => (panelUp ? registered(1) : Promise.reject(new Error("ECONNREFUSED"))));
			panelUp = false;

			await beat();
			// 首次失败通知一次…
			expect(h.messages()).toHaveLength(2);
			await beat();
			// …第 2 次静默。
			expect(h.messages()).toHaveLength(2);

			await beat();
			expect(h.messages()).toEqual([armedNotice(1), expect.any(String), AUTO_DISARM]);
			// 三次失败就是三次心跳：失败即丢，不重试。
			expect(calls.filter(call => JSON.parse(call.init.body).kind === "heartbeat")).toHaveLength(3);
			// 停心跳、清 footer：定时器已清、footer 已清空。
			expect(h.statusTexts().at(-1)).toBeUndefined();
			expect(h.timers).toEqual([]);

			// 不自动重连：时钟继续走也不再发任何东西，也不会有第二次 register。
			const sent = calls.length;
			vi.advanceTimersByTime(120_000);
			await flushMicrotasks();
			expect(calls).toHaveLength(sent);
			expect(calls.filter(call => JSON.parse(call.init.body).kind === "register")).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a single success resets the budget, so a later outage notifies again", async () => {
		vi.useFakeTimers();
		try {
			let panelUp = true;
			const { h } = await armed(() => (panelUp ? registered(1) : Promise.reject(new Error("ECONNREFUSED"))));

			panelUp = false;
			await beat();
			const afterFirstFailure = h.messages().length;

			// 任一次成功把失败计数与「首次失败已通知」一并复位。
			panelUp = true;
			await beat();

			panelUp = false;
			await beat();
			// 新的一段失败因此又收到一次首次失败提醒…
			expect(h.messages()).toHaveLength(afterFirstFailure + 1);
			await beat();
			// …第 2 次仍静默…
			expect(h.messages()).toHaveLength(afterFirstFailure + 1);
			await beat();
			// …第 3 次自动 disarm。
			expect(h.messages().at(-1)).toBe(AUTO_DISARM);
			expect(h.timers).toEqual([]);
			expect(h.messages()).toHaveLength(afterFirstFailure + 2);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a non-2xx answer counts as a failure, so a restarted panel disarms too", async () => {
		vi.useFakeTimers();
		try {
			let panelUp = true;
			const { h } = await armed(() => (panelUp ? registered(1) : jsonResponse(404, { code: "unknown-session" })));
			panelUp = false;

			await beat();
			await beat();
			await beat();

			expect(h.messages().at(-1)).toBe(AUTO_DISARM);
			expect(h.statusTexts().at(-1)).toBeUndefined();
			expect(h.timers).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a heartbeat that never answers times out at 1.5s and counts as a failure", async () => {
		vi.useFakeTimers();
		try {
			let panelUp = true;
			const { h } = await armed(call => (panelUp ? registered(1) : hangUntilAborted(call)));
			panelUp = false;

			await beat();
			// 未到 1.5s：请求还挂着，不算失败。
			vi.advanceTimersByTime(1_499);
			await flushMicrotasks();
			expect(h.messages()).toEqual([armedNotice(1)]);

			// 超时到点即失败，与 reject 走同一条失败计数路径（首次失败通知一次）。
			vi.advanceTimersByTime(1);
			await flushMicrotasks();
			expect(h.messages()).toHaveLength(2);

			// 再两轮超时 → 连续 3 次失败 → 自动 disarm。
			await beat();
			await beat();

			expect(h.messages().at(-1)).toBe(AUTO_DISARM);
			expect(h.timers).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a successful re-arm clears the budget and the first-failure flag as well", async () => {
		vi.useFakeTimers();
		try {
			let panelUp = true;
			const { h } = await armed(() => (panelUp ? registered(1) : Promise.reject(new Error("ECONNREFUSED"))));

			panelUp = false;
			await beat();
			await beat();
			const whileDown = h.messages().length;

			// 幂等重连：register 成功即清零，且不叠加第二个心跳定时器。
			panelUp = true;
			await h.run("");
			expect(h.messages()).toHaveLength(whileDown + 1);
			expect(h.timers).toHaveLength(1);

			panelUp = false;
			await beat();
			// 新的一段失败又能收到一次首次失败提醒（标志已复位）…
			expect(h.messages()).toHaveLength(whileDown + 2);
			await beat();
			// …计数也已从头开始（第 2 次静默）…
			expect(h.messages()).toHaveLength(whileDown + 2);
			await beat();
			// …第 3 次才自动 disarm。
			expect(h.messages().at(-1)).toBe(AUTO_DISARM);
		} finally {
			vi.useRealTimers();
		}
	});

	test("a failed unregister from /connect-bot offline never counts toward the budget", async () => {
		vi.useFakeTimers();
		try {
			let panelUp = true;
			const { h } = await armed(() => (panelUp ? registered(1) : Promise.reject(new Error("ECONNREFUSED"))));

			panelUp = false;
			await beat();
			await beat();
			// 两次心跳失败后主动断开，unregister 也失败：既不得触发自动 disarm，也不得
			// 因这次失败多出新通知（该次失败完全不计入计数）。
			await h.run("offline");

			expect(h.messages()).toEqual([armedNotice(1), expect.any(String), OFFLINE_UNREACHABLE]);
			expect(h.timers).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("offline", () => {
	test("drops the local switch before the panel answers, then reports the disconnect", async () => {
		let phase: "arm" | "unregister" = "arm";
		let settle: ((response: PushHttpResponse) => void) | undefined;
		const calls = installPush(() =>
			phase === "arm"
				? registered(1)
				: new Promise<PushHttpResponse>(resolve => {
						settle = resolve;
					}),
		);
		const h = await mount();
		await h.run("");
		phase = "unregister";

		const pending = h.run(" Offline ");
		// Local disarm is immediate: the footer is already cleared while the panel is still silent.
		expect(h.statuses).toEqual([
			{ key: STATUS_KEY, text: expect.stringContaining("已接入") },
			{ key: STATUS_KEY, text: undefined },
		]);
		expect(h.messages()).toEqual([armedNotice(1)]);

		settle?.(jsonResponse(200, { outcome: "accepted" }));
		await pending;

		expect(h.messages()).toEqual([armedNotice(1), OFFLINE_DISCONNECTED]);
		expect(h.statusTexts()).toEqual([expect.stringContaining("已接入"), undefined]);

		// unregister carries only {sessionId, kind}: `data` is omitted by contract.
		expect(calls).toHaveLength(3);
		expect(JSON.parse(calls[2].init.body)).toEqual({ sessionId: SESSION_ID, kind: "unregister" });
		expect(calls[2].url).toBe(EVENT_URL);
		expect(calls[2].init.proxy).toBe(false);
	});

	test("a reachable panel counts as disconnected even when it answers non-2xx", async () => {
		let arm = true;
		installPush(() => (arm ? registered(1) : jsonResponse(404, { code: "unknown-session" })));
		const h = await mount();
		await h.run("");
		arm = false;

		await h.run("offline");

		expect(h.messages()).toEqual([armedNotice(1), OFFLINE_DISCONNECTED]);
		expect(h.statusTexts()).toEqual([expect.stringContaining("已接入"), undefined]);
	});

	test("an unreachable panel reports it, stays disconnected, and is not retried", async () => {
		let arm = true;
		const calls = installPush(() => (arm ? registered(1) : Promise.reject(new Error("EHOSTUNREACH"))));
		const h = await mount();
		await h.run("");
		arm = false;

		await h.run("offline");

		expect(calls).toHaveLength(3);
		expect(h.messages()).toEqual([armedNotice(1), OFFLINE_UNREACHABLE]);
		expect(h.notices[1].type).toBe("error");
		expect(h.statusTexts()).toEqual([expect.stringContaining("已接入"), undefined]);
		expect(h.timers).toEqual([]);

		// Already 未接入: a second offline performs no network work.
		await h.run("offline");
		expect(calls).toHaveLength(3);
		expect(h.messages()).toEqual([armedNotice(1), OFFLINE_UNREACHABLE]);
	});

	test("an unregister that never answers times out and reports the unresponsive panel", async () => {
		vi.useFakeTimers();
		try {
			let arm = true;
			const calls = installPush(call => (arm ? registered(1) : hangUntilAborted(call)));
			const h = await mount();
			await h.run("");
			arm = false;

			const pending = h.start("offline");
			vi.advanceTimersByTime(1499);
			await flushMicrotasks();
			expect(h.messages()).toEqual([armedNotice(1)]);

			vi.advanceTimersByTime(1);
			await pending;

			expect(calls).toHaveLength(3);
			expect(h.messages()).toEqual([armedNotice(1), OFFLINE_UNREACHABLE]);
			expect(h.statusTexts()).toEqual([expect.stringContaining("已接入"), undefined]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("offline clears the state machine: later events change nothing until the next arm", async () => {
		const calls = installPush(() => registered(1));
		const h = await mount({ isIdle: false });
		await h.run("");
		await h.run("offline");

		await h.fire("agent_start");
		await h.fire("agent_end", { type: "agent_end", messages: [] });

		expect(statePushes(calls)).toEqual([{ value: "working", reason: "register" }]);
	});

	test("offline without ever arming touches nothing", async () => {
		const calls = installPush(() => jsonResponse(200, { outcome: "accepted" }));
		const h = await mount();

		await h.run("offline");

		expect(calls).toEqual([]);
		expect(h.notices).toEqual([]);
		expect(h.statuses).toEqual([]);
		expect(h.timers).toEqual([]);
	});
});

describe("session switch", () => {
	test("switching to another session disconnects the old row and leaves the new session 未接入", async () => {
		vi.useFakeTimers();
		try {
			const calls = installPush(() => registered(1));
			const h = await mount();
			await h.run("");
			expect(h.timers).toHaveLength(1);

			// `/resume` 到另一个会话：ctx 的 id 已经换成新的那个。
			h.setSessionId(OTHER_SESSION_ID);
			await h.fire("session_switch", { type: "session_switch", reason: "resume" });

			// 尽力移除的是**旧** id 的行（拿新 id 发只会 404）。
			const unregisters = envelopes(calls).filter(envelope => envelope.kind === "unregister");
			expect(unregisters).toHaveLength(1);
			expect(unregisters[0]).toEqual({ sessionId: SESSION_ID, kind: "unregister" });
			expect(calls[2].url).toBe(EVENT_URL);
			expect(calls[2].init.proxy).toBe(false);
			// 新会话保持未接入：全程没有面向新 id 的 register。
			expect(envelopes(calls).map(envelope => envelope.kind)).toEqual(["register", "state", "unregister"]);

			// 本地状态清干净：心跳定时器已清、footer 清空、通知一次。
			expect(h.messages()).toEqual([armedNotice(1), SESSION_SWITCHED]);
			expect(h.statusTexts()).toEqual([expect.stringContaining("已接入"), undefined]);
			expect(h.timers).toEqual([]);

			// 新会话彻底未接入：时钟走过去没有心跳，状态事件也不上报。
			vi.advanceTimersByTime(60_000);
			await flushMicrotasks();
			await h.fire("agent_start");
			await h.fire("session_stop", { type: "session_stop" });
			expect(envelopes(calls).map(envelope => envelope.kind)).toEqual(["register", "state", "unregister"]);
			expect(h.messages()).toEqual([armedNotice(1), SESSION_SWITCHED]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("session_branch disconnects too, and an unreachable panel stays silent: no budget, no auto-disarm", async () => {
		vi.useFakeTimers();
		try {
			let panelUp = true;
			const calls = installPush(() => (panelUp ? registered(1) : Promise.reject(new Error("ECONNREFUSED"))));
			const h = await mount();
			await h.run("");
			panelUp = false;

			h.setSessionId(OTHER_SESSION_ID);
			await h.fire("session_branch", { type: "session_branch" });

			expect(envelopes(calls).map(envelope => envelope.kind)).toEqual(["register", "state", "unregister"]);
			// 静默：既没有首次失败提醒，更没有自动 disarm 通知。
			expect(h.messages()).toEqual([armedNotice(1), SESSION_SWITCHED]);
			expect(h.timers).toEqual([]);

			// 这次失败完全不计入预算：时钟再走也不会有任何后续动作。
			vi.advanceTimersByTime(120_000);
			await flushMicrotasks();
			expect(envelopes(calls).map(envelope => envelope.kind)).toEqual(["register", "state", "unregister"]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("switching while a heartbeat is still in flight stays silent: no failure notice, no auto-disarm", async () => {
		vi.useFakeTimers();
		try {
			// 面板在 arm 之后就不响了：心跳与切换时的 unregister 都挂到各自的超时。
			let panelUp = true;
			const calls = installPush(call => (panelUp ? registered(1) : hangUntilAborted(call)));
			const h = await mount();
			await h.run("");
			panelUp = false;

			// 10s 心跳已经发出去，还在等面板（1.5s 超时未到）。
			vi.advanceTimersByTime(10_000);
			await flushMicrotasks();
			expect(envelopes(calls).map(envelope => envelope.kind)).toEqual(["register", "state", "heartbeat"]);

			h.setSessionId(OTHER_SESSION_ID);
			const pendingSwitch = h.fire("session_switch", { type: "session_switch", reason: "resume" });
			await flushMicrotasks();
			// 本地立即退场（心跳、失败预算与 footer 一起清），面板那边还没答。
			expect(h.messages()).toEqual([armedNotice(1), SESSION_SWITCHED]);
			expect(h.timers).toEqual([]);

			// 在途心跳与这次 unregister 都超时：两边都静默 —— 既没有首次失败提醒，
			// 也没有自动 disarm；漏掉的旧行交给面板的 30s 过期。
			vi.advanceTimersByTime(2_000);
			await pendingSwitch;
			expect(envelopes(calls).map(envelope => envelope.kind)).toEqual([
				"register",
				"state",
				"heartbeat",
				"unregister",
			]);
			expect(h.messages()).toEqual([armedNotice(1), SESSION_SWITCHED]);
			expect(h.statusTexts()).toEqual([expect.stringContaining("已接入"), undefined]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("an unchanged id is a no-op: /reload, /clear and a TUI branch keep the session 已接入", async () => {
		vi.useFakeTimers();
		try {
			const calls = installPush(() => registered(1));
			const h = await mount();
			await h.run("");

			// id 没变的三类操作：/reload 与同文件 /resume 走 session_switch，
			// TUI /branch、/tree 走 session_branch。
			await h.fire("session_switch", { type: "session_switch", reason: "resume" });
			await h.fire("session_switch", { type: "session_switch", reason: "new" });
			await h.fire("session_branch", { type: "session_branch" });

			expect(envelopes(calls).map(envelope => envelope.kind)).toEqual(["register", "state"]);
			expect(h.messages()).toEqual([armedNotice(1)]);
			expect(h.statusTexts()).toEqual([expect.stringContaining("已接入")]);
			expect(h.timers).toHaveLength(1);

			// 已接入状态没被打断：状态迁移与心跳照旧。
			await h.fire("agent_start");
			vi.advanceTimersByTime(10_000);
			await flushMicrotasks();
			expect(envelopes(calls).map(envelope => envelope.kind)).toEqual(["register", "state", "state", "heartbeat"]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("an unarmed session does nothing at all: no request, no timer, no notice", async () => {
		vi.useFakeTimers();
		try {
			const calls = installPush(() => registered(1));
			const h = await mount();

			// 从未接入过，却换了会话：一次请求都不发（也没定时器、没提示）。
			h.setSessionId(OTHER_SESSION_ID);
			await h.fire("session_switch", { type: "session_switch", reason: "resume" });
			await h.fire("session_branch", { type: "session_branch" });

			expect(calls).toEqual([]);
			expect(h.notices).toEqual([]);
			expect(h.statuses).toEqual([]);
			expect(h.timers).toEqual([]);

			// 时钟与定时器都空转：未接入时该功能完全不存在。
			vi.advanceTimersByTime(60_000);
			await flushMicrotasks();
			expect(calls).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	test("two sessions in the same cwd keep their own rows: switching one never touches the other", async () => {
		vi.useFakeTimers();
		try {
			const calls = installPush(() => registered(2));
			const first = await mount();
			const second = await mount({ sessionId: OTHER_SESSION_ID });
			await first.run("");
			await second.run("");

			// 同 cwd 的两个会话各自注册成行。
			expect(envelopes(calls).filter(envelope => envelope.kind === "register")).toEqual([
				expect.objectContaining({ sessionId: SESSION_ID, data: expect.objectContaining({ cwd: "C:/tmp" }) }),
				expect.objectContaining({ sessionId: OTHER_SESSION_ID, data: expect.objectContaining({ cwd: "C:/tmp" }) }),
			]);

			// first 切到一个既非 SESSION_ID、也非 second 的 id 上。
			first.setSessionId("0192ce07-8c4f-7d66-afec-2482b5c9b03e");
			await first.fire("session_switch", { type: "session_switch", reason: "resume" });

			// 只有 first 的行退场，且移除的是 first 的旧 id。
			const unregisters = envelopes(calls).filter(envelope => envelope.kind === "unregister");
			expect(unregisters).toEqual([{ sessionId: SESSION_ID, kind: "unregister" }]);
			expect(first.statusTexts().at(-1)).toBeUndefined();
			expect(first.timers).toEqual([]);

			// second 完全没被打扰：footer 还在，心跳还在跑，通知也没有它的份。
			expect(second.statusTexts()).toEqual([expect.stringContaining("已接入")]);
			expect(second.timers).toHaveLength(1);
			expect(second.messages()).toEqual([armedNotice(2)]);

			vi.advanceTimersByTime(10_000);
			await flushMicrotasks();
			const beats = envelopes(calls).filter(envelope => envelope.kind === "heartbeat");
			expect(beats).toEqual([expect.objectContaining({ sessionId: OTHER_SESSION_ID })]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("guards", () => {
	test("a subagent session is refused whether it arms or disconnects", async () => {
		const calls = installPush(() => registered(1));
		const h = await mount({ kind: "sub" });

		const stderr = await captureStderr(async () => {
			await h.run("");
			await h.run("offline");
		});

		expect(calls).toEqual([]);
		expect(h.notices).toEqual([]);
		expect(h.statuses).toEqual([]);
		expect(stderr).toEqual([]);
	});

	test("a session without UI is refused with the fixed stderr message and no network request", async () => {
		const calls = installPush(() => registered(1));
		const h = await mount({ hasUI: false });

		const stderr = await captureStderr(async () => {
			await h.run("");
			await h.run("offline");
		});

		expect(stderr).toEqual([NO_UI_REFUSAL, NO_UI_REFUSAL]);
		expect(calls).toEqual([]);
		expect(h.notices).toEqual([]);
		expect(h.statuses).toEqual([]);
	});
});

describe("unknown arguments", () => {
	test("an unknown argument reports an error with a usage hint and changes nothing", async () => {
		for (const argument of ["off", "on", "status", "ofline"]) {
			const calls = installPush(() => registered(1));
			const h = await mount();
			await h.run("");
			const statusesWhileArmed = [...h.statuses];

			await h.run(argument);

			const last = h.notices.at(-1);
			expect(last?.type).toBe("error");
			expect(last?.message).toContain(argument);
			expect(last?.message).toContain("/connect-bot offline");
			// Unchanged state: the footer still shows 已接入 and no request was sent.
			expect(h.statuses).toEqual(statusesWhileArmed);
			expect(calls.map(call => JSON.parse(call.init.body).kind)).toEqual(["register", "state"]);

			// Still armed: the following offline actually unregisters.
			await h.run("offline");
			expect(JSON.parse(calls.at(-1)?.init.body ?? "{}").kind).toBe("unregister");
		}
	});
});
