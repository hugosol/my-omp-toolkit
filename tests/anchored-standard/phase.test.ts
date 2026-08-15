import { describe, test, expect } from "bun:test";

import {
	createPhaseTracker,
	hasSessionContext,
	isSubagent,
	scanPromotion,
	type AgentRegistryLike,
	type PhaseContext,
} from "../../extensions/anchored-standard/phase";

const ctx = (entries: unknown[] = [], options: { id?: string; file?: string } = {}): PhaseContext => ({
	sessionManager: {
		getSessionId: () => options.id ?? "s1",
		getSessionFile: () => options.file,
		getEntries: () => entries,
	},
});

const userEntry = { type: "message", id: "u", message: { role: "user", content: [{ type: "text", text: "hi" }] } };
const assistantEntry = (blocks: unknown[] = []) => ({
	type: "message",
	id: "a",
	message: { role: "assistant", content: [{ type: "text", text: "ok" }, ...blocks] },
});
const toolCallBlock = { type: "toolCall", id: "t1", name: "read", arguments: {} };

const registry = (refs: Array<{ kind?: string; sessionFile?: string | null }>): AgentRegistryLike => ({
	list: () => refs,
});

describe("scanPromotion", () => {
	test("an assistant message promotes, with or without tool calls", () => {
		expect(scanPromotion([assistantEntry([])])).toBe(true);
		expect(scanPromotion([assistantEntry([toolCallBlock])])).toBe(true);
	});

	test("user messages never promote", () => {
		expect(scanPromotion([userEntry])).toBe(false);
	});

	test("non-message and malformed entries are skipped", () => {
		expect(scanPromotion([{ type: "model_change" }])).toBe(false);
		expect(scanPromotion([null, { type: "message" }, { type: "message", message: { role: "user" } }])).toBe(false);
	});
});

describe("isSubagent", () => {
	test("registry kind sub matches by session file", () => {
		expect(isSubagent(ctx([], { id: "sub1", file: "/sessions/sub.jsonl" }), registry([{ kind: "sub", sessionFile: "/sessions/sub.jsonl" }]))).toBe(true);
	});

	test("registry kind main matches by session file", () => {
		expect(isSubagent(ctx([], { id: "s1", file: "/sessions/s1.jsonl" }), registry([{ kind: "main", sessionFile: "/sessions/s1.jsonl" }]))).toBe(false);
	});

	test("an unavailable registry falls back to main semantics", () => {
		expect(isSubagent(ctx(), undefined)).toBe(false);
	});

	test("an unmatched session falls back to main semantics", () => {
		expect(isSubagent(ctx([], { file: "/sessions/other.jsonl" }), registry([{ kind: "sub", sessionFile: "/sessions/sub.jsonl" }]))).toBe(false);
	});
});

describe("createPhaseTracker", () => {
	const trackerFor = (refs: Array<{ kind?: string; sessionFile?: string | null }> = []) =>
		createPhaseTracker(() => registry(refs));

	test("unpromoted sessions are not promoted", () => {
		const tracker = trackerFor();
		expect(tracker.isPromoted(ctx([]))).toBe(false);
	});

	test("an assistant message promotes and memoizes", () => {
		const tracker = trackerFor();
		expect(tracker.isPromoted(ctx([assistantEntry([])]))).toBe(true);
		// Memoized: same id answers without rescanning.
		expect(tracker.isPromoted(ctx([]))).toBe(true);
	});

	test("sessions promote independently by id", () => {
		const tracker = trackerFor();
		expect(tracker.isPromoted(ctx([assistantEntry([])], { id: "s1" }))).toBe(true);
		expect(tracker.isPromoted(ctx([], { id: "s2" }))).toBe(false);
	});

	test("subagents are always promoted", () => {
		const tracker = trackerFor([{ kind: "sub", sessionFile: "/sessions/sub.jsonl" }]);
		expect(tracker.isPromoted(ctx([], { id: "sub1", file: "/sessions/sub.jsonl" }))).toBe(true);
	});

	test("sessions without a readable context are promoted", () => {
		const tracker = trackerFor();
		expect(tracker.isPromoted({})).toBe(true);
		expect(tracker.isPromoted({ sessionManager: { getSessionId: () => "" } })).toBe(true);
	});

	test("a scan failure degrades to promoted", () => {
		const tracker = trackerFor();
		const broken: PhaseContext = {
			sessionManager: {
				getSessionId: () => "s1",
				getEntries: () => {
					throw new Error("scan failure");
				},
			},
		};
		expect(tracker.isPromoted(broken)).toBe(true);
	});

	test("reset drops memoized decisions", () => {
		const tracker = trackerFor();
		expect(tracker.isPromoted(ctx([assistantEntry([])]))).toBe(true);
		tracker.reset();
		expect(tracker.isPromoted(ctx([]))).toBe(false);
	});
});

describe("hasSessionContext", () => {
	test("reads the session id when present", () => {
		expect(hasSessionContext(ctx())).toBe(true);
	});

	test("rejects missing, empty, and throwing session managers", () => {
		expect(hasSessionContext({})).toBe(false);
		expect(hasSessionContext({ sessionManager: { getSessionId: () => "" } })).toBe(false);
		expect(
			hasSessionContext({
				sessionManager: {
					getSessionId: () => {
						throw new Error("boom");
					},
				},
			}),
		).toBe(false);
	});
});
