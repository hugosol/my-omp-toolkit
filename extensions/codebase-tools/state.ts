/**
 * Pure state logic for codeBaseTools.
 *
 * The extension stores `{ on, initInjected }` in one non-LLM session entry
 * (`appendEntry`). This module owns parsing and the injection decision so both
 * can be unit tested without the omp runtime.
 */

export const STATE_CUSTOM_TYPE = "codebase-tools:state";
export const INIT_MESSAGE_TYPE = "codebase-tools:init";
export const REMINDER_MESSAGE_TYPE = "codebase-tools:reminder";

/** One-line UI marker shown while the toggle is on; `setWidget(..., undefined)` clears it. */
export const MARKER_LINE = "◈ codeBaseTools";

export interface CodebaseToolsState {
	/** Whether injection is currently on for this session. */
	on: boolean;
	/** Whether the full init prompt has already been injected this session. */
	initInjected: boolean;
}

export type InjectionKind = "init" | "reminder";

export const DEFAULT_STATE: CodebaseToolsState = Object.freeze({ on: false, initInjected: false });

/** Parse one persisted state payload; missing or non-boolean fields fall back to the default. */
export function parseState(data: unknown): CodebaseToolsState {
	const record = (typeof data === "object" && data !== null ? data : {}) as {
		on?: unknown;
		initInjected?: unknown;
	};
	return {
		on: typeof record.on === "boolean" ? record.on : DEFAULT_STATE.on,
		initInjected: typeof record.initInjected === "boolean" ? record.initInjected : DEFAULT_STATE.initInjected,
	};
}

/**
 * Reconstruct session state from the current branch. The last
 * `codebase-tools:state` entry wins; no entry means the default off state.
 */
export function readState(entries: readonly unknown[]): CodebaseToolsState {
	let found: CodebaseToolsState | undefined;
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const candidate = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (candidate.type !== "custom" || candidate.customType !== STATE_CUSTOM_TYPE) continue;
		found = parseState(candidate.data);
	}
	return found ?? { ...DEFAULT_STATE };
}

/** Toggle injection; init stays injected because off never erases history. */
export function toggled(state: CodebaseToolsState): CodebaseToolsState {
	return { on: !state.on, initInjected: state.initInjected };
}

export function markedInit(): CodebaseToolsState {
	return { on: true, initInjected: true };
}

/** Which prompt, if any, this session should inject on the current turn. */
export function injectionFor(state: CodebaseToolsState): InjectionKind | null {
	if (!state.on) return null;
	return state.initInjected ? "reminder" : "init";
}
