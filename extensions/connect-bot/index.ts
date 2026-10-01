/**
 * connect-bot — omp session bridge to the omp-bot panel.
 *
 * The extension id is the directory name (`connect-bot`); the exported `name`
 * is diagnostics/tests only, the loader never consumes it. There is no
 * `enabled` gate either: dropping this directory into a configured extensions
 * root is the whole installation, and an extension that was never armed does
 * nothing.
 *
 * The panel endpoint is machine-global and read from the extension's
 * `config.json` (see `./config`); the wire itself is hard-coded in `./client`.
 * The switch is per-session closure memory, never persisted:
 *
 *  - `/connect-bot` (no argument) registers this main session; the session is
 *    only marked 已接入 once the panel answers with the registered receipt.
 *    Re-running it re-registers without unregistering first, so a panel restart
 *    is a one-command reconnect and the panel row never flickers.
 *  - `/connect-bot offline` drops the local switch immediately and then removes
 *    the panel row best-effort.
 *  - Anything else is an error and changes nothing.
 *
 * 已接入/未接入 is the panel switch and stays orthogonal to omp-bot's
 * online/offline keepAlive. User feedback is a transient `notify` plus a
 * persistent footer `setStatus`.
 *
 * While 已接入, the same closure also runs the agent state machine (`./state`):
 * `agent_start` reports 工作中, a turn end reports 等待用户输入 — awaited
 * `session_stop` on the main path, the `agent_end` backstop with its self-check
 * gate for the terminal shapes that never emit it — and only a real value
 * change is ever pushed.
 *
 * While 已接入, a managed 10s heartbeat (`./connection`) keeps the panel's
 * keepAlive 在线 and carries the same current value, so a lost `state` heals on
 * the next beat. Three consecutive push failures (≈30s) auto-disarm and notify
 * once — never reconnecting on their own — while any success resets the failure
 * count and the first-failure flag. Every background push leaves through a
 * bounded ordered outbox (one flusher, 1.5s budget, dropped on failure) instead
 * of awaiting the network. `session_shutdown` is deliberately not hooked: a
 * normal quit, a signal kill and a crash are all left to the panel's 30s expiry.
 */
import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

import {
	PUSH_TIMEOUT_MS,
	REGISTER_TIMEOUT_MS,
	UNREGISTER_TIMEOUT_MS,
	pushEvent,
	readRegisterOutcome,
	type PushEnvelope,
} from "./client";
import { commandGate, parseCommand, unknownArgumentHint } from "./command";
import { loadConfig } from "./config";
import {
	HEARTBEAT_INTERVAL_MS,
	INITIAL_HEALTH,
	Outbox,
	recordFailure,
	resetHealth,
	type ConnectionHealth,
} from "./connection";
import {
	isSessionSwitched,
	transitionState,
	type SelfCheck,
	type StateEvent,
	type StateReason,
	type StateValue,
} from "./state";

/** Diagnostic name; the loader's extension id comes from the directory name. */
export const name = "connect-bot";

// bun-only: import.meta.dir is the module's directory; TS's ImportMeta lacks it.
const meta = import.meta as unknown as { dir?: string };
const extensionDir = meta.dir ?? "";

/** Footer key of the persistent panel-switch marker. */
export const STATUS_KEY = "connect-bot";
/** Footer text while 已接入. */
export const ARMED_STATUS = "已接入 omp-bot 面板";

/** Arm success: one round-trip also reports how many sessions are online right now. */
export const armConnectedMessage = (onlineCount: number) => `已接入 omp-bot 面板（当前 ${onlineCount} 个在线会话）`;
/** Arm failure: the panel is not there, so this session is not being monitored. */
export const ARM_FAILED_MESSAGE = "无法连接 omp-bot，未启用；请确认面板已启动";
/** Offline with the panel reachable — including a non-2xx answer such as `404` after an omp-bot restart. */
export const OFFLINE_DISCONNECTED_MESSAGE = "已断开 omp-bot 面板";
/** Offline with the panel unreachable: the local switch is off; the remote row may linger. */
export const OFFLINE_UNREACHABLE_MESSAGE = "omp-bot 面板未响应";

/** First push failure of an outage: one notice per outage, before the budget runs out. */
export const FIRST_FAILURE_MESSAGE = "与 omp-bot 面板连接中断；若持续失败将自动断开";
/** 3 consecutive push failures (≈30s): the switch went off by itself and needs a manual `/connect-bot`. */
export const AUTO_DISARM_MESSAGE = "与 omp-bot 连接中断，已断开；重新执行 /connect-bot 可重连";
/** 会话已切到另一个 id：旧会话的行已尽力退场，新会话需要用户重新接入。 */
export const SESSION_SWITCHED_MESSAGE = "会话已切换，已断开面板；重新 /connect-bot 可重连";

