/**
 * Config schema for the anchored-standard extension.
 *
 * Invalid values fail at load time (the extension loader surfaces the error);
 * a missing config.json falls back to the shipped defaults with a one-time
 * Reads go through Bun's file API — the omp runtime is bun, and the
 * toolkit's tsconfig carries no node types.
 */

// Minimal Bun surface used here; the toolkit tsconfig carries no bun types.
declare const Bun: {
	file(path: string): { exists(): Promise<boolean>; text(): Promise<string> };
};

export interface AnchoredConfig {
	/** Whether the extension does anything. The switch. */
	enabled: boolean;
	/** Promotion signal set, mapped to dsh's event names. */
	promoteEvents: readonly string[];
	/** First-request output cap. */
	bootstrapMaxTokens: number;
	/** System prompt used during bootstrap (and always for append/none). */
	personaText: string;
	/**
	 * How the full omp prompt returns after promotion:
	 *  - "append": persona stays the whole-session system prompt; the captured
	 *    omp prompt is appended as a developer message (system prefix never
	 *    changes).
	 *  - "system-block": promotion restores the original omp system blocks.
	 *  - "none": persona for the whole session (dsh-literal).
	 */
	restoreMode: "append" | "system-block" | "none";
	/** Platform shells accepted as the single bootstrap shell. */
	shellTools: readonly string[];
	/** Tools always kept beside the shell during bootstrap. */
	commonTools: readonly string[];
}

export const DEFAULT_CONFIG = Object.freeze({
	enabled: true,
	promoteOn: "either",
	bootstrapMaxTokens: 1024,
	personaText: "You are a helpful software engineer assistant.",
	restoreMode: "append",
	shellTools: ["bash", "pwsh"],
	commonTools: ["read"],
} as const);

export const PROMOTE_EVENTS = Object.freeze({
	"tool-call": Object.freeze(["tool/call"]),
	"assistant-message": Object.freeze(["assistant/message"]),
	either: Object.freeze(["tool/call", "assistant/message"]),
} as const);

export const RESTORE_MODES = Object.freeze(["append", "system-block", "none"] as const);

export function stringList(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== "string" || item.length === 0)) {
		throw new TypeError(`anchored-standard: ${field} must be a non-empty array of non-empty strings`);
	}
	return [...new Set(value)];
}

export function parsePromoteOn(value: unknown): readonly string[] {
	if (value === undefined) return PROMOTE_EVENTS.either;
	const events = PROMOTE_EVENTS[value as keyof typeof PROMOTE_EVENTS];
	if (!events) {
		throw new TypeError(
			`anchored-standard: promoteOn must be one of "tool-call", "assistant-message", "either"; got ${JSON.stringify(value)}`,
		);
	}
	return events;
}

export function positiveInt(value: unknown, field: string, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw new TypeError(`anchored-standard: ${field} must be a positive safe integer`);
	}
	return value as number;
}

export function parseRestoreMode(value: unknown): AnchoredConfig["restoreMode"] {
	if (value === undefined) return DEFAULT_CONFIG.restoreMode;
	if (typeof value !== "string" || !(RESTORE_MODES as readonly string[]).includes(value)) {
		throw new TypeError(
			`anchored-standard: restoreMode must be one of ${RESTORE_MODES.join(", ")}; got ${JSON.stringify(value)}`,
		);
	}
	return value as AnchoredConfig["restoreMode"];
}

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
		promoteEvents: parsePromoteOn(record.promoteOn),
		bootstrapMaxTokens: positiveInt(record.bootstrapMaxTokens, "bootstrapMaxTokens", DEFAULT_CONFIG.bootstrapMaxTokens),
		personaText: parsePersonaText(record.personaText),
		restoreMode: parseRestoreMode(record.restoreMode),
		shellTools: stringList(record.shellTools ?? DEFAULT_CONFIG.shellTools, "shellTools"),
		commonTools: stringList(record.commonTools ?? DEFAULT_CONFIG.commonTools, "commonTools"),
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
		return { config: { ...DEFAULT_CONFIG, promoteEvents: PROMOTE_EVENTS.either }, missing: true };
	}
	return { config: validateConfig(JSON.parse(await file.text())), missing: false };
}
