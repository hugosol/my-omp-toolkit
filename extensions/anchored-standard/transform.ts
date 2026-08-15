/**
 * Pure wire-level transforms for the bootstrap phase. No extension runtime
 * access: everything here is a function of (payload, config) and is unit
 * tested in isolation.
 */

import type { AnchoredConfig } from "./config";

/**
 * Extract a tool name from either wire shape:
 * `{name}` (anthropic/responses) or `{type:"function", function:{name}}`
 * (chat completions).
 */
export function toolNameOf(tool: unknown): string | undefined {
	if (!tool || typeof tool !== "object") return undefined;
	const record = tool as Record<string, unknown>;
	const direct = record.name;
	if (typeof direct === "string" && direct.length > 0) return direct;
	const nested = record.function;
	if (nested && typeof nested === "object") {
		const inner = (nested as Record<string, unknown>).name;
		if (typeof inner === "string" && inner.length > 0) return inner;
	}
	return undefined;
}

const MAX_TOKEN_FIELDS = ["max_tokens", "max_output_tokens", "max_completion_tokens"] as const;

export interface CapResult {
	payload: unknown;
	/** True when no recognized max-token field exists (caller should warn). */
	unrecognized: boolean;
}

/**
 * Wire-level output cap: rewrite whichever max-token field the provider uses,
 * never raising an existing lower value. Unknown shapes are left untouched.
 */
export function capMaxTokens(payload: unknown, cap: number): CapResult {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return { payload, unrecognized: false };
	}
	const record = payload as Record<string, unknown>;
	for (const field of MAX_TOKEN_FIELDS) {
		const current = record[field];
		if (typeof current === "number" && Number.isFinite(current)) {
			const next = Math.min(current, cap);
			if (next === current) return { payload, unrecognized: false };
			return { payload: { ...record, [field]: next }, unrecognized: false };
		}
	}
	return { payload, unrecognized: true };
}

export interface NarrowResult {
	payload: unknown;
	/**
	 * Degrade reason when the bootstrap invariant (exactly one shell, every
	 * common tool present) does not hold. The caller exposes the full catalog
	 * and warns once.
	 */
	degraded: { shells: string[]; missing: string[] } | null;
}

/**
 * Wire-level tool narrowing: keep exactly one platform shell plus the common
 * tools. Mirrors the dsh preset: a missing bootstrap shell or common tool
 * degrades to the full catalog instead of failing requests.
 */
export function narrowTools(payload: unknown, config: AnchoredConfig): NarrowResult {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		return { payload, degraded: null };
	}
	const record = payload as Record<string, unknown>;
	if (!Array.isArray(record.tools)) {
		return { payload, degraded: null }; // no tools array → nothing to narrow
	}
	const tools = record.tools as unknown[];
	const available = new Set(tools.map(toolNameOf).filter((name): name is string => name !== undefined));
	const selectedShells = config.shellTools.filter(toolName => available.has(toolName));
	const missingCommon = config.commonTools.filter(toolName => !available.has(toolName));
	if (selectedShells.length !== 1 || missingCommon.length > 0) {
		return { payload, degraded: { shells: selectedShells, missing: missingCommon } };
	}
	const keep = new Set([...selectedShells, ...config.commonTools]);
	const kept = tools.filter(tool => {
		const toolName = toolNameOf(tool);
		return toolName !== undefined && keep.has(toolName);
	});
	if (kept.length === tools.length) return { payload, degraded: null };
	return { payload: { ...record, tools: kept }, degraded: null };
}
