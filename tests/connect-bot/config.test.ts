import { describe, test, expect } from "bun:test";
import * as fs from "node:fs/promises";

import {
	DEFAULT_CONFIG,
	loadConfig,
	parseEndpoint,
	validateConfig,
} from "../../extensions/connect-bot/config";

// Spec/contract literals, deliberately not read from the implementation.
const DEFAULT_ENDPOINT = "http://omp-bot.local:8787";
const OVERRIDE_ENDPOINT = "http://panel.local:9000";

// bun-only: import.meta.dir is the module's directory; TS's ImportMeta lacks it.
const meta = import.meta as unknown as { dir?: string };
const moduleDir = meta.dir ?? ".";
const shippedConfigPath = new URL("../../extensions/connect-bot/config.json", import.meta.url).pathname.replace(
	/^\/([A-Za-z]:\/)/,
	"$1",
);

function tempConfigPath(label: string): string {
	return `${moduleDir}/${label}-${crypto.randomUUID()}.json`;
}

async function withConfigFile<T>(content: string, run: (path: string) => Promise<T>): Promise<T> {
	const path = tempConfigPath("config");
	await fs.writeFile(path, content);
	try {
		return await run(path);
	} finally {
		await fs.rm(path, { force: true });
	}
}

describe("defaults", () => {
	test("the shipped default endpoint is the agreed panel address", () => {
		expect(DEFAULT_CONFIG).toEqual({ endpoint: DEFAULT_ENDPOINT });
	});
});

describe("validators", () => {
	test("parseEndpoint falls back to the default only when the key is absent", () => {
		expect(parseEndpoint(undefined)).toBe(DEFAULT_ENDPOINT);
		expect(parseEndpoint(OVERRIDE_ENDPOINT)).toBe(OVERRIDE_ENDPOINT);

		expect(() => parseEndpoint("")).toThrow(/endpoint/);
		expect(() => parseEndpoint(8787)).toThrow(/endpoint/);
	});

	test("validateConfig rejects content that is not a JSON object", () => {
		expect(() => validateConfig(null)).toThrow(/object/);
		expect(() => validateConfig([])).toThrow(/object/);
		expect(() => validateConfig(DEFAULT_ENDPOINT)).toThrow(/object/);
	});

	test("validateConfig passes an invalid endpoint through its validator", () => {
		expect(() => validateConfig({ endpoint: 8787 })).toThrow(/endpoint/);
	});

	test("unknown keys are ignored", () => {
		expect(validateConfig({ endpoint: OVERRIDE_ENDPOINT, enabled: false, proxy: false })).toEqual({
			endpoint: OVERRIDE_ENDPOINT,
		});
	});
});

describe("loadConfig", () => {
	test("a missing file falls back to the default and warns once", async () => {
		const warnings: string[] = [];

		const loaded = await loadConfig(tempConfigPath("missing"), message => warnings.push(message));

		expect(loaded.missing).toBe(true);
		expect(loaded.config).toEqual({ endpoint: DEFAULT_ENDPOINT });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("config.json");
		expect(warnings[0]).toContain(DEFAULT_ENDPOINT);
	});

	test("an override file wins over the default and does not warn", async () => {
		const warnings: string[] = [];

		const loaded = await withConfigFile(JSON.stringify({ endpoint: OVERRIDE_ENDPOINT }), path =>
			loadConfig(path, message => warnings.push(message)),
		);

		expect(loaded.missing).toBe(false);
		expect(loaded.config).toEqual({ endpoint: OVERRIDE_ENDPOINT });
		expect(warnings).toEqual([]);
	});

	test("the shipped config.json carries the single endpoint key", async () => {
		const raw: unknown = JSON.parse(await fs.readFile(shippedConfigPath, "utf8"));

		expect(raw).toEqual({ endpoint: DEFAULT_ENDPOINT });
	});

	test("the shipped config.json resolves to the default endpoint", async () => {
		const loaded = await loadConfig(shippedConfigPath);

		expect(loaded.missing).toBe(false);
		expect(loaded.config).toEqual({ endpoint: DEFAULT_ENDPOINT });
	});

	test("malformed JSON throws", async () => {
		await expect(withConfigFile("{ not json", path => loadConfig(path))).rejects.toThrow();
	});

	test("an invalid endpoint value throws at load time", async () => {
		await expect(withConfigFile(JSON.stringify({ endpoint: 8787 }), path => loadConfig(path))).rejects.toThrow(
			/endpoint/,
		);
	});
});
