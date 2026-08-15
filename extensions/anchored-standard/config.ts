/**
 * Config schema for the anchored-standard extension.
 *
 * Minimal surface: `enabled` is the only switch; `personaText` overrides the
 * whole-session persona. Unknown keys — including the retired bootstrap knobs
 * (promoteOn/bootstrapMaxTokens/shellTools/commonTools/restoreMode) — are
 * silently ignored, so config files written for older versions keep loading.
 * Invalid values fail at load time (the extension loader surfaces the error);
 * a missing config.json falls back to the shipped defaults.
 *
 * Reads go through Bun's file API — the omp runtime is bun, and the toolkit's
 * tsconfig carries no node types.
 */

// Minimal Bun surface used here; the toolkit tsconfig carries no bun types.
declare const Bun: {
	file(path: string): { exists(): Promise<boolean>; text(): Promise<string> };
};

export interface AnchoredConfig {
	/** Whether the extension does anything. The switch. */
	enabled: boolean;
	/** System prompt used for the whole main-session. */
	personaText: string;
}

export const DEFAULT_CONFIG = Object.freeze({
	enabled: true,
	personaText: "You are a helpful software engineer assistant.",
} as const);

export function parseEnabled(value: unknown): boolean {
	if (value === undefined) return DEFAULT_CONFIG.enabled;
	if (typeof value !== "boolean") throw new TypeError("anchored-standard: enabled must be a boolean");
	return value;
}

export function parsePersonaText(value: unknown): string {
	const resolved = value === undefined ? DEFAULT_CONFIG.personaText : value;
	if (typeof resolved !== "string" || resolved.length === 0) {
		throw new TypeError("anchored-standard: personaText must be a non-empty string");
	}
	return resolved;
}

export function validateConfig(parsed: unknown): AnchoredConfig {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new TypeError("anchored-standard: config.json must contain a JSON object");
	}
	const record = parsed as Record<string, unknown>;
	return {
		enabled: parseEnabled(record.enabled),
		personaText: parsePersonaText(record.personaText),
	};
}

export interface LoadedConfig {
	config: AnchoredConfig;
	/** True when config.json was absent and defaults were used. */
	missing: boolean;
}

/**
 * Load and validate config.json. A missing file falls back to defaults;
 * malformed content throws so the extension loader surfaces it at mount time.
 */
export async function loadConfig(configPath: string): Promise<LoadedConfig> {
	const file = Bun.file(configPath);
	if (!(await file.exists())) {
		return { config: { ...DEFAULT_CONFIG }, missing: true };
	}
	return { config: validateConfig(JSON.parse(await file.text())), missing: false };
}
