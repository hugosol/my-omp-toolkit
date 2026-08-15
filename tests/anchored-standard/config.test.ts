import { describe, test, expect } from "bun:test";

import {
	DEFAULT_CONFIG,
	PROMOTE_EVENTS,
	loadConfig,
	parseEnabled,
	parsePersonaText,
	parsePromoteOn,
	parseRestoreMode,
	positiveInt,
	stringList,
	validateConfig,
} from "../../extensions/anchored-standard/config";
import { readTextFile, removeFile, tempFilePath, writeTextFile } from "./helpers";

describe("defaults", () => {
	test("the default config carries the agreed values", () => {
		expect(DEFAULT_CONFIG).toEqual({
			enabled: true,
			promoteOn: "either",
			bootstrapMaxTokens: 1024,
			personaText: "You are a helpful software engineer assistant.",
			restoreMode: "append",
			shellTools: ["bash", "pwsh"],
			commonTools: ["read"],
		});
	});
});

describe("validators", () => {
	test("stringList deduplicates and rejects bad input", () => {
		expect(stringList(["a", "b", "a"], "field")).toEqual(["a", "b"]);
		expect(() => stringList([], "field")).toThrow(/field/);
		expect(() => stringList(["a", 1], "field")).toThrow(/field/);
		expect(() => stringList("nope", "field")).toThrow(/field/);
	});

	test("parsePromoteOn accepts the three modes and rejects others", () => {
		expect(parsePromoteOn(undefined)).toBe(PROMOTE_EVENTS.either);
		expect(parsePromoteOn("either")).toBe(PROMOTE_EVENTS.either);
		expect(parsePromoteOn("tool-call")).toBe(PROMOTE_EVENTS["tool-call"]);
		expect(parsePromoteOn("assistant-message")).toBe(PROMOTE_EVENTS["assistant-message"]);
		expect(() => parsePromoteOn("never")).toThrow(/promoteOn/);
	});

	test("positiveInt accepts safe positive integers only", () => {
		expect(positiveInt(undefined, "field", 42)).toBe(42);
		expect(positiveInt(7, "field", 42)).toBe(7);
		expect(() => positiveInt(0, "field", 42)).toThrow(/field/);
		expect(() => positiveInt(-1, "field", 42)).toThrow(/field/);
		expect(() => positiveInt(1.5, "field", 42)).toThrow(/field/);
		expect(() => positiveInt("1024", "field", 42)).toThrow(/field/);
	});

	test("parseRestoreMode accepts the three modes and rejects others", () => {
		expect(parseRestoreMode(undefined)).toBe("append");
		expect(parseRestoreMode("system-block")).toBe("system-block");
		expect(parseRestoreMode("none")).toBe("none");
		expect(() => parseRestoreMode("magic")).toThrow(/restoreMode/);
	});

	test("parseEnabled accepts booleans only", () => {
		expect(parseEnabled(undefined)).toBe(true);
		expect(parseEnabled(false)).toBe(false);
		expect(() => parseEnabled("yes")).toThrow(/enabled/);
	});

	test("parsePersonaText requires a non-empty string", () => {
		expect(parsePersonaText(undefined)).toBe("You are a helpful software engineer assistant.");
		expect(parsePersonaText("Custom.")).toBe("Custom.");
		expect(() => parsePersonaText("")).toThrow(/personaText/);
		expect(() => parsePersonaText(5)).toThrow(/personaText/);
	});

	test("validateConfig rejects non-object content", () => {
		expect(() => validateConfig(null)).toThrow(/object/);
		expect(() => validateConfig([])).toThrow(/object/);
	});

	test("validateConfig passes every invalid field through its validator", () => {
		const base = { ...DEFAULT_CONFIG };
		expect(() => validateConfig({ ...base, promoteOn: "never" })).toThrow(/promoteOn/);
		expect(() => validateConfig({ ...base, bootstrapMaxTokens: 0 })).toThrow(/bootstrapMaxTokens/);
		expect(() => validateConfig({ ...base, shellTools: [] })).toThrow(/shellTools/);
		expect(() => validateConfig({ ...base, restoreMode: "x" })).toThrow(/restoreMode/);
		expect(() => validateConfig({ ...base, enabled: "on" })).toThrow(/enabled/);
	});
});

describe("loadConfig", () => {
	test("a missing file falls back to defaults with missing=true", async () => {
		const loaded = await loadConfig(tempFilePath("missing"));
		expect(loaded.missing).toBe(true);
		expect(loaded.config).toEqual({ ...DEFAULT_CONFIG, promoteEvents: PROMOTE_EVENTS.either });
	});

	test("a valid file loads and validates", async () => {
		const path = tempFilePath("valid");
		await writeTextFile(path, JSON.stringify({ ...DEFAULT_CONFIG, bootstrapMaxTokens: 2048, restoreMode: "none" }));
		try {
			const loaded = await loadConfig(path);
			expect(loaded.missing).toBe(false);
			expect(loaded.config.bootstrapMaxTokens).toBe(2048);
			expect(loaded.config.restoreMode).toBe("none");
		} finally {
			await removeFile(path);
		}
	});

	test("malformed JSON throws", async () => {
		const path = tempFilePath("malformed");
		await writeTextFile(path, "{ not json");
		try {
			await expect(loadConfig(path)).rejects.toThrow();
		} finally {
			await removeFile(path);
		}
	});

	test("invalid values throw at load time", async () => {
		const path = tempFilePath("invalid");
		await writeTextFile(path, JSON.stringify({ ...DEFAULT_CONFIG, promoteOn: "never" }));
		try {
			await expect(loadConfig(path)).rejects.toThrow(/promoteOn/);
		} finally {
			await removeFile(path);
		}
	});
});
