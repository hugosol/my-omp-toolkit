import { describe, test, expect } from "bun:test";

import {
	hasPersonaSections,
	ROLE_MARKER,
	RUNTIME_MARKER,
	stripCapturedPrompt,
	stripPersonaSections,
} from "../../extensions/anchored-standard/strip";

const CONVENTIONS = "<system-conventions>safety conventions</system-conventions>";
const PERSONA_SECTION = `${ROLE_MARKER}\npersona section text\n# Escalation`;
const RUNTIME_SECTION = `${RUNTIME_MARKER}\n<skills>read, bash, edit</skills>\n<Tool Inventory>read, bash, edit</Tool Inventory>`;
const MARKED_BLOCK = `${CONVENTIONS}\n\n${PERSONA_SECTION}\n\n${RUNTIME_SECTION}`;

describe("hasPersonaSections", () => {
	test("accepts a block with both markers in order", () => {
		expect(hasPersonaSections(MARKED_BLOCK)).toBe(true);
	});

	test("rejects missing and reversed markers", () => {
		expect(hasPersonaSections("plain text")).toBe(false);
		expect(hasPersonaSections(`${RUNTIME_MARKER}\n…\n${ROLE_MARKER}`)).toBe(false);
	});
});

describe("stripPersonaSections", () => {
	test("drops the section between § Role and § Runtime, keeps prefix and runtime tail", () => {
		expect(stripPersonaSections(MARKED_BLOCK)).toBe(`${CONVENTIONS}\n\n${RUNTIME_SECTION}`);
	});

	test("leaves blocks without markers untouched", () => {
		expect(stripPersonaSections("<repo-rules>AGENTS.md digest</repo-rules>")).toBe("<repo-rules>AGENTS.md digest</repo-rules>");
	});

	test("leaves blocks with reversed markers untouched", () => {
		const reversed = `${RUNTIME_MARKER}\nruntime first\n${ROLE_MARKER}`;
		expect(stripPersonaSections(reversed)).toBe(reversed);
	});
});

describe("stripCapturedPrompt", () => {
	test("strips marked blocks, passes unmarked blocks through, joins with double newlines", () => {
		const result = stripCapturedPrompt([MARKED_BLOCK, "<repo-rules>AGENTS.md digest</repo-rules>"]);
		expect(result.stripped).toBe(true);
		expect(result.content).toBe(`${CONVENTIONS}\n\n${RUNTIME_SECTION}\n\n<repo-rules>AGENTS.md digest</repo-rules>`);
	});

	test("reports stripped=false when no block carries the markers", () => {
		const result = stripCapturedPrompt(["<skills>read</skills>", "<repo-rules>AGENTS.md</repo-rules>"]);
		expect(result.stripped).toBe(false);
		expect(result.content).toBe("<skills>read</skills>\n\n<repo-rules>AGENTS.md</repo-rules>");
	});

	test("handles an empty block list", () => {
		const result = stripCapturedPrompt([]);
		expect(result.stripped).toBe(false);
		expect(result.content).toBe("");
	});
});
