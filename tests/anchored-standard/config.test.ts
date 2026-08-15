import { describe, test, expect } from "bun:test";

import {
	DEFAULT_CONFIG,
	loadConfig,
	parseEnabled,
	parsePersonaText,
	validateConfig,
} from "../../extensions/anchored-standard/config";
import { removeFile, tempFilePath, writeTextFile } from "./helpers";

const LEGACY_KEYS = {
	promoteOn: "never",
	bootstrapMaxTokens: 0,
	restoreMode: "magic",
	shellTools: [],
	commonTools: ["none"],
};

describe("defaults", () => {
	test("the default config carries the agreed values", () => {
		expect(DEFAULT_CONFIG).toEqual({
			enabled: true,
			personaText: "You are a helpful software engineer assistant.",
		});
	});
});

describe("validators", () => {
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
		expect(() => validateConfig({ enabled: "on" })).toThrow(/enabled/);
		expect(() => validateConfig({ personaText: "" })).toThrow(/personaText/);
	});

	test("retired config keys are silently ignored", () => {
		expect(validateConfig({ ...DEFAULT_CONFIG, ...LEGACY_KEYS })).toEqual({ ...DEFAULT_CONFIG });
	});
});

describe("loadConfig", () => {
	test("a missing file falls back to defaults with missing=true", async () => {
		const loaded = await loadConfig(tempFilePath("missing"));
		expect(loaded.missing).toBe(true);
		expect(loaded.config).toEqual({ ...DEFAULT_CONFIG });
	});

	test("a valid file loads and validates", async () => {
		const path = tempFilePath("valid");
		await writeTextFile(path, JSON.stringify({ enabled: true, personaText: "Custom." }));
		try {
			const loaded = await loadConfig(path);
			expect(loaded.missing).toBe(false);
			expect(loaded.config).toEqual({ enabled: true, personaText: "Custom." });
		} finally {
			await removeFile(path);
		}
	});

	test("legacy config files load with retired keys ignored", async () => {
		const path = tempFilePath("legacy");
		await writeTextFile(path, JSON.stringify({ ...DEFAULT_CONFIG, ...LEGACY_KEYS, personaText: "Legacy persona." }));
		try {
			const loaded = await loadConfig(path);
			expect(loaded.missing).toBe(false);
			expect(loaded.config).toEqual({ enabled: true, personaText: "Legacy persona." });
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
		await writeTextFile(path, JSON.stringify({ enabled: "on" }));
		try {
			await expect(loadConfig(path)).rejects.toThrow(/enabled/);
		} finally {
			await removeFile(path);
		}
	});
});
