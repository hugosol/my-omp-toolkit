import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
	checkTranscriptBootstrap,
	checkWireBootstrap,
	countMarkers,
	parseSession,
	parseWireRequests,
	readBootstrapExpectation,
} from "./bench-anchor-style";

const EXPECTATION = {
	shellTools: ["bash", "pwsh"],
	commonTools: ["read"],
	bootstrapMaxTokens: 1024,
};

function messageEntry(message: Record<string, unknown>): string {
	return JSON.stringify({ type: "message", id: "m", message }) + "\n";
}

function withSession(entries: string[], fn: (file: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "bench-parser-"));
	const file = join(dir, "session.jsonl");
	try {
		writeFileSync(file, entries.join(""));
		fn(file);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("countMarkers", () => {
	test("counts we/we need/let's/let me case-insensitively", () => {
		const counts = countMarkers("We need to plan. Let's do it. Let me check. We then move on.");
		expect(counts).toEqual({ we: 2, weNeed: 1, lets: 1, letMe: 1 });
	});

	test("accepts lets without apostrophe and ignores we inside other words", () => {
		const counts = countMarkers("welcome, lets go, swept");
		expect(counts.lets).toBe(1);
		expect(counts.we).toBe(0);
	});
});

describe("parseSession", () => {
	test("extracts thinking, tool calls, and visible replies per assistant request", () => {
		withSession(
			[
				messageEntry({
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "We need to read." },
						{ type: "toolCall", id: "t1", name: "read", arguments: {} },
						{ type: "toolCall", id: "t2", name: "read", arguments: {} },
					],
				}),
				messageEntry({ role: "tool", content: [] }),
				messageEntry({
					role: "assistant",
					content: [{ type: "text", text: "done" }],
				}),
				messageEntry({ role: "user", content: [{ type: "text", text: "next" }] }),
			],
			file => {
				const requests = parseSession(file);
				expect(requests).toHaveLength(2);
				expect(requests[0]).toMatchObject({
					request: 1,
					reasoningBlocks: 1,
					visibleReplies: 0,
					toolNames: ["read"],
					markers: { we: 1, weNeed: 1 },
				});
				expect(requests[1]).toMatchObject({ request: 2, reasoningBlocks: 0, visibleReplies: 1 });
			},
		);
	});

	test("ignores non-JSON lines and non-message entries", () => {
		withSession(
			[
				"not json\n",
				JSON.stringify({ type: "session", version: 0 }) + "\n",
				messageEntry({ role: "assistant", content: [{ type: "text", text: "ok" }] }),
			],
			file => {
				expect(parseSession(file)).toHaveLength(1);
			},
		);
	});
});

describe("parseWireRequests", () => {
	test("parses probe lines and skips malformed ones", () => {
		const stderr = [
			'other output ANCHOR_PROBE {"request":1,"tools":["read","bash"],"max":1024}\n',
			'ANCHOR_PROBE {"request":2,"tools":["write"],"max":64000}\n',
			"ANCHOR_PROBE {broken}\n",
		].join("");
		expect(parseWireRequests(stderr)).toEqual([
			{ request: 1, tools: ["read", "bash"], maxTokens: 1024 },
			{ request: 2, tools: ["write"], maxTokens: 64000 },
		]);
	});
});

describe("checkWireBootstrap", () => {
	test("anchored signature: first request inside + capped, later request opened", () => {
		const check = checkWireBootstrap(
			[
				{ request: 1, tools: ["read", "bash"], maxTokens: 1024 },
				{ request: 2, tools: ["read", "bash", "write"], maxTokens: 64000 },
			],
			EXPECTATION,
		);
		expect(check).toEqual({ firstRequestInsideBootstrap: true, firstRequestCapped: true, opened: true });
	});

	test("control signature: full catalog and uncapped from request #1", () => {
		const check = checkWireBootstrap(
			[{ request: 1, tools: ["read", "bash", "write"], maxTokens: 64000 }],
			EXPECTATION,
		);
		expect(check).toEqual({ firstRequestInsideBootstrap: false, firstRequestCapped: false, opened: false });
	});
});

describe("checkTranscriptBootstrap", () => {
	test("text-only first reply has nothing to check", () => {
		const check = checkTranscriptBootstrap(
			[{ request: 1, reasoningBlocks: 0, thinkingChars: 0, visibleReplies: 1, visibleChars: 2, toolNames: [], markers: { we: 0, weNeed: 0, lets: 0, letMe: 0 } }],
			EXPECTATION,
		);
		expect(check.firstRequestCalledTools).toBe(false);
	});
});

describe("readBootstrapExpectation", () => {
	test("shipped config exposes non-empty bootstrap catalog and positive cap", () => {
		const expectation = readBootstrapExpectation();
		expect(expectation.shellTools.length).toBeGreaterThan(0);
		expect(expectation.commonTools.length).toBeGreaterThan(0);
		expect(expectation.bootstrapMaxTokens).toBeGreaterThan(0);
	});
});
