/**
 * The connect-bot state machine as a pure module: the three `state.value`s, the
 * event → state mapping, the backstop self-check gate, the change de-bounce and
 * the "did the session id change" decision.
 *
 * Every expected value here is a spec/lighthouse literal (`state.value` ∈
 * {working, awaiting-input, idle}; arm 自检值; `agent_end && willContinue !== true`
 * 经自检门兜底; 只在真变化时上报; `armedId !== currentId`), never read back out
 * of the implementation.
 *
 * Run: bun test tests/connect-bot/
 */
import { describe, expect, test } from "bun:test";

import {
	isSessionSwitched,
	transitionState,
	type SelfCheck,
	type StateEvent,
} from "../../extensions/connect-bot/state";

/** 自检门全通过：空闲、无 running async job、无 pending messages。 */
const TRULY_IDLE: SelfCheck = { isIdle: true, hasRunningAsyncJob: false, hasPendingMessages: false };

const mainAgentEnd = (willContinue: boolean | undefined, selfCheck: SelfCheck = TRULY_IDLE): StateEvent => ({
	kind: "agent_end",
	agentKind: "main",
	willContinue,
	selfCheck,
});

describe("transitionState", () => {
	test("agent_start moves a main session to 工作中 from 空闲 or 等待用户输入", () => {
		const event: StateEvent = { kind: "agent_start", agentKind: "main" };
		expect(transitionState("idle", event)).toEqual({ value: "working", reason: "agent_start" });
		expect(transitionState("awaiting-input", event)).toEqual({ value: "working", reason: "agent_start" });
	});

	test("session_stop is the main path from 工作中 to 等待用户输入", () => {
		expect(transitionState("working", { kind: "session_stop", agentKind: "main" })).toEqual({
			value: "awaiting-input",
			reason: "session_stop",
		});
	});

	test("a terminal agent_end (willContinue absent or false) is the backstop into 等待用户输入", () => {
		expect(transitionState("working", mainAgentEnd(undefined))).toEqual({
			value: "awaiting-input",
			reason: "agent_end",
		});
		expect(transitionState("working", mainAgentEnd(false))).toEqual({
			value: "awaiting-input",
			reason: "agent_end",
		});
	});

	test("an agent_end on a scheduled continuation must not report a turn end", () => {
		expect(transitionState("working", mainAgentEnd(true))).toBeUndefined();
	});

	test("the backstop self-check gate keeps 工作中 while the session will wake itself", () => {
		const notIdle: SelfCheck = { ...TRULY_IDLE, isIdle: false };
		const runningJob: SelfCheck = { ...TRULY_IDLE, hasRunningAsyncJob: true };
		const queuedInput: SelfCheck = { ...TRULY_IDLE, hasPendingMessages: true };
		expect(transitionState("working", mainAgentEnd(undefined, notIdle))).toBeUndefined();
		expect(transitionState("working", mainAgentEnd(undefined, runningJob))).toBeUndefined();
		expect(transitionState("working", mainAgentEnd(undefined, queuedInput))).toBeUndefined();
	});

	test("a subagent session never moves the machine", () => {
		// 子代理不发 session_stop，也由 main 守卫排除；三条事件都不迁移。
		expect(transitionState("working", { kind: "agent_start", agentKind: "sub" })).toBeUndefined();
		expect(transitionState("working", { kind: "session_stop", agentKind: "sub" })).toBeUndefined();
		expect(transitionState("working", { ...mainAgentEnd(undefined), agentKind: "sub" })).toBeUndefined();
	});

	test("only a real change is reported: same value is silent, whatever the trigger", () => {
		expect(transitionState("working", { kind: "agent_start", agentKind: "main" })).toBeUndefined();
		// 同一次结算里 session_stop 之后紧跟的兜底 agent_end 看到同值 → 静默。
		expect(transitionState("awaiting-input", mainAgentEnd(undefined))).toBeUndefined();
		expect(transitionState("awaiting-input", { kind: "session_stop", agentKind: "main" })).toBeUndefined();
		expect(transitionState("idle", { kind: "agent_start", agentKind: "main" })).toBeDefined();
	});
});

describe("isSessionSwitched", () => {
	const armed = "0192ce07-8c4f-7d66-afec-2482b5c9b03c";

	test("未接入 is never a switch: nothing to disconnect", () => {
		expect(isSessionSwitched(undefined, armed)).toBe(false);
	});

	test("the same session id is a no-op (/reload, /resume, /clear, TUI branch/tree)", () => {
		expect(isSessionSwitched(armed, armed)).toBe(false);
	});

	test("a different session id is a switch (/new, /resume of another file, fork, branch, /btw)", () => {
		expect(isSessionSwitched(armed, "0192ce07-8c4f-7d66-afec-2482b5c9b111")).toBe(true);
	});
});
