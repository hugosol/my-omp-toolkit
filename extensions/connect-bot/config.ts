/**
 * Endpoint config for the connect-bot extension.
 *
 * The extension directory ships one machine-global `config.json` with a single
 * key — `{ "endpoint": "http://omp-bot.local:8787" }`. Every session on the
 * machine reads this same file, so moving omp-bot means editing this one file
 * and there is no per-session endpoint. Unknown keys are ignored.
 *
 * A missing file falls back to the shipped default with a one-time warning;
 * malformed content throws so the extension loader surfaces it at mount time.
 *
 * Reads go through Bun's file API — the omp runtime is bun, and the toolkit's
 * tsconfig carries no node types.
 */

// Minimal Bun surface used here; the toolkit tsconfig carries no bun types.
declare const Bun: {
	file(path: string): { exists(): Promise<boolean>; text(): Promise<string> };
};

export interface ConnectBotConfig {
	/** Base URL of the omp-bot panel. The event path is a protocol constant, not config. */
	endpoint: string;
}

export const DEFAULT_CONFIG = Object.freeze({
	endpoint: "http://omp-bot.local:8787",
} as const);

/** Receives the missing-file warning. Injected so the caller owns the log sink. */
export type ConfigWarning = (message: string) => void;

/** Reported once per mount when config.json is absent next to index.ts. */
export const MISSING_CONFIG_WARNING = `connect-bot: config.json not found next to index.ts; using the default endpoint ${DEFAULT_CONFIG.endpoint}`;

export function parseEndpoint(value: unknown): string {
	if (value === undefined) return DEFAULT_CONFIG.endpoint;
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError("connect-bot: endpoint must be a non-empty string");
	}
	return value;
}

export function validateConfig(parsed: unknown): ConnectBotConfig {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new TypeError("connect-bot: config.json must contain a JSON object");
	}
	const endpoint = "endpoint" in parsed ? parsed.endpoint : undefined;
	return { endpoint: parseEndpoint(endpoint) };
}

export interface LoadedConfig {
	config: ConnectBotConfig;
	/** True when config.json was absent and the shipped default was used. */
	missing: boolean;
}

/**
 * Load and validate the endpoint config. A missing file falls back to the
 * default, reporting the fallback through `onWarning`; malformed content throws
 * so the extension loader surfaces it at mount time.
 */
export async function loadConfig(configPath: string, onWarning?: ConfigWarning): Promise<LoadedConfig> {
	const file = Bun.file(configPath);
	if (!(await file.exists())) {
		onWarning?.(MISSING_CONFIG_WARNING);
		return { config: { ...DEFAULT_CONFIG }, missing: true };
	}
	return { config: validateConfig(JSON.parse(await file.text())), missing: false };
}