export default async function connectBot(pi: ExtensionAPI): Promise<void> {
	// Wiring: the endpoint is loaded here, so malformed content fails the mount.
	const { config } = await loadConfig(`${extensionDir}/config.json`, message => {
		try {
			pi.logger.warn(message);
		} catch {
			// Logger unavailable — the warning is diagnostic only.
		}
	});

	/** Armed = this session is registered with the panel and the footer says so. */
	let armed = false;

	/**
	 * The session id this closure registered with the panel, kept so a session
	 * switch can tell "this session moved" from "the same session reloaded".
	 * `undefined` while 未接入.
	 */
	let armedSessionId: string | undefined;

	/**
	 * The extension state machine's current value; `undefined` while 未接入 —
	 * an unarmed session has nothing to report and never touches the network.
	 */
	let state: StateValue | undefined;

	/** Outbound queue: enqueue returns at once; one flusher sends in order and drops what fails. */
	const outbox = new Outbox();
	/** Consecutive-failure budget plus the one-notice-per-outage first-failure flag. */
	const health: ConnectionHealth = { ...INITIAL_HEALTH };
	/** Managed heartbeat handle, kept so disarm can clear exactly this timer and no other. */
	let heartbeatTimer: Timer | undefined;
	/** One drain loop at a time — that is what keeps the outbox ordered. */
	let flushing = false;

	const stopHeartbeat = (ctx: ExtensionContext): void => {
		if (heartbeatTimer === undefined) return;
		ctx.clearTimer(heartbeatTimer);
		heartbeatTimer = undefined;
	};

	/**
	 * Drop the local switch (with the machine, the pending pushes and the failure
	 * budget); returns whether this session had been armed.
	 */
	const disarmLocally = (ctx: ExtensionContext): boolean => {
		const wasArmed = armed;
		if (wasArmed) {
			armed = false;
			armedSessionId = undefined;
			state = undefined;
			stopHeartbeat(ctx);
			outbox.clear();
			resetHealth(health);
			ctx.ui.setStatus(STATUS_KEY, undefined);
		}
		return wasArmed;
	};

	/**
	 * 连续 3 次推送失败（≈30s）→ 解除接入并通知一次，绝不自动重连：用户重新执行
	 * `/connect-bot` 才回到已接入。
	 */
	const autoDisarm = (ctx: ExtensionContext): void => {
		disarmLocally(ctx);
		ctx.ui.notify(AUTO_DISARM_MESSAGE, "error");
	};

	/**
	 * Send one queued event. Failure is accounting, never a throw: a reject/timeout
	 * and a non-2xx answer are the same thing, and the event is dropped rather than
	 * retried. The `register` receipt is not parsed here — the arm path owns that.
	 */
	const sendQueued = async (ctx: ExtensionContext, envelope: PushEnvelope): Promise<void> => {
		const outcome = await pushEvent(config.endpoint, envelope, PUSH_TIMEOUT_MS).catch(() => undefined);
		// offline / auto-disarm drained the queue while this was in flight: a late
		// answer must neither re-open the budget nor disarm an already-off session.
		if (!armed) return;
		if (outcome !== undefined && outcome.ok) {
			resetHealth(health);
			return;
		}
		const action = recordFailure(health);
		if (action === "notify-first") ctx.ui.notify(FIRST_FAILURE_MESSAGE, "error");
		else if (action === "notify-disarm") autoDisarm(ctx);
	};

	/** The one flusher: drains in order, one event at a time. */
	const flush = (ctx: ExtensionContext): void => {
		if (flushing) return;
		flushing = true;
		void (async () => {
			try {
				for (let envelope = outbox.shift(); envelope !== undefined; envelope = outbox.shift()) {
					await sendQueued(ctx, envelope);
				}
			} finally {
				// A throwing notify/UI call must not leave the outbox wedged shut; the
				// promise itself is contained like every other background push here.
				flushing = false;
			}
		})().catch(() => {});
	};

	/**
	 * Report one `state`. Fire-and-forget: an event handler has a 30s budget and must
	 * never await the panel, so the ordered outbox carries it and a dropped push is
	 * healed by the next heartbeat (which always carries the current value).
	 */
	const pushState = (ctx: ExtensionContext, value: StateValue, reason: StateReason): void => {
		outbox.push({
			sessionId: ctx.sessionManager.getSessionId(),
			kind: "state",
			data: { value, reason },
		});
		flush(ctx);
	};

	/**
	 * The 10s heartbeat: it keeps this session 在线 on the panel and carries the
	 * machine's current value, so a lost `state` heals on the next beat. Managed
	 * timer (`ctx.setInterval`), cleared on teardown; re-arming keeps the running
	 * one instead of stacking a second.
	 */
	const startHeartbeat = (ctx: ExtensionContext): void => {
		if (heartbeatTimer !== undefined) return;
		heartbeatTimer = ctx.setInterval(() => {
			// A queue entry always predates its own disarm; this guard is for the beat
			// that is already running when the timer is cleared.
			if (!armed || state === undefined) return;
			outbox.push({
				sessionId: ctx.sessionManager.getSessionId(),
				kind: "heartbeat",
				data: { value: state },
			});
			flush(ctx);
		}, HEARTBEAT_INTERVAL_MS);
	};

	/** The backstop's self-check answers: is omp really out of work for this turn? */
	const selfCheckOf = (ctx: ExtensionContext): SelfCheck => ({
		isIdle: ctx.isIdle(),
		hasRunningAsyncJob: (ctx.getAsyncJobSnapshot()?.running.length ?? 0) > 0,
		hasPendingMessages: ctx.hasPendingMessages(),
	});

	/**
	 * Apply one event and report only a real change: guards (subagent, scheduled
	 * continuation, self-check) and same-value de-bouncing both live in `./state`.
	 */
	const applyStateEvent = (ctx: ExtensionContext, event: StateEvent): void => {
		if (!armed) return;
		const change = transitionState(state, event);
		if (change === undefined) return;
		state = change.value;
		pushState(ctx, change.value, change.reason);
	};

	/** Register snapshot; empty optional fields are omitted, never sent as `null`. */
	const registerData = (ctx: ExtensionContext): Record<string, unknown> => {
		const data: Record<string, unknown> = { cwd: ctx.cwd };
		const sessionName = ctx.sessionManager.getSessionName();
		if (typeof sessionName === "string" && sessionName.length > 0) data.sessionName = sessionName;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (typeof sessionFile === "string" && sessionFile.length > 0) data.sessionFile = sessionFile;
		const model = ctx.model?.name;
		if (typeof model === "string" && model.length > 0) data.model = model;
		data.pid = process.pid;
		return data;
	};

	/**
	 * Arm: register first and mark 已接入 only on success. Re-arming re-sends
	 * `register` (never `unregister` first), which is also the reconnect after an
	 * omp-bot restart.
	 */
	const arm = async (ctx: ExtensionContext): Promise<void> => {
		const sessionId = ctx.sessionManager.getSessionId();
		const envelope: PushEnvelope = {
			sessionId,
			kind: "register",
			data: registerData(ctx),
		};
		const outcome = await pushEvent(config.endpoint, envelope, REGISTER_TIMEOUT_MS).catch(() => undefined);
		const registered = outcome === undefined ? undefined : readRegisterOutcome(outcome);
		if (registered === undefined) {
			// Failure leaves this session 未接入 — including a re-arm that failed.
			disarmLocally(ctx);
			ctx.ui.notify(ARM_FAILED_MESSAGE, "error");
			return;
		}
		armed = true;
		armedSessionId = sessionId;
		// Reconnect semantics: a successful register is also a fresh start for the
		// failure budget and for anything still queued from before it.
		resetHealth(health);
		outbox.clear();
		ctx.ui.setStatus(STATUS_KEY, ARMED_STATUS);
		ctx.ui.notify(armConnectedMessage(registered.onlineCount));
		// Self-checked initial value: arming mid-stream reports 工作中, never a fake
		// 空闲. 总是上报一次（重复 arm 是面板视角的重连，行刚被重新注册），去抖只作用于
		// 随后的事件迁移与心跳。
		state = ctx.isIdle() ? "idle" : "working";
		pushState(ctx, state, "register");
		startHeartbeat(ctx);
	};

	/**
	 * Offline: drop the local switch at once — never wait for the network — then
	 * remove the panel row best-effort. Only an armed session has a row to
	 * remove, so a session that was never armed does no network work at all.
	 * This `unregister` is awaited directly, outside the outbox: its failure is
	 * reported on its own and never counts toward the auto-disarm budget.
	 */
	const offline = async (ctx: ExtensionContext): Promise<void> => {
		if (!disarmLocally(ctx)) return;
		const envelope: PushEnvelope = { sessionId: ctx.sessionManager.getSessionId(), kind: "unregister" };
		try {
			await pushEvent(config.endpoint, envelope, UNREGISTER_TIMEOUT_MS);
		} catch {
			ctx.ui.notify(OFFLINE_UNREACHABLE_MESSAGE, "error");
			return;
		}
		// Any HTTP answer means the panel is reachable: the row is gone even for a
		// non-2xx answer such as `404` after an omp-bot restart.
		ctx.ui.notify(OFFLINE_DISCONNECTED_MESSAGE);
	};

	/**
	 * 会话内切换（`session_switch`/`session_branch` 的钩子）：切换、恢复或派生到另一个
	 * 会话时，旧会话的行必须干净退场，新会话保持未接入。
	 *
	 * 只在当前 `getSessionId()` ≠ arm 时记录的 id 才动手 —— `/reload`、同文件
	 * `/resume`、`/clear`、TUI `/branch`、`/tree` 这类 id 不变的操作是彻底的 no-op，
	 * 绝不打断已接入状态。未接入（`armedSessionId === undefined`）同样零动作：不发请求、
	 * 不碰定时器；用户没接入时该功能完全不存在。
	 *
	 * 清场先于网络：`unregister` 是尽力而为，指向**旧** id（新会话还没有行，用当前 id
	 * 只会 404），结果静默 —— 既不计入失败预算，也不触发自动 disarm 通知；漏掉的旧行
	 * 由面板的 30s 过期兜底。
	 */
	const onSessionSwitch = async (_event: unknown, ctx: ExtensionContext): Promise<void> => {
		const switchedFrom = armedSessionId;
		if (switchedFrom === undefined) return;
		if (!isSessionSwitched(switchedFrom, ctx.sessionManager.getSessionId())) return;
		disarmLocally(ctx);
		ctx.ui.notify(SESSION_SWITCHED_MESSAGE);
		try {
			await pushEvent(config.endpoint, { sessionId: switchedFrom, kind: "unregister" }, UNREGISTER_TIMEOUT_MS);
		} catch {
			// best-effort：面板没响应就交给过期扫描。
		}
	};

	pi.registerCommand("connect-bot", {
		description: "把当前会话接入 omp-bot 面板；/connect-bot offline 断开",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const gate = commandGate(ctx);
			if (!gate.allowed) {
				// No UI at all: refuse on stderr, change nothing, send nothing.
				if (gate.reason === "no-ui") console.error(gate.message);
				return;
			}
			const command = parseCommand(args);
			if (command.kind === "unknown") {
				ctx.ui.notify(unknownArgumentHint(command.argument), "error");
				return;
			}
			await (command.kind === "arm" ? arm(ctx) : offline(ctx));
		},
	});

	// ── State machine wiring: main-agent turns drive 空闲/工作中/等待用户输入 ──
	// Factories are rebound per subagent session, so every handler re-checks
	// `ctx.agent.kind === "main"` through the shared transition rules.

	// 会话内切换：接入状态属于本闭包（本会话），所以切换即断开只作用于自己的行，
	// 一个窗口的状态不会影响别的窗口；切换后的新会话默认未接入。
	pi.on("session_switch", onSessionSwitch);
	pi.on("session_branch", onSessionSwitch);

	pi.on("agent_start", (_event, ctx: ExtensionContext) => {
		applyStateEvent(ctx, { kind: "agent_start", agentKind: ctx.agent.kind });
	});

	// Main path: omp awaits `session_stop` at a real settle (subagents never see
	// it). This handler never returns `continue`/`block`, so the settle it sees
	// is the terminal one; the `agent_end` of the same settle then reports the
	// same value and is de-bounced away.
	pi.on("session_stop", (_event, ctx: ExtensionContext) => {
		applyStateEvent(ctx, { kind: "session_stop", agentKind: ctx.agent.kind });
	});

	// Backstop: the terminal shapes that never emit `session_stop` (no assistant
	// message, skipped post-turn maintenance, yield, compaction dead-ends, a
	// trailing toolCall, abort, subagent). A scheduled continuation carries
	// `willContinue: true` and is never mistaken for a turn end, and the
	// self-check keeps 工作中 while the session still has work to wake for.
	pi.on("agent_end", (event: AgentEndEvent, ctx: ExtensionContext) => {
		applyStateEvent(ctx, {
			kind: "agent_end",
			agentKind: ctx.agent.kind,
			willContinue: event.willContinue,
			selfCheck: selfCheckOf(ctx),
		});
	});
}
