/**
 * The connect-bot outbound outbox as a pure module: ordered delivery, the
 * bounded queue and the 「满时丢最旧 heartbeat」 policy.
 *
 * The bound is what makes 「不缓冲/不重试」 precise — nothing is retried and the
 * queue never grows without end. It cannot be driven through the extension seam
 * at all: the push budget (1.5s) is always shorter than the heartbeat period
 * (10s), so no panel state can ever let 16 pushes pile up, and `state` events
 * are de-bounced on top of that. The policy is therefore exercised here, on the
 * queue itself; the failure budget it feeds is asserted at the extension seam.
 *
 * Run: bun test tests/connect-bot/
 */
import { describe, expect, test } from "bun:test";

import type { PushEnvelope } from "../../extensions/connect-bot/client";
import { Outbox } from "../../extensions/connect-bot/connection";

/** spec/lighthouse: 队列上限 ~16，满时丢最旧 `heartbeat`. */
const QUEUE_LIMIT = 16;

const heartbeat = (): PushEnvelope => ({ sessionId: "s", kind: "heartbeat", data: { value: "working" } });
const state = (value: string): PushEnvelope => ({ sessionId: "s", kind: "state", data: { value } });

/** Drain the queue in send order, the way the single flusher does. */
function drain(outbox: Outbox): PushEnvelope[] {
	const sent: PushEnvelope[] = [];
	for (let envelope = outbox.shift(); envelope !== undefined; envelope = outbox.shift()) sent.push(envelope);
	return sent;
}

describe("Outbox", () => {
	test("hands events to the flusher in enqueue order", () => {
		const outbox = new Outbox();
		outbox.push(state("a"));
		outbox.push(heartbeat());
		outbox.push(state("b"));

		expect(drain(outbox)).toEqual([state("a"), heartbeat(), state("b")]);
		expect(outbox.shift()).toBeUndefined();
	});

	test("stays bounded at ~16 by dropping the oldest heartbeat", () => {
		const outbox = new Outbox();
		outbox.push(heartbeat());
		for (let i = 0; i < QUEUE_LIMIT - 1; i += 1) outbox.push(state(`s${i}`));
		expect(drain(outbox)).toHaveLength(QUEUE_LIMIT);

		// A 17th event must not grow the queue: the oldest heartbeat goes instead.
		const full = new Outbox();
		full.push(heartbeat());
		for (let i = 0; i < QUEUE_LIMIT - 1; i += 1) full.push(state(`s${i}`));
		full.push(state("newest"));

		const sent = drain(full);
		expect(sent).toHaveLength(QUEUE_LIMIT);
		expect(sent.some(envelope => envelope.kind === "heartbeat")).toBe(false);
		expect(sent[0]).toEqual(state("s0"));
		expect(sent.at(-1)).toEqual(state("newest"));
	});

	test("drops an older heartbeat rather than an older state event", () => {
		const outbox = new Outbox();
		outbox.push(state("old"));
		for (let i = 0; i < QUEUE_LIMIT - 1; i += 1) outbox.push(heartbeat());
		outbox.push(state("newest"));

		const sent = drain(outbox);
		expect(sent).toHaveLength(QUEUE_LIMIT);
		// 丢的是最旧 heartbeat：最旧的 state 仍在队首，且只剩 15 条心跳。
		expect(sent[0]).toEqual(state("old"));
		expect(sent.filter(envelope => envelope.kind === "heartbeat")).toHaveLength(QUEUE_LIMIT - 2);
	});

	test("clear() drops everything pending", () => {
		const outbox = new Outbox();
		outbox.push(state("a"));
		outbox.push(heartbeat());

		outbox.clear();

		expect(outbox.shift()).toBeUndefined();
	});
});
