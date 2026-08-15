import { describe, test, expect } from "bun:test";

import { capMaxTokens, narrowTools, toolNameOf } from "../../extensions/anchored-standard/transform";
import { DEFAULT_CONFIG } from "../../extensions/anchored-standard/config";

const config = { ...DEFAULT_CONFIG, promoteEvents: [] };

describe("toolNameOf", () => {
	test("reads the flat shape", () => {
		expect(toolNameOf({ name: "read" })).toBe("read");
	});

	test("reads the nested chat-completions shape", () => {
		expect(toolNameOf({ type: "function", function: { name: "bash" } })).toBe("bash");
	});

	test("returns undefined for unknown shapes", () => {
		expect(toolNameOf({ type: "function" })).toBeUndefined();
		expect(toolNameOf("read")).toBeUndefined();
		expect(toolNameOf(null)).toBeUndefined();
	});
});

describe("capMaxTokens", () => {
	test("caps max_tokens (anthropic)", () => {
		const result = capMaxTokens({ model: "m", max_tokens: 64000 }, 1024);
		expect(result.payload).toEqual({ model: "m", max_tokens: 1024 });
		expect(result.unrecognized).toBe(false);
	});

	test("caps max_completion_tokens (chat completions)", () => {
		const result = capMaxTokens({ model: "m", max_completion_tokens: 8192 }, 1024);
		expect(result.payload).toEqual({ model: "m", max_completion_tokens: 1024 });
	});

	test("caps max_output_tokens (responses)", () => {
		const result = capMaxTokens({ model: "m", max_output_tokens: 32768 }, 1024);
		expect(result.payload).toEqual({ model: "m", max_output_tokens: 1024 });
	});

	test("never raises an existing lower value", () => {
		const payload = { model: "m", max_tokens: 512 };
		const result = capMaxTokens(payload, 1024);
		expect(result.payload).toBe(payload);
	});

	test("unrecognized shapes are untouched and flagged", () => {
		const payload = { model: "m", tools: [] };
		const result = capMaxTokens(payload, 1024);
		expect(result.payload).toBe(payload);
		expect(result.unrecognized).toBe(true);
	});

	test("non-object payloads are untouched", () => {
		const result = capMaxTokens(null, 1024);
		expect(result.payload).toBe(null);
		expect(result.unrecognized).toBe(false);
	});
});

describe("narrowTools", () => {
	test("keeps exactly one shell plus common tools (flat shape)", () => {
		const payload = { model: "m", tools: [{ name: "read" }, { name: "bash" }, { name: "edit" }, { name: "grep" }] };
		const result = narrowTools(payload, config);
		expect(result.degraded).toBeNull();
		expect(result.payload).toEqual({ model: "m", tools: [{ name: "read" }, { name: "bash" }] });
	});

	test("keeps exactly one shell plus common tools (nested shape)", () => {
		const payload = {
			model: "m",
			tools: [
				{ type: "function", function: { name: "read" } },
				{ type: "function", function: { name: "bash" } },
				{ type: "function", function: { name: "write" } },
			],
		};
		const result = narrowTools(payload, config);
		expect(result.payload).toEqual({
			model: "m",
			tools: [
				{ type: "function", function: { name: "read" } },
				{ type: "function", function: { name: "bash" } },
			],
		});
	});

	test("a missing shell degrades with the diagnosis", () => {
		const payload = { model: "m", tools: [{ name: "read" }, { name: "edit" }] };
		const result = narrowTools(payload, config);
		expect(result.payload).toBe(payload);
		expect(result.degraded).toEqual({ shells: [], missing: [] });
	});

	test("two present shells degrade with the diagnosis", () => {
		const payload = { model: "m", tools: [{ name: "read" }, { name: "bash" }, { name: "pwsh" }] };
		const result = narrowTools(payload, config);
		expect(result.payload).toBe(payload);
		expect(result.degraded).toEqual({ shells: ["bash", "pwsh"], missing: [] });
	});

	test("a missing common tool degrades with the diagnosis", () => {
		const payload = { model: "m", tools: [{ name: "bash" }, { name: "edit" }] };
		const result = narrowTools(payload, config);
		expect(result.payload).toBe(payload);
		expect(result.degraded).toEqual({ shells: ["bash"], missing: ["read"] });
	});

	test("payloads without a tools array are untouched", () => {
		const payload = { model: "m", messages: [] };
		const result = narrowTools(payload, config);
		expect(result.payload).toBe(payload);
		expect(result.degraded).toBeNull();
	});

	test("an already-narrow catalog is left identical", () => {
		const payload = { model: "m", tools: [{ name: "read" }, { name: "bash" }] };
		const result = narrowTools(payload, config);
		expect(result.payload).toBe(payload);
		expect(result.degraded).toBeNull();
	});
});
