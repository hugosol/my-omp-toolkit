/**
 * The connect-bot state machine: the three agent states the panel renders for
 * this session.
 *
 * Pure — no network, no UI, no timers. `index.ts` reads omp's context
 * (`ctx.isIdle()`, `ctx.getAsyncJobSnapshot()`, `ctx.hasPendingMessages()`) and
 * hands the answers here, so every rule below is exercised without a session.
 *
 * `state.value` is a closed three-value enum. keepAlive (在线/离线) is the
 * orthogonal axis the panel judges from heartbeats and never enters here.
 *
 * | 触发 | 条件 | 迁移 |
 * |---|---|---|
 * | register 成功 | `ctx.isIdle()` 为 true | → `idle` |
 * | register 成功 | `ctx.isIdle()` 为 false | → `working` |
 * | `agent_start` | main | 任意 → `working` |
 * | 轮次结束（主） | `session_stop`，handler 不返回 `continue`/`block`，main | `working` → `awaiting-input` |
 * | 轮次结束（兜底） | `agent_end && willContinue !== true`，main，自检门通过 | `working` → `awaiting-input` |
 *
 * The two register rows are the arm-time initial value (the wiring takes it
 * from `ctx.isIdle()`); {@link transitionState} covers the three events after
 * it. The two turn-end rows are the only way into `awaiting-input`: it is never
 * back-filled from session history, so arming into a session that already ran
 * reads `idle`, not 等待用户输入. The backstop row covers the terminal shapes
 * that never emit `session_stop` — no assistant message,
 * skip-post-turn-maintenance, successful yield, compaction dead-ends
 * (`deferredHandoff`/`automaticContinuationBlocked`), a trailing `toolCall`,
 * abort, and subagent sessions (excluded by the main guard).
 */

/** 三值封闭枚举；keepAlive（在线/离线）是正交轴，永不进这里。 */
export type StateValue = "working" | "awaiting-input" | "idle";

/** `state.reason?` 的触发源。仅供调试，面板提示不依赖它。 */
export type StateReason = "register" | "agent_start" | "session_stop" | "agent_end";

/** omp's session identity; only a `main` session drives this machine. */
export type AgentKind = "main" | "sub";

/**
 * `ctx.isIdle()` plus the two other self-check answers. `isIdle` alone says
 * nothing about async jobs or queued input, so a settle that still has either
 * is not the end of the turn.
 */
export interface SelfCheck {
	isIdle: boolean;
	/** `ctx.getAsyncJobSnapshot().running` 非空：后台任务会唤醒该会话。 */
	hasRunningAsyncJob: boolean;
	/** `ctx.hasPendingMessages()`：队列里的输入会让会话自己继续跑。 */
	hasPendingMessages: boolean;
}

/** 会驱动迁移的事件。arm 不走这里，用 `ctx.isIdle()` 取初始值。 */
export type StateEvent =
	| { kind: "agent_start"; agentKind: AgentKind }
	| { kind: "session_stop"; agentKind: AgentKind }
	| { kind: "agent_end"; agentKind: AgentKind; willContinue?: boolean; selfCheck: SelfCheck };

/** 一次要上报的状态。 */
export interface StateChange {
	value: StateValue;
	reason: StateReason;
}

/**
 * 事件 → 下一次上报。`undefined` 都表示「不上报」，两种来源：守卫拦下（子代理、
 * 自动重试/自动续跑、自检门未通过），或 `state.value` 没变（去抖：同值不迁移、
 * 不重复上报、不重复提示）。
 */
export function transitionState(current: StateValue | undefined, event: StateEvent): StateChange | undefined {
	const value = nextValue(event);
	if (value === undefined || value === current) return undefined;
	return { value, reason: event.kind };
}

/** 事件的目标值；`undefined` = 该事件不该改变状态。 */
function nextValue(event: StateEvent): StateValue | undefined {
	switch (event.kind) {
		case "agent_start":
			return event.agentKind === "main" ? "working" : undefined;
		case "session_stop":
			// 只有 main 会收到 `session_stop`；这里的守卫是防御性的，与兜底同规则。
			return event.agentKind === "main" ? "awaiting-input" : undefined;
		case "agent_end":
			if (event.agentKind !== "main") return undefined;
			// 自动重试/自动续跑：omp 已排好下一次，不是用户可见的轮次结束。
			if (event.willContinue === true) return undefined;
			// 自检门：空闲、无 running async job、无 pending messages 才算真的停下 ——
			// 对齐 omp 对 `session_stop` 的推迟语义，还有后台唤醒的会话不算轮次结束。
			const { isIdle, hasRunningAsyncJob, hasPendingMessages } = event.selfCheck;
			return isIdle && !hasRunningAsyncJob && !hasPendingMessages ? "awaiting-input" : undefined;
	}
}

/**
 * `session_switch`/`session_branch` 的判定：当前会话 id 与 arm 时记录的不同即为切换。
 * 未接入没有要断开的行，所以 `armedId` 为 `undefined` 时永远不是切换。
 */
export function isSessionSwitched(armedId: string | undefined, currentId: string): boolean {
	if (armedId === undefined) return false;
	return armedId !== currentId;
}
