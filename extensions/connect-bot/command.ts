/**
 * `/connect-bot` argument parsing and the session gate.
 *
 * Pure: no network, no UI, no state. The gate is consulted before the argument
 * is parsed — "no UI" refuses the command outright, whatever the argument says.
 */

/** What `/connect-bot <args>` asks for. */
export type CommandKind = "arm" | "offline" | "unknown";

export interface ParsedCommand {
	kind: CommandKind;
	/** Normalized (`trim().toLowerCase()`) argument, echoed back by the usage hint. */
	argument: string;
}

/**
 * An empty argument arms — idempotently, never a toggle; `offline` is the only
 * subcommand; anything else is unknown and must not change the current state.
 */
export function parseCommand(args: string): ParsedCommand {
	const argument = args.trim().toLowerCase();
	if (argument === "") return { kind: "arm", argument };
	if (argument === "offline") return { kind: "offline", argument };
	return { kind: "unknown", argument };
}

/** Refusal written to stderr in no-UI modes (`--mode rpc --no-ui`, print/json). */
export const NO_UI_REFUSAL = "当前模式无 UI，不支持接入面板";

/** The one session/UI gate: only a main session with a UI may run the command. */
export type CommandGate =
	| { allowed: true }
	/** Subagents never register on the panel; the refusal is deliberately silent. */
	| { allowed: false; reason: "subagent" }
	/** No UI at all: refuse with the fixed stderr message, no state change, no request. */
	| { allowed: false; reason: "no-ui"; message: string };

export interface CommandGateInput {
	agent: { kind: string };
	hasUI: boolean;
}

/** Subagents and no-UI modes are refused before anything else happens. */
export function commandGate(ctx: CommandGateInput): CommandGate {
	if (ctx.agent.kind !== "main") return { allowed: false, reason: "subagent" };
	if (!ctx.hasUI) return { allowed: false, reason: "no-ui", message: NO_UI_REFUSAL };
	return { allowed: true };
}

/** Error plus usage hint for an unrecognized argument; the command must not change state. */
export function unknownArgumentHint(argument: string): string {
	return `未知参数「${argument}」；用法：/connect-bot（接入 omp-bot 面板）或 /connect-bot offline（断开）。`;
}
