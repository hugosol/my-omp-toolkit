/**
 * Runtime connection health for connect-bot: the heartbeat cadence, the
 * consecutive-failure budget that auto-disarms, and the bounded ordered outbox
 * every background push leaves through.
 *
 * Pure — no timer, no network, no UI. `index.ts` owns the managed
 * `ctx.setInterval`, the fetch transport and the notifications, so the whole
 * failure story below is exercised without a session.
 *
 * Locked contract (`spec.md` §心跳与失败):
 *  - 心跳周期 10s；服务端按 3×心跳（30s）判本会话离线。
 *  - 失败判据 = `fetch` reject/超时，或服务端对未知 `sessionId` 的非 `register`
 *    事件返回非 2xx；失败即丢、不重试（下一次心跳自愈）。
 *  - 连续 3 次失败（≈30s）→ 自动 disarm 并通知一次；任一成功复位计数与
 *    「首次失败已通知」标志；首次失败也通知一次。
 *  - 出站只用一个有界有序队列：上限 ~16，满时丢最旧 `heartbeat`
 *    （「不缓冲/不重试」= 不重试、不无限缓冲）。
 */
import type { PushEnvelope } from "./client";

/** 心跳周期：面板按 3×（30s）判离线，扩展按 3 次失败自动 disarm。 */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/** 连续失败上限：3 次心跳 ≈ 30s。 */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** 出站队列上限；满了丢最旧心跳（不无限缓冲）。 */
export const OUTBOX_LIMIT = 16;

/**
 * 连续失败计数与「首次失败已通知」标志。两者都只在「任一成功」时全量复位，
 * 于是断开—重连后还能再收到一次首次失败提醒。
 */
export interface ConnectionHealth {
	/** 连续失败次数；2 次时已有首次失败通知，3 次即自动 disarm。 */
	failures: number;
	/** 本失败段是否已通知过「首次失败」。 */
	firstFailureNotified: boolean;
}

/** 未接入/刚连上时的计数：没有失败，也没通知过。取用时 spread 一份可变副本。 */
export const INITIAL_HEALTH: Readonly<ConnectionHealth> = Object.freeze({
	failures: 0,
	firstFailureNotified: false,
});

/** 任一成功（非 register 事件 2xx；`register` 2xx 且回执可解析）→ 全量复位。 */
export function resetHealth(health: ConnectionHealth): void {
	health.failures = 0;
	health.firstFailureNotified = false;
}

/** 一次失败之后要做的动作。 */
export type FailureAction =
	/** 本失败段第一次失败：通知一次。 */
	| "notify-first"
	/** 第 3 次连续失败：通知一次并自动 disarm。 */
	| "notify-disarm"
	/** 已通知过、还没到自动 disarm 的中间失败。 */
	| "silent";

/** 记一次失败，返回这一次要做的动作。 */
export function recordFailure(health: ConnectionHealth): FailureAction {
	health.failures += 1;
	if (health.failures >= MAX_CONSECUTIVE_FAILURES) return "notify-disarm";
	if (health.firstFailureNotified) return "silent";
	health.firstFailureNotified = true;
	return "notify-first";
}

/**
 * 出站投递队列：push 入队即返回，由调用方的单一 flusher 按序 drain（1.5s 超时、
 * 失败即丢该条、不重试）。
 *
 * 队列满了先丢最旧 `heartbeat`——心跳是周期性的，且每次都带当前 `state.value`，
 * 所以丢掉一条旧心跳不会丢信息。队列里没有心跳时（构造上到不了：心跳是唯一周期性
 * 来源）退化为丢最旧一条，因为较新的值总是盖过较旧的值。
 */
export class Outbox {
	readonly #limit: number;
	readonly #pending: PushEnvelope[] = [];

	constructor(limit: number = OUTBOX_LIMIT) {
		this.#limit = limit;
	}

	/** 入队；队满先丢最旧 `heartbeat`。 */
	push(envelope: PushEnvelope): void {
		if (this.#pending.length >= this.#limit) {
			const heartbeat = this.#pending.findIndex(item => item.kind === "heartbeat");
			this.#pending.splice(heartbeat >= 0 ? heartbeat : 0, 1);
		}
		this.#pending.push(envelope);
	}

	/** 取下一条待发送的事件；队列空时返回 `undefined`。 */
	shift(): PushEnvelope | undefined {
		return this.#pending.shift();
	}

	/** 丢弃全部积压（disarm、offline 与重连时的旧帧都不再有价值）。 */
	clear(): void {
		this.#pending.length = 0;
	}
}
